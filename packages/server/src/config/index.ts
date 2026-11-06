import fs from 'node:fs';
import path from 'node:path';
import type { ChannelRuntimeConfig } from '@sac/shared';
import { envSchema } from './env.schema';
import type { Env, TrustProxySetting } from './env.schema';

/**
 * Fully resolved runtime configuration.
 *
 * Extends the adapter-facing `ChannelRuntimeConfig` with the server concerns
 * (HTTP, auth, encryption, Redis, object storage and cron schedules). This is
 * the ONLY object the rest of the server receives; no module should read
 * `process.env` directly.
 */
export interface AppConfig extends ChannelRuntimeConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  /** Interface the HTTP server binds to (`HOST`, default `0.0.0.0`). */
  host: string;
  webOrigin: string;
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  /**
   * Fastify `trustProxy` for client-IP resolution (`TRUST_PROXY`). `false` by
   * default; a boolean or an explicit proxy IP/CIDR list. See
   * `docs/SECURITY.md` §6.8 before enabling it in production.
   */
  trustProxy: TrustProxySetting;
  /**
   * Prometheus scrape secret (`METRICS_TOKEN`). When unset, `GET /api/v1/metrics`
   * answers 404; when set, the route requires the bearer/`x-metrics-token`.
   */
  metricsToken?: string;
  /**
   * Controlled maintenance window (`MAINTENANCE_MODE` / `MAINTENANCE_MESSAGE`).
   *
   * When enabled, every `/api/v1` route except the probes/`/status`/metrics and
   * every new Socket.IO handshake answer `503 MAINTENANCE`; marketplace webhooks
   * stay open. See `http/middleware/maintenance.ts`.
   */
  maintenanceMode: boolean;
  maintenanceMessage: string;
  /** base64, 32 bytes */
  encryptionMasterKey: string;
  encryptionKeyId: string;
  agentPresenceTtlSeconds: number;
  /** `From:` address used by the transactional e-mail service. */
  smtpFrom: string;
  logLevel: string;
  cron: {
    slaScan: string;
    piiPurge: string;
    shopeeLostPush: string;
    /** Daily physical purge of soft-deleted workspaces (default `0 3 * * *`). */
    tenantPurge: string;
  };
  /** Grace period (days) between LGPD soft delete and physical purge. */
  tenantPurgeRetentionDays: number;
  /**
   * LGPD Art. 15/16 storage limitation for tenant backups: artifacts older
   * than this many days are erased by the daily backup-purge job. `0` disables
   * the sweep entirely.
   */
  backupRetentionDays: number;
  /** Daily backup-expiry cron (default `0 4 * * *`). */
  backupPurgeCron: string;
  /**
   * Payment gateway contract (Fase 4). No provider SDK is used: the webhook is
   * authenticated by HMAC and the checkout URL is a template rendered locally.
   * Every field is optional so a deployment without billing still boots; the
   * billing routes answer `503 BILLING_NOT_CONFIGURED` instead.
   */
  billing: {
    webhookSecret?: string;
    checkoutUrlTemplate?: string;
    successUrl?: string;
    cancelUrl?: string;
  };
  s3: {
    endpoint?: string;
    region: string;
    bucket: string;
    attachmentsBucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
    sse?: string;
  };
}

/** Thrown when the environment is missing or malformed. Never swallowed. */
export class ConfigError extends Error {
  public readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(issues.length > 0 ? `${message}\n - ${issues.join('\n - ')}` : message);
    this.name = 'ConfigError';
    this.issues = issues;
    Object.setPrototypeOf(this, ConfigError.prototype);
  }
}

/**
 * Loads the closest `.env` file into `process.env` (Node 20.12+). Existing
 * environment variables always win, so container/CI secrets are never
 * clobbered by the repo file. Searches the working directory and its parents
 * (the API runs from the repo root in prod and from `packages/server` in dev).
 */
