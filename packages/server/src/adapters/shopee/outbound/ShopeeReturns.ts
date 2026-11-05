import {
  ValidationError,
  type AdapterDependencies,
  type ILogger,
  type MarketplaceAccountRecord,
  type OutboundAttachmentInput,
} from '@sac/shared';
import { ShopeeClient } from '../client/ShopeeClient';
import { loadShopeeAccount } from '../client/ShopeeAuth';
import { SHOPEE_API_PATHS } from '../types';
import { asRecord, pickArray, pickNumber, pickString } from '../mappers';
import type { ShopeeChat } from './ShopeeChat';

/**
 * Shopee post-sale retention operations (N2 queue): returns confirmation,
 * return disputes and buyer-cancellation acceptance.
 *
 * Every method returns the real `request_id` so the cockpit timeline can show a
 * traceable marketplace proof; Shopee business errors surface as
 * `MarketplaceApiError` (never a silent `ok: true`).
 */

/** One evidence module of the official `returns/dispute` payload. */
export interface ShopeeDisputeImageModule {
  module_index: number;
  requirement: string;
  image_url: string[];
}

interface DisputeEvidenceModule {
  moduleIndex: number;
  requirement: string;
}

export interface ShopeeReturnActionResult {
  requestId: string | null;
  data: Record<string, unknown>;
}

export interface ShopeeDisputeResult extends ShopeeReturnActionResult {
  imageUrls: string[];
  /** Official `image_list` actually sent (empty when the reason needs no proof). */
  imageModules: ShopeeDisputeImageModule[];
}

export interface ShopeeDisputeInput {
  accountId: string;
  returnSn: string;
  /** Required by the official API (seller contact e-mail). */
  email: string | null;
  /** Official `dispute_reason_id` (from v2.returns.get_return_dispute_reason). */
  disputeReasonId: number | null;
  disputeTextReason: string | null;
  /**
   * Pre-built official `image_list` (when the caller already resolved the
   * evidence modules). When absent the adapter fetches the modules from Shopee.
   */
  imageList: ShopeeDisputeImageModule[] | null;
  attachments: OutboundAttachmentInput[];
}

export class ShopeeReturns {
  private readonly deps: AdapterDependencies;
  private readonly client: ShopeeClient;
  private readonly chat: ShopeeChat;
  private readonly logger: ILogger;

  constructor(deps: AdapterDependencies, client: ShopeeClient, chat: ShopeeChat) {
    this.deps = deps;
    this.client = client;
    this.chat = chat;
    this.logger = deps.logger.child({ component: 'shopee.returns' });
  }

  /** `POST /api/v2/returns/confirm` - confirms a buyer return request. */
  async confirmReturn(input: {
    accountId: string;
    returnSn: string;
  }): Promise<ShopeeReturnActionResult> {
    const account = await loadShopeeAccount(this.deps, input.accountId);
    const returnSn = this.requireReturnSn(input.returnSn);

    const result = await this.client.request<Record<string, unknown>>({
      accountId: account.id,
      apiPath: SHOPEE_API_PATHS.confirmReturn,
      body: { return_sn: returnSn },
    });

    this.logger.info('Shopee return confirmed', {
      accountId: account.id,
      returnSn,
      requestId: result.requestId,
    });
    return { requestId: result.requestId, data: asRecord(result.data) ?? {} };
  }

  /**
   * `POST /api/v2/returns/dispute` - official payload:
   * `{ return_sn, email, dispute_reason_id, image_list[], dispute_text_reason }`.
   *
   * The `dispute_reason` field was sunset by Shopee (2024-05-07) and `image` was
   * replaced by the evidence-module `image_list` (2024-12-31); the adapter
   * resolves the modules through `v2.returns.get_return_dispute_reason` and
   * distributes the uploaded evidence accordingly (max 3 per module).
   */
  async disputeReturn(input: ShopeeDisputeInput): Promise<ShopeeDisputeResult> {
    const account = await loadShopeeAccount(this.deps, input.accountId);
    const returnSn = this.requireReturnSn(input.returnSn);
    const email = this.requireEmail(input.email);
    const disputeReasonId = input.disputeReasonId;
    if (disputeReasonId === null || !Number.isFinite(disputeReasonId)) {
      throw new ValidationError('SHOPEE_DISPUTE_REASON_ID_MISSING', {
        returnSn,
        hint: 'Use v2.returns.get_return_dispute_reason e envie dispute_reason_id.',
      });
    }

    const imageModules = await this.resolveEvidence(input, account, returnSn, disputeReasonId);
    const imageUrls = imageModules.flatMap((module) => module.image_url);

    const body: Record<string, unknown> = {
      return_sn: returnSn,
      email,
      dispute_reason_id: disputeReasonId,
      image_list: imageModules,
    };
    if (input.disputeTextReason && input.disputeTextReason.trim().length > 0) {
      body['dispute_text_reason'] = input.disputeTextReason.trim();
    }

    const result = await this.client.request<Record<string, unknown>>({
      accountId: account.id,
      apiPath: SHOPEE_API_PATHS.disputeReturn,
      body,
    });

    this.logger.info('Shopee return disputed', {
      accountId: account.id,
      returnSn,
      requestId: result.requestId,
      disputeReasonId,
      imageCount: imageUrls.length,
      moduleCount: imageModules.length,
    });
    return {
      requestId: result.requestId,
      data: asRecord(result.data) ?? {},
      imageUrls,
      imageModules,
    };
  }

