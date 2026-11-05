import { z } from 'zod';

/**
 * Environment contract for the SAC Hub server.
 *
 * Every value is coerced from the raw `process.env` string form exactly once,
 * here, so the rest of the codebase only ever sees typed values. Unknown
 * variables are stripped (zod default) which keeps platform-injected noise
 * (CI, PATH, AWS_*, ...) out of the parsed result.
 */

/** Development fallback only - production overrides ENCRYPTION_MASTER_KEY. */
const DEV_MASTER_KEY = 'zJ8kQ2mWv7bT1yN5cR9pLx4hF6dA0gU3sE2iO8qK5wY=';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);

function boolFromEnv(fallback: boolean): z.ZodType<boolean, z.ZodTypeDef, unknown> {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    if (TRUTHY.has(normalized)) return true;
    if (FALSY.has(normalized)) return false;
    return value;
  }, z.boolean());
}

function stringFromEnv(fallback: string): z.ZodType<string, z.ZodTypeDef, unknown> {
  return z.preprocess((value) => {
    if (value === undefined || value === null) return fallback;
    return String(value).trim();
  }, z.string());
}

function requiredString(field: string): z.ZodType<string, z.ZodTypeDef, unknown> {
  return z.preprocess(
    (value) => (value === undefined || value === null ? undefined : String(value).trim()),
    z.string().min(1, `${field} must not be empty`),
  );
}

function optionalString(): z.ZodType<string | undefined, z.ZodTypeDef, unknown> {
  return z.preprocess((value) => {
    if (value === undefined || value === null) return undefined;
    const text = String(value).trim();
    return text.length > 0 ? text : undefined;
  }, z.string().min(1).optional());
}

function numberFromEnv(fallback: number): z.ZodType<number, z.ZodTypeDef, unknown> {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'number') return value;
    const parsed = Number(String(value).trim());
    return Number.isFinite(parsed) ? parsed : value;
  }, z.number().finite());
}

function intFromEnv(fallback: number, min?: number, max?: number): z.ZodType<number, z.ZodTypeDef, unknown> {
  let schema = z.number().int();
  if (min !== undefined) schema = schema.min(min);
  if (max !== undefined) schema = schema.max(max);
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'number') return value;
    const parsed = Number(String(value).trim());
    return Number.isFinite(parsed) ? parsed : value;
  }, schema);
}

function csvFromEnv(fallback: string[] = []): z.ZodType<string[], z.ZodTypeDef, unknown> {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return fallback;
    if (Array.isArray(value)) return value;
    return String(value)
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }, z.array(z.string()));
}

/** base64 key that MUST decode to exactly 32 bytes (AES-256). */
function masterKeyFromEnv(fallback: string): z.ZodType<string, z.ZodTypeDef, unknown> {
  return z
    .preprocess((value) => {
      if (value === undefined || value === null || value === '') return fallback;
      return String(value).trim();
    }, z.string().min(1, 'ENCRYPTION_MASTER_KEY is required'))
    .superRefine((value, ctx) => {
      const decoded = Buffer.from(value, 'base64');
      if (decoded.length !== 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `ENCRYPTION_MASTER_KEY must decode to exactly 32 bytes, got ${decoded.length}. ` +
            'Generate one with: openssl rand -base64 32',
        });
      }
    });
}

