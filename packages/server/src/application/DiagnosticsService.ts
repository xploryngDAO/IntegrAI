import fs from 'node:fs';
import path from 'node:path';

import { NotFoundError, redactPiiForLogs } from '@sac/shared';
import type {
  AccountDiagnosis,
  DiagnosisCheck,
  DiagnosisStatus,
  IAccountRepository,
  IAdapterRegistry,
  IClock,
  IDiagnosticsService,
  ILogger,
  Marketplace,
  MarketplaceAccountRecord,
  SystemDiagnosis,
} from '@sac/shared';

/**
 * ============================================================================
 * DiagnosticsService
 * ============================================================================
 *
 * REAL, live diagnostics used by `GET /diagnostics` and by `npm run doctor`.
 * Nothing here is simulated:
 *
 *  - infrastructure: PostgreSQL round-trip, Redis PING and an S3 bucket probe;
 *  - channels: every connected account is asked to run the channel adapter's
 *    `diagnose({ accountId })`, which performs authenticated marketplace calls
 *    (token exchange + cheapest safe read). Accounts run in parallel with a
 *    bounded worker pool and a hard per-account timeout;
 *  - accounts without stored credentials or without required channel config are
 *    reported as `fail` with an actionable remediation instead of being skipped.
 *
 * The service never throws for a failed check: a check failure is data, not an
 * exception. It only throws for a genuinely invalid request (unknown account).
 */

const ACCOUNT_TIMEOUT_MS = 15_000;
const INFRA_TIMEOUT_MS = 10_000;
const DEFAULT_CONCURRENCY = 4;

const MARKETPLACE_PREFIX: Record<Marketplace, string> = {
  AMAZON: 'amazon',
  MERCADO_LIVRE: 'meli',
  SHOPEE: 'shopee',
};

const ACCOUNT_RECONNECT_REMEDIATION =
  'Reconecte a conta em Configurações > Contas (wizard "Conectar loja") e confirme as credenciais do marketplace.';

export interface DiagnosticsInfraProbes {
  /** `SELECT 1` through Prisma. */
  database: () => Promise<void>;
  /** Redis `PING`. */
  redis: () => Promise<void>;
  /** S3 `HeadBucket` (or equivalent probe of the attachments bucket). */
  storage: () => Promise<void>;
  /** False when S3/MinIO credentials are not configured at all. */
  storageConfigured: boolean;
}

export interface DiagnosticsServiceDependencies {
  logger: ILogger;
  clock: IClock;
  adapters: IAdapterRegistry;
  repos: {
    accounts: IAccountRepository;
  };
  probes: DiagnosticsInfraProbes;
  /** Test seam: shorten timeouts in unit tests. */
  timeouts?: {
    accountMs?: number;
    infraMs?: number;
    concurrency?: number;
  };
}

export class DiagnosticsService implements IDiagnosticsService {
  private readonly logger: ILogger;
  private readonly clock: IClock;
  private readonly adapters: IAdapterRegistry;
  private readonly accounts: IAccountRepository;
  private readonly probes: DiagnosticsInfraProbes;
  private readonly accountTimeoutMs: number;
  private readonly infraTimeoutMs: number;
  private readonly concurrency: number;

  constructor(deps: DiagnosticsServiceDependencies) {
    this.logger = deps.logger.child({ component: 'DiagnosticsService' });
    this.clock = deps.clock;
    this.adapters = deps.adapters;
    this.accounts = deps.repos.accounts;
    this.probes = deps.probes;
    this.accountTimeoutMs = Math.max(1_000, deps.timeouts?.accountMs ?? ACCOUNT_TIMEOUT_MS);
    this.infraTimeoutMs = Math.max(1_000, deps.timeouts?.infraMs ?? INFRA_TIMEOUT_MS);
    this.concurrency = Math.max(1, deps.timeouts?.concurrency ?? DEFAULT_CONCURRENCY);
  }

  /* ==================================================================== */
  /* System diagnosis                                                     */
  /* ==================================================================== */

