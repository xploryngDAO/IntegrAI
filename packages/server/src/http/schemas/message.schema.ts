import { z } from 'zod';
import { channelActionKindSchema, uuidSchema } from './enums.schema';
import { isSafeAttachmentKey } from '../utils/storage-key';

/** Storage key accepted as an attachment reference (created by POST /files/upload). */
export const attachmentKeySchema = z
  .string()
  .min(1)
  .max(512)
  .refine((key) => isSafeAttachmentKey(key), { message: 'Invalid attachment storage key' });

const recipientSchema = z.enum(['BUYER', 'MEDIATOR']);
const shopeeMessageTypeSchema = z.enum(['text', 'image', 'order', 'item']);

/**
 * `POST /tickets/:id/messages`.
 * The route and policy are recomputed server-side; the body only carries intent.
 */
export const sendMessageBodySchema = z
  .object({
    bodyText: z.string().max(20_000).default(''),
    bodyHtml: z.string().max(100_000).optional(),
    subject: z.string().max(300).optional(),
    recipient: recipientSchema.optional(),
    forceImportant: z.boolean().optional(),
    closeWithoutResponse: z.boolean().optional(),
    attachmentS3Keys: z.array(attachmentKeySchema).max(10).optional(),
    meliActionGuideReasonId: z.string().min(1).max(64).optional(),
    shopeeMessageType: shopeeMessageTypeSchema.optional(),
    shopeeOrderCardOrderSn: z.string().min(1).max(64).optional(),
    shopeeItemCardItemId: z.coerce.number().int().positive().optional(),
  })
  .superRefine((value, ctx) => {
    const hasText = value.bodyText.trim().length > 0;
    const hasAttachments = (value.attachmentS3Keys?.length ?? 0) > 0;
    const hasCard =
      value.shopeeMessageType === 'image' ||
      value.shopeeMessageType === 'order' ||
      value.shopeeMessageType === 'item';
    if (!hasText && !hasAttachments && !hasCard && value.closeWithoutResponse !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bodyText'],
        message: 'bodyText is required unless the message carries attachments, a Shopee card or closes the ticket',
      });
    }
  });

/** `POST /tickets/:id/policy-check` - runs on every keystroke, must stay cheap. */
export const policyCheckBodySchema = z.object({
  bodyText: z.string().max(20_000).default(''),
  bodyHtml: z.string().max(100_000).optional(),
  subject: z.string().max(300).optional(),
  recipient: recipientSchema.optional(),
  attachmentCount: z.coerce.number().int().min(0).max(10).optional(),
  forceImportant: z.boolean().optional(),
});

/** `GET /tickets/:id/route?recipient=`. */
export const routePreviewQuerySchema = z.object({
  recipient: recipientSchema.optional(),
});

/** `GET /tickets/:id/messages` and action routes share the ticket id param. */
export const ticketParamsSchema = z.object({
  id: uuidSchema,
});

/** `POST /tickets/:id/actions`. */
export const executeActionBodySchema = z.object({
  kind: channelActionKindSchema,
  bodyText: z.string().max(20_000).optional(),
  attachmentS3Keys: z.array(attachmentKeySchema).max(10).optional(),
  lastReadMessageId: z.string().min(1).max(256).nullable().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export const idempotencyKeyHeaderSchema = z.string().uuid();

export type SendMessageBody = z.infer<typeof sendMessageBodySchema>;
export type PolicyCheckBody = z.infer<typeof policyCheckBodySchema>;
export type RoutePreviewQuery = z.infer<typeof routePreviewQuerySchema>;
export type ExecuteActionBody = z.infer<typeof executeActionBodySchema>;
