import { z } from 'zod';
import { marketplaceSchema, uuidSchema } from './enums.schema';

/** Marketplaces that support the OAuth redirect flow (Amazon uses credentials). */
export const OAUTH_SLUGS = {
  mercadolivre: 'MERCADO_LIVRE',
  shopee: 'SHOPEE',
} as const;

export const oauthSlugSchema = z.enum(['mercadolivre', 'shopee']);

/** `POST /accounts/oauth/:marketplace/start`. */
export const oauthStartParamsSchema = z.object({
  marketplace: oauthSlugSchema,
});

export const oauthStartBodySchema = z.object({
  displayName: z.string().trim().min(1).max(120),
});

/** `GET /accounts/oauth/:marketplace/callback` - provider params are free-form. */
export const oauthCallbackParamsSchema = z.object({
  marketplace: oauthSlugSchema,
});

/** `POST /accounts/connect` (Amazon LWA refresh token / manual token flows). */
export const connectAccountBodySchema = z
  .object({
    marketplace: marketplaceSchema,
    displayName: z.string().trim().min(1).max(120),
    externalSellerId: z.string().trim().min(1).max(128),
    marketplaceSiteId: z.string().trim().min(1).max(64),
    refreshToken: z.string().min(1).max(2_000).optional(),
    accessToken: z.string().min(1).max(4_000).optional(),
    tokenExpiresAt: z.coerce.date().optional(),
    channelConfig: z.record(z.unknown()).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.marketplace === 'AMAZON' && (value.refreshToken === undefined || value.refreshToken.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['refreshToken'],
        message: 'Amazon self-authorized connections require the LWA refresh token',
      });
    }
  });

export const accountIdParamsSchema = z.object({
  id: uuidSchema,
});

export type ConnectAccountBody = z.infer<typeof connectAccountBodySchema>;
export type OAuthStartBody = z.infer<typeof oauthStartBodySchema>;