  /** `POST /api/v2/order/handle_buyer_cancellation` with `operation: 'ACCEPT'`. */
  async acceptCancellation(input: {
    accountId: string;
    orderSn: string;
  }): Promise<ShopeeReturnActionResult> {
    const account = await loadShopeeAccount(this.deps, input.accountId);
    const orderSn = this.requireOrderSn(input.orderSn);

    const result = await this.client.request<Record<string, unknown>>({
      accountId: account.id,
      apiPath: SHOPEE_API_PATHS.handleBuyerCancellation,
      body: { order_sn: orderSn, operation: 'ACCEPT' },
    });

    this.logger.info('Shopee buyer cancellation accepted', {
      accountId: account.id,
      orderSn,
      requestId: result.requestId,
    });
    return { requestId: result.requestId, data: asRecord(result.data) ?? {} };
  }

  /* ====================================================================== */
  /* Evidence modules                                                       */
  /* ====================================================================== */

  private async resolveEvidence(
    input: ShopeeDisputeInput,
    account: MarketplaceAccountRecord,
    returnSn: string,
    disputeReasonId: number,
  ): Promise<ShopeeDisputeImageModule[]> {
    if (input.imageList && input.imageList.length > 0) {
      return input.imageList;
    }

    const modules = await this.fetchEvidenceModules(account, returnSn, disputeReasonId);

    const uploadedUrls: string[] = [];
    for (const attachment of input.attachments) {
      const uploaded = await this.chat.uploadImage(account, attachment);
      uploadedUrls.push(uploaded.imageUrl);
    }
    if (uploadedUrls.length === 0 || modules.length === 0) {
      // Some dispute reasons require no evidence module at all; the API decides.
      return [];
    }

    // Official constraint: at most 3 images per module. Distribute sequentially.
    const imageModules: ShopeeDisputeImageModule[] = [];
    let cursor = 0;
    for (const module of modules) {
      if (cursor >= uploadedUrls.length) break;
      const take = Math.min(3, Math.max(1, Math.ceil(uploadedUrls.length / modules.length)));
      const slice = uploadedUrls.slice(cursor, cursor + take);
      cursor += slice.length;
      imageModules.push({
        module_index: module.moduleIndex,
        requirement: module.requirement,
        image_url: slice,
      });
    }
    if (cursor < uploadedUrls.length) {
      this.logger.warn('Shopee dispute: extra evidence images beyond module capacity were dropped', {
        accountId: account.id,
        returnSn,
        dropped: uploadedUrls.length - cursor,
      });
    }
    return imageModules;
  }

  private async fetchEvidenceModules(
    account: MarketplaceAccountRecord,
    returnSn: string,
    disputeReasonId: number,
  ): Promise<DisputeEvidenceModule[]> {
    const result = await this.client.request<Record<string, unknown>>({
      accountId: account.id,
      apiPath: SHOPEE_API_PATHS.getReturnDisputeReason,
      method: 'GET',
      extraQuery: { return_sn: returnSn },
    });
    const data = asRecord(result.data) ?? {};
    const reasons = pickArray(data, ['dispute_reason_list'])
      .map(asRecord)
      .filter((entry): entry is Record<string, unknown> => entry !== null);

    const match = reasons.find((entry) => {
      const reason = pickString(entry, ['dispute_reason']);
      return reason !== null && Number(reason) === disputeReasonId;
    });
    if (!match) {
      throw new ValidationError('SHOPEE_DISPUTE_REASON_INVALID', {
        returnSn,
        disputeReasonId,
        availableReasons: reasons
          .map((entry) => pickString(entry, ['dispute_reason']))
          .filter((value): value is string => value !== null),
      });
    }

    const modules = pickArray(match, ['evidence_module_list'])
      .map(asRecord)
      .filter((module): module is Record<string, unknown> => module !== null)
      .map((module) => ({
        moduleIndex: pickNumber(module, ['module_index']) ?? 0,
        requirement: pickString(module, ['requirement']) ?? 'Evidência da devolução',
      }))
      .filter((module) => module.moduleIndex > 0);

    return modules;
  }

  /* ====================================================================== */
  /* Guards                                                                 */
  /* ====================================================================== */

  private requireReturnSn(returnSn: string | null | undefined): string {
    const value = typeof returnSn === 'string' ? returnSn.trim() : '';
    if (value.length === 0) {
      throw new ValidationError('SHOPEE_RETURN_SN_MISSING', { marketplace: 'SHOPEE' });
    }
    return value;
  }

  private requireOrderSn(orderSn: string | null | undefined): string {
    const value = typeof orderSn === 'string' ? orderSn.trim() : '';
    if (value.length === 0) {
      throw new ValidationError('SHOPEE_ORDER_SN_MISSING', { marketplace: 'SHOPEE' });
    }
    return value;
  }

  private requireEmail(email: string | null | undefined): string {
    const value = typeof email === 'string' ? email.trim() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      throw new ValidationError('SHOPEE_DISPUTE_EMAIL_MISSING', {
        hint: 'O campo email é obrigatório no v2.returns.dispute.',
      });
    }
    return value;
  }
}