  async system(): Promise<SystemDiagnosis> {
    const startedAt = this.clock.now();

    const infrastructure = await Promise.all([
      this.runInfraProbe(
        'infra.postgres',
        'PostgreSQL',
        this.probes.database,
        'Verifique DATABASE_URL e se o container do Postgres está saudável (docker compose ps postgres).',
      ),
      this.runInfraProbe(
        'infra.redis',
        'Redis',
        this.probes.redis,
        'Verifique REDIS_URL e se o container do Redis está no ar (docker compose ps redis).',
      ),
      this.storageCheck(),
    ]);

    let channels: AccountDiagnosis[] = [];
    try {
      const accounts = await this.accounts.list();
      if (accounts.length === 0) {
        infrastructure.push({
          id: 'infra.accounts',
          label: 'Contas conectadas',
          status: 'warn',
          detail:
            'Nenhuma conta de marketplace conectada; webhooks, ingestão e envio ficam inativos até a primeira conexão.',
          remediation:
            'Abra a tela Contas e conecte ao menos uma loja (Amazon, Mercado Livre ou Shopee).',
        });
      }
      channels = await mapWithConcurrency(accounts, this.concurrency, (account) =>
        this.diagnoseAccount(account),
      );
    } catch (error) {
      const message = redactPiiForLogs(errorMessage(error));
      this.logger.error('diagnostics.accounts_failed', { error: message });
      infrastructure.push({
        id: 'infra.accounts',
        label: 'Contas conectadas',
        status: 'fail',
        detail: `Não foi possível listar as contas conectadas: ${message.slice(0, 300)}`,
        remediation:
          'Verifique a conexão com o banco e rode as migrations/schema (npm run prisma:generate / npm run db:push).',
      });
    }

    const allChecks: DiagnosisCheck[] = [
      ...infrastructure,
      ...channels.flatMap((channel) => channel.checks),
    ];
    const overall = aggregateStatus(allChecks);

    this.logger.info('diagnostics.system.completed', {
      overall,
      accounts: channels.length,
      infrastructureChecks: infrastructure.length,
      latencyMs: this.clock.now().getTime() - startedAt.getTime(),
    });

    return {
      overall,
      version: resolveVersion(),
      testedAt: this.clock.now().toISOString(),
      infrastructure,
      channels,
    };
  }

  /* ==================================================================== */
  /* Account diagnosis                                                    */
  /* ==================================================================== */

  async account(accountId: string): Promise<AccountDiagnosis> {
    const account = await this.accounts.findById(accountId);
    if (!account) throw new NotFoundError('MarketplaceAccount', accountId);
    return this.diagnoseAccount(account);
  }

