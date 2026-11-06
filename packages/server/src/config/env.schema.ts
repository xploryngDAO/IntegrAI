import { z } from 'zod';
import { DEFAULT_MAINTENANCE_MESSAGE } from '@sac/shared';

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

function boolFromEnv(fallback: boolean): z.ZodType<boolean> {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    if (TRUTHY.has(normalized)) return true;
    if (FALSY.has(normalized)) return false;
    return value;
  }, z.boolean());
}

function stringFromEnv(fallback: string): z.ZodType<string> {
  return z.preprocess((value) => {
    if (value === undefined || value === null) return fallback;
    return String(value).trim();
  }, z.string());
}

function requiredString(field: string): z.ZodType<string> {
  return z.preprocess(
    (value) => (value === undefined || value === null ? undefined : String(value).trim()),
    z.string().min(1, `${field} must not be empty`),
  );
}

function optionalString(): z.ZodType<string | undefined> {
  return z.preprocess((value) => {
    if (value === undefined || value === null) return undefined;
    const text = String(value).trim();
    return text.length > 0 ? text : undefined;
  }, z.string().min(1).optional());
}

function numberFromEnv(fallback: number): z.ZodType<number> {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'number') return value;
    const parsed = Number(String(value).trim());
    return Number.isFinite(parsed) ? parsed : value;
  }, z.number().finite());
}

function intFromEnv(fallback: number, min?: number, max?: number): z.ZodType<number> {
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

function csvFromEnv(fallback: string[] = []): z.ZodType<string[]> {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return fallback;
    if (Array.isArray(value)) return value;
    return String(value)
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }, z.array(z.string()));
}

/** Fastify `trustProxy` value: `true`/`false` or an explicit proxy IP/CIDR list. */
export type TrustProxySetting = boolean | string[];

/**
 * Parses `TRUST_PROXY`.
 *
 * Accepted forms:
 * - unset/empty -> `false` (never trust `X-Forwarded-For`);
 * - `true`/`false` (also `1/0`, `yes/no`, `on/off`) -> boolean;
 * - `10.0.0.0/8, 172.16.0.0/12` -> list of trusted proxy IPs/CIDRs.
 *
 * The default is deliberately `false`: with `trustProxy: true` unconditionally
 * any client can spoof `X-Forwarded-For` and bypass the per-IP rate limits
 * unless the API is unreachable except through the edge. See
 * `docs/SECURITY.md` §6.8.
 */
function trustProxyFromEnv(): z.ZodType<TrustProxySetting> {
  return z.preprocess((value) => {
    if (value === undefined || value === null || value === '') return false;
    if (typeof value === 'boolean') return value;
    const raw = String(value).trim();
    if (raw === '') return false;
    const normalized = raw.toLowerCase();
    if (TRUTHY.has(normalized)) return true;
    if (FALSY.has(normalized)) return false;
    const entries = raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return entries.length > 0 ? entries : false;
  }, z.union([z.boolean(), z.array(z.string().min(1))]));
}

