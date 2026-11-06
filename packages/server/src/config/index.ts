import fs from 'node:fs';
import path from 'node:path';
import type { ChannelRuntimeConfig } from '@sac/shared';
import { envSchema } from './env.schema';
import type { Env } from './env.schema';

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
  webOrigin: string;
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  jwtExpiresIn: string;
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
  if (env.JWT_SECRET.length < 32) {
    throw new ConfigError('JWT_SECRET must be at least 32 characters in production', [
      'JWT_SECRET: too short for production (min 32 chars)',
    ]);
  }
}

function buildConfig(env: Env): AppConfig {
  const logLevel =
    env.LOG_LEVEL ?? (env.NODE_ENV === 'production' ? 'info' : env.NODE_ENV === 'test' ? 'silent' : 'debug');

  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    webOrigin: env.WEB_ORIGIN,
    appBaseUrl: env.APP_BASE_URL,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    jwtSecret: env.JWT_SECRET,
    jwtExpiresIn: env.JWT_EXPIRES_IN,
    encryptionMasterKey: env.ENCRYPTION_MASTER_KEY,
    encryptionKeyId: env.ENCRYPTION_KEY_ID,
    agentPresenceTtlSeconds: env.AGENT_PRESENCE_TTL,
    smtpFrom: env.SMTP_FROM,
    logLevel,
    piiRetentionDays: env.PII_RETENTION_DAYS,
    tenantPurgeRetentionDays: env.TENANT_PURGE_RETENTION_DAYS,
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
export type { Env } from './env.schema';