  private async diagnoseAccount(account: MarketplaceAccountRecord): Promise<AccountDiagnosis> {
    const prefix = MARKETPLACE_PREFIX[account.marketplace];
    const checks: DiagnosisCheck[] = [];
    const hasCredentials =
      isNonEmpty(account.refreshTokenEnc) || isNonEmpty(account.accessTokenEnc);

    // --- local config checks (no network) --------------------------------
    if (!hasCredentials) {
      checks.push({
        id: `${prefix}.config`,
        label: 'Credenciais da conta',
        status: 'fail',
        detail:
          'Nenhum access token ou refresh token está armazenado para esta conta; o canal não consegue autenticar.',
        remediation: ACCOUNT_RECONNECT_REMEDIATION,
      });
    } else if (account.status === 'DISCONNECTED') {
      checks.push({
        id: `${prefix}.account`,
        label: 'Status da conta',
        status: 'fail',
        detail: 'A conta está marcada como DISCONNECTED e não processa envios.',
        remediation: ACCOUNT_RECONNECT_REMEDIATION,
      });
    } else if (account.status === 'TOKEN_EXPIRED') {
      checks.push({
        id: `${prefix}.token.status`,
        label: 'Status do token',
        status: 'warn',
        detail: `A conta está com status TOKEN_EXPIRED${account.lastError ? `: ${account.lastError.slice(0, 200)}` : '.'}`,
        remediation: 'Rode POST /accounts/:id/refresh ou aguarde o job queue.token.refresh.',
      });
    }

    if (account.marketplace === 'AMAZON') {
      const config = account.channelConfig ?? {};
      if (!isNonEmpty(config.inbound_email_route)) {
        checks.push({
          id: 'amazon.config.inbound',
          label: 'Rota de e-mail de entrada (SES relay)',
          status: 'fail',
          detail:
            'channel_config.inbound_email_route não está configurado; e-mails do comprador não serão roteados para esta conta.',
          remediation:
            'Configure inbound_email_route no wizard da conta (ex.: amazon-relay@inbound.seu-dominio).',
        });
      }
      if (!isNonEmpty(config.smtp_sender_email)) {
        checks.push({
          id: 'amazon.config.smtp',
          label: 'Remetente SMTP aprovado',
          status: 'fail',
          detail:
            'channel_config.smtp_sender_email não está configurado; a Route 1 (Buyer-Seller Messaging via SMTP) não pode enviar.',
          remediation:
            'Informe o e-mail aprovado em Seller Central > Mensagens e salve em channel_config.smtp_sender_email.',
        });
      }
    }

    // --- live channel checks --------------------------------------------
    const adapter = this.adapters.get(account.marketplace);
    if (typeof adapter.diagnose !== 'function') {
      checks.push({
        id: `${prefix}.diagnose`,
        label: 'Diagnóstico do canal',
        status: 'skipped',
        detail:
          'O adaptador deste canal não implementa diagnose(accountId); apenas os checks locais foram executados.',
        remediation:
          'Atualize o pacote do adaptador. Enquanto isso, valide o canal pelo fluxo de conexão e pelos logs de webhook.',
      });
    } else if (hasCredentials) {
      const started = Date.now();
      try {
        const adapterChecks = await withTimeout(
          adapter.diagnose({ accountId: account.id }),
          this.accountTimeoutMs,
          `diagnose(${account.marketplace})`,
        );
        if (!Array.isArray(adapterChecks) || adapterChecks.length === 0) {
          checks.push({
            id: `${prefix}.diagnose`,
            label: 'Diagnóstico do canal',
            status: 'skipped',
            detail: 'O adaptador não retornou nenhum check para esta conta.',
          });
        } else {
          const normalized = adapterChecks.map((check) => normalizeCheck(prefix, check));
          for (const check of normalized) {
            checks.push(check);
          }
          const failed = normalized.filter((check) => check.status === 'fail');
          if (failed.length > 0) {
            // Traceability hook for adapter teams: account id + timestamp + the
            // failing check ids (the detail usually carries the marketplace
            // request_id, e.g. Shopee).
            this.logger.warn('diagnostics.account.checks_failed', {
              accountId: account.id,
              marketplace: account.marketplace,
              checkedAt: this.clock.now().toISOString(),
              checks: failed.map((check) => check.id),
              latencyMs: Date.now() - started,
            });
          }
        }
      } catch (error) {
        const message = redactPiiForLogs(errorMessage(error));
        checks.push({
          id: `${prefix}.diagnose`,
          label: 'Diagnóstico do canal',
          status: 'fail',
          detail: `O diagnóstico do canal falhou: ${message.slice(0, 400)}`,
          latencyMs: Date.now() - started,
          remediation:
            'Verifique conectividade de rede com o marketplace, validade das credenciais e os logs do adaptador. Rode POST /accounts/:id/refresh e tente novamente.',
        });
        this.logger.warn('diagnostics.account.failed', {
          accountId: account.id,
          marketplace: account.marketplace,
          checkedAt: this.clock.now().toISOString(),
          timeoutMs: this.accountTimeoutMs,
          elapsedMs: Date.now() - started,
          error: message.slice(0, 400),
        });
      }
    }

    return {
      accountId: account.id,
      marketplace: account.marketplace,
      displayName: account.displayName,
      overall: aggregateStatus(checks),
      checks,
      testedAt: this.clock.now().toISOString(),
    };
  }

  /* ==================================================================== */
  /* Infrastructure checks                                               */
  /* ==================================================================== */