/** base64 key that MUST decode to exactly 32 bytes (AES-256). */
function masterKeyFromEnv(fallback: string): z.ZodType<string> {
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

/**
 * `MAINTENANCE_MESSAGE`: operator-facing text of the maintenance 503.
 *
 * Unset, empty or whitespace-only falls back to the shared default, so the
 * SPA/support runbook always receives an actionable message.
 */
function maintenanceMessageFromEnv(): z.ZodType<string> {
  return z.preprocess((value) => {
    if (value === undefined || value === null) return DEFAULT_MAINTENANCE_MESSAGE;
    const text = String(value).trim();
    return text.length > 0 ? text : DEFAULT_MAINTENANCE_MESSAGE;
  }, z.string().min(1));
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
  JWT_EXPIRES_IN: stringFromEnv('1h'),
  AGENT_PRESENCE_TTL: intFromEnv(120, 10, 86_400),
  /**
   * Fastify `trustProxy`. Default `false` (socket address; `X-Forwarded-For`
   * ignored). In production behind Render/Vercel/Cloudflare set the edge
   * IPs/CIDRs, e.g. `TRUST_PROXY=10.0.0.0/8,172.16.0.0/12`; `true` is only
   * acceptable when the API is unreachable except through an edge that
   * overwrites the header. See `docs/SECURITY.md` §6.8.
   */
  TRUST_PROXY: trustProxyFromEnv(),
  /**
   * Shared secret for `GET /api/v1/metrics` (Prometheus scrape). Absent keeps
   * the endpoint disabled (404); configured, it requires
   * `Authorization: Bearer <METRICS_TOKEN>` or `x-metrics-token`.
   */
  METRICS_TOKEN: optionalString(),

  /* -------------------------- Amazon SP-API / SES ------------------------- */
  AMAZON_LWA_CLIENT_ID: stringFromEnv(''),
  AMAZON_LWA_CLIENT_SECRET: stringFromEnv(''),
  /** Fase 2: public SP-API app used by the "Autorizar na Amazon" OAuth flow. */
  AMAZON_APP_ID: optionalString(),
  AMAZON_APP_REDIRECT_URI: optionalString(),
  /** Empty falls back to the NA consent page inside AccountService. */
  AMAZON_OAUTH_AUTHORIZE_URL: optionalString(),
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
  /**
   * Daily LGPD physical purge of workspaces soft-deleted more than
   * `TENANT_PURGE_RETENTION_DAYS` ago (default 03:00, low-traffic window).
   */
  TENANT_PURGE_CRON: stringFromEnv('0 3 * * *'),
  TENANT_PURGE_RETENTION_DAYS: intFromEnv(30, 1, 3_650),
  /**
   * LGPD Art. 15/16 (storage limitation): tenant backups older than this many
   * days are erased by the daily backup-purge job. `0` disables the sweep.
   * Default 90 days; 0 is accepted on purpose, so the minimum is 0.
   */
  BACKUP_RETENTION_DAYS: intFromEnv(90, 0, 3_650),
  /** Daily backup-expiry cron (default 04:00, after the tenant purge). */
  BACKUP_PURGE_CRON: stringFromEnv('0 4 * * *'),

  /* ---------------------- billing gateway (Fase 4) ------------------------ */
  /**
   * Shared HMAC SHA-256 secret of the payment gateway webhook. Absent keeps the
   * deployment bootable but makes `POST /api/v1/billing/webhook` answer
   * `503 BILLING_NOT_CONFIGURED` (never accept an unsigned event).
   */
  BILLING_WEBHOOK_SECRET: optionalString(),
  /**
   * Hosted checkout URL template. Placeholders: `{tenantId}`, `{slug}`,
   * `{plan}`, `{email}`, `{successUrl}`, `{cancelUrl}`. Absent makes
   * `POST /platform/tenants/:id/checkout` answer 503.
   */
  BILLING_CHECKOUT_URL_TEMPLATE: optionalString(),
  /** Return URLs substituted into the checkout template (optional). */
  BILLING_SUCCESS_URL: optionalString(),
  BILLING_CANCEL_URL: optionalString(),

  /* --------------------- operational maintenance window ------------------- */
  /**
   * Controlled maintenance window. While true:
   *
   * - every `/api/v1` route answers `503 MAINTENANCE` except the probes
   *   (`/health`, `/health/ready`), `/status` and the Prometheus scrape
   *   (`/api/v1/metrics`);
   * - new Socket.IO handshakes are refused (HTTP 503) instead of polling an API
   *   that would answer every request with 503;
   * - marketplace webhooks (`/webhooks/*`, outside `/api/v1`) keep working so
   *   no push event is lost while the operators are locked out.
   *
   * Default `false`; flips are deliberately deploy-time only (env contract).
   */
  MAINTENANCE_MODE: boolFromEnv(false),
  /** Operator-facing 503 text (default: `DEFAULT_MAINTENANCE_MESSAGE`). */
  MAINTENANCE_MESSAGE: maintenanceMessageFromEnv(),

  /* --------------------------- feature flags ------------------------------ */
});

export type Env = z.infer<typeof envSchema>;