export const envSchema = z.object({
  /* ------------------------------- runtime -------------------------------- */
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: intFromEnv(4000, 1, 65_535),
  APP_BASE_URL: stringFromEnv('http://localhost:4000'),
  WEB_ORIGIN: stringFromEnv('http://localhost:5173'),
  LOG_LEVEL: optionalString(),

  /* ------------------------------ datastores ------------------------------ */
  DATABASE_URL: requiredString('DATABASE_URL').default(
    'postgresql://sac:sac@localhost:5432/sac_hub?schema=public',
  ),
  REDIS_URL: requiredString('REDIS_URL').default('redis://localhost:6379'),

  /* ---------------------------- object storage ---------------------------- */
  S3_ENDPOINT: optionalString(),
  S3_REGION: stringFromEnv('us-east-1'),
  S3_BUCKET: stringFromEnv('sac-hub-raw'),
  S3_ATTACHMENTS_BUCKET: stringFromEnv('sac-hub-attachments'),
  S3_ACCESS_KEY_ID: stringFromEnv('minioadmin'),
  S3_SECRET_ACCESS_KEY: stringFromEnv('minioadmin'),
  S3_FORCE_PATH_STYLE: boolFromEnv(true),
  S3_SSE: optionalString(),

  /* ------------------------------- security ------------------------------- */
  ENCRYPTION_MASTER_KEY: masterKeyFromEnv(DEV_MASTER_KEY),
  ENCRYPTION_KEY_ID: stringFromEnv('local-dev-v1'),
  JWT_SECRET: requiredString('JWT_SECRET').default('dev-only-change-me-please-32-chars-min'),
  JWT_EXPIRES_IN: stringFromEnv('12h'),
  AGENT_PRESENCE_TTL: intFromEnv(120, 10, 86_400),

  /* -------------------------- Amazon SP-API / SES ------------------------- */
  AMAZON_LWA_CLIENT_ID: stringFromEnv(''),
  AMAZON_LWA_CLIENT_SECRET: stringFromEnv(''),
  AMAZON_SPAPI_ENDPOINT: stringFromEnv('https://sellingpartnerapi-na.amazon.com'),
  AMAZON_LWA_TOKEN_URL: stringFromEnv('https://api.amazon.com/auth/o2/token'),
  AMAZON_RDT_ENDPOINT: stringFromEnv(
    'https://sellingpartnerapi-na.amazon.com/tokens/2021-03-01/restrictedDataToken',
  ),
  AMAZON_SPAPI_REGION: stringFromEnv('na'),
  AMAZON_SES_INBOUND_SHARED_SECRET: stringFromEnv(''),
  AMAZON_EMAIL_DOMAIN_ALLOWLIST: csvFromEnv(['amazon.com', 'amazon.com.br']),

  /* ------------------------------ SMTP relay ------------------------------ */
  SMTP_HOST: stringFromEnv('localhost'),
  SMTP_PORT: intFromEnv(1025, 1, 65_535),
  SMTP_SECURE: boolFromEnv(false),
  SMTP_USER: stringFromEnv(''),
  SMTP_PASSWORD: stringFromEnv(''),
  /** Envelope/From address for transactional auth e-mail. */
  SMTP_FROM: stringFromEnv('no-reply@integrai.app'),

  /* ----------------------------- Mercado Livre ---------------------------- */
  MELI_CLIENT_ID: stringFromEnv(''),
  MELI_CLIENT_SECRET: stringFromEnv(''),
  MELI_REDIRECT_URI: stringFromEnv('http://localhost:4000/api/v1/accounts/oauth/mercadolivre/callback'),
  MELI_API_BASE: stringFromEnv('https://api.mercadolibre.com'),
  MELI_REFRESH_INTERVAL_SECONDS: intFromEnv(20_700, 60),
  MELI_WEBHOOK_TOPICS: csvFromEnv([
    'questions',
    'messages',
    'claims',
    'post_purchase',
    'orders',
    'shipments',
  ]),

  /* ------------------------- Shopee Open Platform v2 ---------------------- */
  SHOPEE_PARTNER_ID: intFromEnv(0, 0),
  SHOPEE_PARTNER_KEY: stringFromEnv(''),
  SHOPEE_REDIRECT_URI: stringFromEnv('http://localhost:4000/api/v1/accounts/oauth/shopee/callback'),
  SHOPEE_API_BASE: stringFromEnv('https://partner.shopeemobile.com'),
  SHOPEE_REFRESH_INTERVAL_SECONDS: intFromEnv(12_600, 60),
  SHOPEE_LOST_PUSH_CRON: stringFromEnv('*/5 * * * *'),
  SHOPEE_LOST_PUSH_LOOKBACK_MINUTES: intFromEnv(60, 1, 10_080),
  SHOPEE_WEBHOOK_TOLERANCE_SECONDS: intFromEnv(300, 0, 3_600),

  /* ----------------------- rate limits (token buckets) -------------------- */
  RL_AMAZON_MESSAGING_PER_SECOND: numberFromEnv(1),
  RL_AMAZON_ORDERS_PER_SECOND: numberFromEnv(0.5),
  RL_AMAZON_ORDERS_BURST: intFromEnv(10, 1, 10_000),
  RL_AMAZON_RDT_PER_SECOND: numberFromEnv(1),
  RL_MELI_PER_SECOND: numberFromEnv(10),
  RL_SHOPEE_PER_SECOND: numberFromEnv(5),

  /* ---------------------------- SLA / retention --------------------------- */
  SLA_SCAN_CRON: stringFromEnv('*/1 * * * *'),
  PII_PURGE_CRON: stringFromEnv('0 */6 * * *'),
  PII_RETENTION_DAYS: intFromEnv(30, 1, 3_650),

  /* --------------------------- feature flags ------------------------------ */
});

export type Env = z.infer<typeof envSchema>;