function loadDotEnvFile(): void {
  const searchRoots = [
    process.cwd(),
    path.resolve(process.cwd(), '..'),
    path.resolve(process.cwd(), '../..'),
    path.resolve(__dirname, '../../../..'),
  ];

  for (const root of searchRoots) {
    const candidate = path.join(root, '.env');
    if (fs.existsSync(candidate)) {
      try {
        process.loadEnvFile(candidate);
      } catch (error) {
        throw new ConfigError(
          `Failed to load environment file at ${candidate}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return;
    }
  }
}

function parseEnv(source: NodeJS.ProcessEnv): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new ConfigError('Invalid environment configuration', issues);
  }
  return parsed.data;
}

function assertProductionSafety(env: Env): void {
  if (env.NODE_ENV !== 'production') return;
  const issues: string[] = [];
  if (env.JWT_SECRET.length < 32) {
    issues.push('JWT_SECRET: too short for production (min 32 chars)');
  }
  if (env.JWT_SECRET === 'dev-only-change-me-please-32-chars-min') {
    issues.push('JWT_SECRET: remove the development default before going to production');
  }
  if (env.ENCRYPTION_KEY_ID === 'local-dev-v1') {
    issues.push('ENCRYPTION_KEY_ID: use a real key id (not local-dev-v1) in production');
  }
  if (env.ENCRYPTION_MASTER_KEY === 'zJ8kQ2mWv7bT1yN5cR9pLx4hF6dA0gU3sE2iO8qK5wY=') {
    issues.push('ENCRYPTION_MASTER_KEY: remove the development key before going to production');
  }
  if (env.SHOPEE_PARTNER_KEY.trim().length < 16) {
    issues.push(
      'SHOPEE_PARTNER_KEY: required in production (webhooks are signed with it; an empty key is forgeable)',
    );
  }
  if (env.S3_ACCESS_KEY_ID === 'minioadmin' || env.S3_SECRET_ACCESS_KEY === 'minioadmin') {
    issues.push(
      'S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY: remove the minioadmin defaults before going to production',
    );
  }
  if (env.WEB_ORIGIN.split(',').some((origin) => origin.trim() === '*')) {
    issues.push('WEB_ORIGIN: wildcard CORS is not allowed in production; list the exact frontend origins');
  }
  if (env.TRUST_PROXY === true) {
    issues.push(
      'TRUST_PROXY: do not trust every proxy in production (X-Forwarded-For spoofing); set the edge IP/CIDR or false',
    );
  }
  if (issues.length > 0) {
    throw new ConfigError('Unsafe production secrets', issues);
  }
}

function buildConfig(env: Env): AppConfig {
  const logLevel =
    env.LOG_LEVEL ?? (env.NODE_ENV === 'production' ? 'info' : env.NODE_ENV === 'test' ? 'silent' : 'debug');

  // Checkout return URLs default to the SPA origin so a deployment that only
  // sets BILLING_CHECKOUT_URL_TEMPLATE still renders a usable link.
  const webOriginBase =
    env.WEB_ORIGIN.split(',')
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0) ?? env.APP_BASE_URL;

  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    host: env.HOST,
    webOrigin: env.WEB_ORIGIN,
    appBaseUrl: env.APP_BASE_URL,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    jwtSecret: env.JWT_SECRET,
    jwtExpiresIn: env.JWT_EXPIRES_IN,
    trustProxy: env.TRUST_PROXY,
    metricsToken: env.METRICS_TOKEN,
    maintenanceMode: env.MAINTENANCE_MODE,
    maintenanceMessage: env.MAINTENANCE_MESSAGE,
    encryptionMasterKey: env.ENCRYPTION_MASTER_KEY,
    encryptionKeyId: env.ENCRYPTION_KEY_ID,
    agentPresenceTtlSeconds: env.AGENT_PRESENCE_TTL,
    smtpFrom: env.SMTP_FROM,
    logLevel,
    piiRetentionDays: env.PII_RETENTION_DAYS,
    tenantPurgeRetentionDays: env.TENANT_PURGE_RETENTION_DAYS,
    backupRetentionDays: env.BACKUP_RETENTION_DAYS,
    backupPurgeCron: env.BACKUP_PURGE_CRON,
    billing: {
      webhookSecret: env.BILLING_WEBHOOK_SECRET,
      checkoutUrlTemplate: env.BILLING_CHECKOUT_URL_TEMPLATE,
      successUrl: env.BILLING_SUCCESS_URL ?? `${webOriginBase}/billing/success`,
      cancelUrl: env.BILLING_CANCEL_URL ?? `${webOriginBase}/billing/cancel`,
    },
    cron: {
      slaScan: env.SLA_SCAN_CRON,
      piiPurge: env.PII_PURGE_CRON,
      shopeeLostPush: env.SHOPEE_LOST_PUSH_CRON,
      tenantPurge: env.TENANT_PURGE_CRON,
    },
    smtp: {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      user: env.SMTP_USER.length > 0 ? env.SMTP_USER : undefined,
      password: env.SMTP_PASSWORD.length > 0 ? env.SMTP_PASSWORD : undefined,
    },
    amazon: {
      lwaClientId: env.AMAZON_LWA_CLIENT_ID,
      lwaClientSecret: env.AMAZON_LWA_CLIENT_SECRET,
      appId: env.AMAZON_APP_ID,
      // Defaulting to APP_BASE_URL keeps local/staging usable without an extra
      // variable; production registers the exact URL in Seller Central.
      appRedirectUri:
        env.AMAZON_APP_REDIRECT_URI ??
        `${env.APP_BASE_URL.replace(/\/+$/, '')}/api/v1/accounts/oauth/amazon/callback`,
      oauthAuthorizeUrl: env.AMAZON_OAUTH_AUTHORIZE_URL,
      spApiEndpoint: env.AMAZON_SPAPI_ENDPOINT,
      lwaTokenUrl: env.AMAZON_LWA_TOKEN_URL,
      rdtEndpoint: env.AMAZON_RDT_ENDPOINT,
      region: env.AMAZON_SPAPI_REGION,
      sesInboundSharedSecret: env.AMAZON_SES_INBOUND_SHARED_SECRET,
      emailDomainAllowlist: env.AMAZON_EMAIL_DOMAIN_ALLOWLIST,
    },
    meli: {
      clientId: env.MELI_CLIENT_ID,
      clientSecret: env.MELI_CLIENT_SECRET,
      redirectUri: env.MELI_REDIRECT_URI,
      apiBase: env.MELI_API_BASE,
      refreshIntervalSeconds: env.MELI_REFRESH_INTERVAL_SECONDS,
      webhookTopics: env.MELI_WEBHOOK_TOPICS,
      webhookSecret: env.MELI_WEBHOOK_SECRET,
    },
    shopee: {
      partnerId: env.SHOPEE_PARTNER_ID,
      partnerKey: env.SHOPEE_PARTNER_KEY,
      redirectUri: env.SHOPEE_REDIRECT_URI,
      apiBase: env.SHOPEE_API_BASE,
      refreshIntervalSeconds: env.SHOPEE_REFRESH_INTERVAL_SECONDS,
      lostPushCron: env.SHOPEE_LOST_PUSH_CRON,
      lostPushLookbackMinutes: env.SHOPEE_LOST_PUSH_LOOKBACK_MINUTES,
      webhookToleranceSeconds: env.SHOPEE_WEBHOOK_TOLERANCE_SECONDS,
    },
    s3: {
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      bucket: env.S3_BUCKET,
      attachmentsBucket: env.S3_ATTACHMENTS_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      sse: env.S3_SSE,
    },
    rateLimits: {
      amazonMessagingPerSecond: env.RL_AMAZON_MESSAGING_PER_SECOND,
      amazonOrdersPerSecond: env.RL_AMAZON_ORDERS_PER_SECOND,
      amazonOrdersBurst: env.RL_AMAZON_ORDERS_BURST,
      amazonRdtPerSecond: env.RL_AMAZON_RDT_PER_SECOND,
      meliPerSecond: env.RL_MELI_PER_SECOND,
      shopeePerSecond: env.RL_SHOPEE_PER_SECOND,
    },
  };
}

/**
 * Resolves the environment into an `AppConfig`.
 *
 * @param env - explicit environment map (tests). When omitted, `.env` is
 *   loaded (without overriding real env vars) and `process.env` is used.
 */
export function loadConfig(env?: NodeJS.ProcessEnv): AppConfig {
  if (env === undefined) {
    loadDotEnvFile();
  }
  const parsed = parseEnv(env ?? process.env);
  assertProductionSafety(parsed);
  return buildConfig(parsed);
}

export { envSchema } from './env.schema';
export type { Env, TrustProxySetting } from './env.schema';
