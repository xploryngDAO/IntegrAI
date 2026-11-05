import type {
  AdapterDependencies,
  HydratedInboundMessage,
  ILogger,
  MarketplaceAccountRecord,
} from '@sac/shared';
import type { MeliClient } from '../client/MeliClient';
import {
  asString,
  errorMessage,
  isQuestionAnswered,
  normalizeAttachments,
  parseDate,
  questionItemSnapshot,
  truncateText,
} from '../mappers';
import type { MeliItem, MeliQuestion } from '../types';

const QUESTION_ITEM_ATTRIBUTES = 'id,title,thumbnail,price,permalink,seller_id';

/**
 * Hydrates a `questions` push:
 * `GET /questions/{id}` + `GET /items/{item_id}` -> PRE_SALE message.
 *
 * An already `ANSWERED` question is surfaced as an EXTERNAL_SELLER_PANEL message
 * with `statusHint = WAITING_BUYER` so the core can settle the SLA instead of
 * asking an agent to answer a question that was already answered.
 */
export class QuestionsHydrator {
  private readonly logger: ILogger;

  constructor(
    private readonly deps: AdapterDependencies,
    private readonly client: MeliClient,
  ) {
    this.logger = deps.logger.child({ adapter: 'mercadolivre', component: 'questions' });
  }

  async hydrate(
    account: MarketplaceAccountRecord,
    questionId: string,
  ): Promise<HydratedInboundMessage[]> {
    const question = await this.client.get<MeliQuestion>(
      account.id,
      `/questions/${questionId}`,
    );
    const resolvedQuestionId = asString(question.id) ?? questionId;
    const itemId = asString(question.item_id);
    const warnings: string[] = [];

    let item: MeliItem | null = null;
    if (itemId) {
      try {
        item = await this.client.get<MeliItem>(account.id, `/items/${itemId}`, {
          attributes: QUESTION_ITEM_ATTRIBUTES,
        });
      } catch (error) {
        warnings.push('MELI_ITEM_SNAPSHOT_UNAVAILABLE');
        this.logger.warn('meli.questions.item_snapshot_failed', {
          accountId: account.id,
          questionId: resolvedQuestionId,
          itemId,
          error: errorMessage(error),
        });
      }
    }

    const answered = isQuestionAnswered(question);
    const createdAt = parseDate(question.date_created) ?? this.deps.clock.now();
    const itemSnapshot = questionItemSnapshot(item, itemId);
    const questionStatus = asString(question.status);

    const message: HydratedInboundMessage = {
      accountId: account.id,
      marketplace: 'MERCADO_LIVRE',
      externalReferenceId: resolvedQuestionId,
      ticketType: 'PRE_SALE',
      externalOrderId: null,
      packId: null,
      claimId: null,
      conversationId: null,
      returnSn: null,
      externalMessageId: `q:${resolvedQuestionId}`,
      direction: answered ? 'EXTERNAL_SELLER_PANEL' : 'INBOUND_BUYER',
      channelRouteUsed: 'MELI_QUESTIONS_API',
      messageType: answered ? 'question_answer' : 'question',
      bodyCleanText: truncateText(asString(question.text) ?? ''),
      contentPayload: {
        question_id: resolvedQuestionId,
        item_id: itemId,
        question_status: questionStatus,
      },
      marketplaceCreatedAt: createdAt,
      deliveryStatus: 'DELIVERED',
      buyer: {
        externalId: asString(question.from?.id),
        displayName: null,
        anonymizedEmail: null,
      },
      order: null,
      attachments: normalizeAttachments(question.attachments),
      channelMetadata: {
        question_id: resolvedQuestionId,
        item_id: itemId,
        item_snapshot: itemSnapshot,
        question_status: questionStatus,
        answered,
      },
      priority: 'MEDIUM',
      statusHint: answered ? 'WAITING_BUYER' : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
    };

    this.logger.info('meli.questions.hydrated', {
      accountId: account.id,
      questionId: resolvedQuestionId,
      itemId,
      answered,
    });
    return [message];
  }
}
