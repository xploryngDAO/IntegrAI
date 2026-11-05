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
import { asRecord } from '../mappers';
import type { ShopeeChat } from './ShopeeChat';

/**
 * Shopee post-sale retention operations (N2 queue): returns confirmation,
 * return disputes and buyer-cancellation acceptance.
 *
 * Every method returns the real `request_id` so the cockpit timeline can show a
 * traceable marketplace proof; Shopee business errors surface as
 * `MarketplaceApiError` (never a silent `ok: true`).
 */

export interface ShopeeReturnActionResult {
  requestId: string | null;
  data: Record<string, unknown>;
}

export interface ShopeeDisputeResult extends ShopeeReturnActionResult {
  imageUrls: string[];
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
   * `POST /api/v2/returns/dispute` - disputes a return after uploading every
   * evidence image through `v2.sellerchat.upload_image`.
   */
  async disputeReturn(input: {
    accountId: string;
    returnSn: string;
    disputeReason: number | null;
    disputeTextReason: string | null;
    attachments: OutboundAttachmentInput[];
  }): Promise<ShopeeDisputeResult> {
    const account = await loadShopeeAccount(this.deps, input.accountId);
    const returnSn = this.requireReturnSn(input.returnSn);

    const imageUrls: string[] = [];
    for (const attachment of input.attachments) {
      const uploaded = await this.uploadDisputeImage(account, attachment);
      imageUrls.push(uploaded);
    }

    const body: Record<string, unknown> = {
      return_sn: returnSn,
      dispute_reason: input.disputeReason ?? 1,
      dispute_text_reason: input.disputeTextReason ?? 'Disputa aberta pelo SAC',
      image: imageUrls,
    };

    const result = await this.client.request<Record<string, unknown>>({
      accountId: account.id,
      apiPath: SHOPEE_API_PATHS.disputeReturn,
      body,
    });

    this.logger.info('Shopee return disputed', {
      accountId: account.id,
      returnSn,
      requestId: result.requestId,
      imageCount: imageUrls.length,
    });
    return {
      requestId: result.requestId,
      data: asRecord(result.data) ?? {},
      imageUrls,
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

  private async uploadDisputeImage(
    account: MarketplaceAccountRecord,
    attachment: OutboundAttachmentInput,
  ): Promise<string> {
    const uploaded = await this.chat.uploadImage(account, attachment);
    return uploaded.imageUrl;
  }

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
}