  private async runInfraProbe(
    id: string,
    label: string,
    probe: () => Promise<void>,
    remediation: string,
  ): Promise<DiagnosisCheck> {
    const started = Date.now();
    try {
      await withTimeout(probe(), this.infraTimeoutMs, `${label} probe`);
      return {
        id,
        label,
        status: 'ok',
        detail: 'Conexão estabelecida.',
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      const message = redactPiiForLogs(errorMessage(error));
      this.logger.warn('diagnostics.infra.failed', { check: id, error: message.slice(0, 400) });
      return {
        id,
        label,
        status: 'fail',
        detail: message.slice(0, 400),
        latencyMs: Date.now() - started,
        remediation,
      };
    }
  }

  private async storageCheck(): Promise<DiagnosisCheck> {
    if (!this.probes.storageConfigured) {
      return {
        id: 'infra.s3',
        label: 'Object storage (S3/MinIO)',
        status: 'warn',
        detail:
          'S3/MinIO não está configurado; uploads de evidências, NF-e e anexos ficarão indisponíveis.',
        remediation:
          'Configure S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ATTACHMENTS_BUCKET, S3_ACCESS_KEY_ID e S3_SECRET_ACCESS_KEY no .env e reinicie a API.',
      };
    }
    return this.runInfraProbe(
      'infra.s3',
      'Object storage (S3/MinIO)',
      this.probes.storage,
      'Verifique S3_ENDPOINT/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY, se o bucket existe e se o container MinIO está no ar (docker compose ps minio).',
    );
  }
}

/* ---------------------------------------------------------------------- */
/* Exported helpers (used by the CLI report)                              */
/* ---------------------------------------------------------------------- */

export function aggregateStatus(checks: DiagnosisCheck[]): DiagnosisStatus {
  if (checks.some((check) => check.status === 'fail')) return 'fail';
  if (checks.some((check) => check.status === 'warn' || check.status === 'skipped')) return 'warn';
  return 'ok';
}

export function normalizeCheck(prefix: string, check: DiagnosisCheck): DiagnosisCheck {
  const rawId = typeof check.id === 'string' && check.id.trim() !== '' ? check.id.trim() : 'unknown';
  const id = rawId.includes('.') ? rawId : `${prefix}.${rawId}`;
  const status: DiagnosisStatus = ['ok', 'warn', 'fail', 'skipped'].includes(check.status)
    ? check.status
    : 'warn';
  return {
    id,
    label: typeof check.label === 'string' && check.label.trim() !== '' ? check.label : id,
    status,
    detail: redactPiiForLogs(String(check.detail ?? '')).slice(0, 1_000),
    ...(typeof check.latencyMs === 'number' && Number.isFinite(check.latencyMs)
      ? { latencyMs: Math.max(0, Math.round(check.latencyMs)) }
      : {}),
    ...(typeof check.remediation === 'string' && check.remediation.trim() !== ''
      ? { remediation: check.remediation }
      : {}),
  };
}

/* ---------------------------------------------------------------------- */
/* Internals                                                              */
/* ---------------------------------------------------------------------- */

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  });

  await Promise.all(runners);
  return results;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} excedeu o timeout de ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref: () => void }).unref();
    }
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isNonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads the deployed version without pulling a package.json into the TypeScript
 * program (the server tsconfig has `rootDir = src`). Works from the repo root
 * (npm scripts) and from `packages/server` (tsx dev).
 */
export function resolveVersion(): string {
  const candidates = [
    path.resolve(process.cwd(), 'package.json'),
    path.resolve(process.cwd(), '..', '..', 'package.json'),
    path.resolve(__dirname, '../../../../package.json'),
    path.resolve(__dirname, '../../../package.json'),
  ];
  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(raw) as { version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version.trim() !== '') {
        return parsed.version.trim();
      }
    } catch {
      // Next candidate.
    }
  }
  const envVersion = process.env.npm_package_version;
  return envVersion && envVersion.trim() !== '' ? envVersion.trim() : '0.0.0';
}
