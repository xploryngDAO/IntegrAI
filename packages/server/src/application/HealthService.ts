import { CACHE_KEYS, OPEN_TICKET_STATUSES } from '@sac/shared';
import type {
  AccountStatus,
  ChannelHealthView,
  ICache,
  IClock,
  IHealthService,
  ILogger,
  IRealtimePublisher,
  IAccountRepository,
  ITicketRepository,
  Marketplace,
  MarketplaceAccountRecord,
  ReadinessReport,
} from '@sac/shared';

/**
 * ============================================================================
 * HealthService
 * ============================================================================
 *
 * Liveness + per-channel readiness.
 *
 *  - dependency checks: Postgres (`SELECT 1`), Redis (`PING`) and S3 (best
 *    effort presigned read) with measured latency;
 *  - per-account channel health: inbound route, outbound token/auth validity,
 *    marketplace status and — for Shopee — the live CRR percentage computed
 *    from open chat tickets;
 *  - the per-channel projection is cached for 60s to keep the topbar cheap.
 *
 * The actual pings are injected by the container (infrastructure owns Prisma,
 * Redis and S3), which keeps this service testable without those dependencies.
 */

const CHANNEL_CACHE_TTL_SECONDS = 60;
const ERROR_GRACE_MS = 30 * 60 * 1000;
const TOKEN_EXPIRY_GRACE_MS = 5 * 60 * 1000;

/**
 * Wall-clock ceiling per readiness probe.
 *
 * `GET /health/ready` is polled by the orchestrator every few seconds: one hung
 * dependency (Redis socket without a reply, Pool waiting for a connection) must
 * not hold the probe open for the client timeout, otherwise the container looks
 * healthy-but-unresponsive and is never restarted. ~2 s is well below the
 * typical 5 s probe timeout and above a healthy local round-trip.
 */
const DEFAULT_READINESS_TIMEOUT_MS = 2_000;

/** Upper bound for a probe message crossing the wire / the logs. */
const READINESS_ERROR_MAX_CHARS = 200;

/** Dependency names in the stable order used by the readiness payload. */
const READINESS_DEPENDENCIES = ['database', 'redis', 'storage'] as const;

export interface HealthProbes {
  database: () => Promise<void>;
  redis: () => Promise<void>;
  storage: () => Promise<void>;
}

export interface HealthServiceDependencies {
  logger: ILogger;
  clock: IClock;
  cache: ICache;
  realtime?: IRealtimePublisher;
  probes: HealthProbes;
  repos: {
    accounts: IAccountRepository;
    tickets: ITicketRepository;
  };
  /** Test seam: shorten the readiness probe deadline (default 2 s). */
  readinessTimeoutMs?: number;
}

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  latencyMs?: number;
}

export class HealthService implements IHealthService {
  private readonly logger: ILogger;
  private readonly clock: IClock;
  private readonly cache: ICache;
  private readonly realtime: IRealtimePublisher | null;
  private readonly probes: HealthProbes;
  private readonly accounts: IAccountRepository;
  private readonly tickets: ITicketRepository;
  private readonly startedAt = Date.now();
  private readonly readinessTimeoutMs: number;

  constructor(deps: HealthServiceDependencies) {
    this.logger = deps.logger.child({ component: 'HealthService' });
    this.clock = deps.clock;
    this.cache = deps.cache;
    this.realtime = deps.realtime ?? null;
    this.probes = deps.probes;
    this.accounts = deps.repos.accounts;
    this.tickets = deps.repos.tickets;
    this.readinessTimeoutMs = Math.max(1, deps.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS);
  }

  /* ==================================================================== */
  /* Overall report                                                       */
  /* ==================================================================== */

  async health(): Promise<{
    status: 'ok' | 'degraded' | 'down';
    uptimeSeconds: number;
    checks: Array<{ name: string; ok: boolean; detail: string; latencyMs?: number }>;
    channels: ChannelHealthView[];
  }> {
    const [database, redis, storage] = await Promise.all([
      this.runProbe('database', this.probes.database),
      this.runProbe('redis', this.probes.redis),
      this.runProbe('storage', this.probes.storage),
    ]);
    const checks: CheckResult[] = [database, redis, storage];

    let channels: ChannelHealthView[] = [];
    try {
      channels = await this.channels();
    } catch (error) {
      this.logger.error('health.channels_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      checks.push({
        name: 'channels',
        ok: false,
        detail: 'Failed to build per-channel health',
      });
    }

    const databaseDown = !database.ok;
    const redisDown = !redis.ok;
    const storageDown = !storage.ok;
    const unhealthyChannels = channels.filter(
      (channel) => !channel.inboundHealthy || !channel.outboundHealthy,
    );

    let status: 'ok' | 'degraded' | 'down';
    if (databaseDown || redisDown) {
      status = 'down';
    } else if (storageDown || unhealthyChannels.length > 0) {
      status = 'degraded';
    } else {
      status = 'ok';
    }

    return {
      status,
      uptimeSeconds: Math.max(0, Math.round((Date.now() - this.startedAt) / 1000)),
      checks: checks.map((check) => ({
        name: check.name,
        ok: check.ok,
        detail: check.detail,
        ...(check.latencyMs !== undefined ? { latencyMs: check.latencyMs } : {}),
      })),
      channels,
    };
  }

  /* ==================================================================== */
  /* Readiness (orchestrator probe)                                       */
  /* ==================================================================== */

  /**
   * Bounded readiness check for load balancers / Kubernetes.
   *
   * Unlike `health()`, this NEVER throws and NEVER waits on a probe forever:
   * every dependency is raced against `readinessTimeoutMs`. The timeout timer is
   * `unref()`ed, so a hung probe cannot keep the process alive either. A failure
   * is data (`checks.<name> === 'error'` + a sanitized message), not an
   * exception: the endpoint must answer 503 without taking the process down.
   */
  async readiness(): Promise<ReadinessReport> {
    const results = await Promise.all(
      READINESS_DEPENDENCIES.map(async (dependency) => {
        try {
          await withDeadline(
            this.probes[dependency](),
            this.readinessTimeoutMs,
            `${dependency} probe`,
          );
          return { dependency, ok: true, error: null };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'probe failed';
          return {
            dependency,
            ok: false,
            error: sanitizeReadinessError(message),
          };
        }
      }),
    );

    const checks: ReadinessReport['checks'] = {
      database: 'ok',
      redis: 'ok',
      storage: 'ok',
    };
    const errors: NonNullable<ReadinessReport['errors']> = {};
    let healthy = true;

    for (const result of results) {
      if (result.ok) continue;
      healthy = false;
      checks[result.dependency] = 'error';
      errors[result.dependency] = result.error ?? 'probe failed';
    }

    return healthy
      ? { status: 'ready', checks }
      : { status: 'degraded', checks, errors };
  }

  private async runProbe(name: string, probe: () => Promise<void>): Promise<CheckResult> {
    const started = Date.now();
    try {
      await probe();
      return {
        name,
        ok: true,
        detail: 'ok',
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      return {
        name,
        ok: false,
        detail: error instanceof Error ? error.message.slice(0, 300) : 'probe failed',
        latencyMs: Date.now() - started,
      };
    }
  }

  /* ==================================================================== */
  /* Per-channel health                                                   */
  /* ==================================================================== */

  async channels(): Promise<ChannelHealthView[]> {
    const accounts = await this.accounts.list();
    const views: ChannelHealthView[] = [];

    for (const account of accounts) {
      const cacheKey = CACHE_KEYS.healthChannel(account.marketplace, account.id);
      try {
        const cached = await this.cache.get<ChannelHealthView>(cacheKey);
        if (cached && typeof cached.marketplace === 'string') {
          views.push(cached);
          continue;
        }
      } catch (error) {
        this.logger.debug('health.channel_cache_read_failed', {
          accountId: account.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      const view = await this.buildChannelView(account);
      views.push(view);
      try {
        await this.cache.set(cacheKey, view, CHANNEL_CACHE_TTL_SECONDS);
      } catch (error) {
        this.logger.debug('health.channel_cache_write_failed', {
          accountId: account.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return views.sort((a, b) => a.marketplace.localeCompare(b.marketplace));
  }

  private async buildChannelView(account: MarketplaceAccountRecord): Promise<ChannelHealthView> {
    const now = this.clock.now();
    const channelConfig = account.channelConfig ?? {};
    const details: string[] = [];

    const tokenExpired =
      account.tokenExpiresAt !== null &&
      account.tokenExpiresAt.getTime() <= now.getTime() + TOKEN_EXPIRY_GRACE_MS;
    const authExpired =
      account.authExpiresAt !== null &&
      account.authExpiresAt.getTime() <= now.getTime() + TOKEN_EXPIRY_GRACE_MS;
    const disconnected = account.status === 'DISCONNECTED';
    const recentError =
      account.lastErrorAt !== null && now.getTime() - account.lastErrorAt.getTime() < ERROR_GRACE_MS;

    const hasRefresh = typeof account.refreshTokenEnc === 'string' && account.refreshTokenEnc !== '';
    const hasAccess = typeof account.accessTokenEnc === 'string' && account.accessTokenEnc !== '';

    // --- outbound ---------------------------------------------------------
    let outboundHealthy = true;
    if (disconnected) {
      outboundHealthy = false;
      details.push('Conta desconectada.');
    }
    if (!hasRefresh && !hasAccess) {
      outboundHealthy = false;
      details.push('Sem credenciais armazenadas.');
    }
    if (tokenExpired) {
      outboundHealthy = false;
      details.push('Access token expirado; renovação necessária.');
    }
    if (authExpired) {
      outboundHealthy = false;
      details.push('Autorização do app expirada; reconecte a conta.');
    }
    if (recentError) {
      outboundHealthy = false;
      details.push(`Último erro: ${(account.lastError ?? 'desconhecido').slice(0, 160)}`);
    }
    if (account.marketplace === 'AMAZON' && !hasRefresh) {
      outboundHealthy = false;
      details.push('LWA refresh token ausente.');
    }

    // --- inbound ----------------------------------------------------------
    let inboundHealthy = true;
    if (disconnected) {
      inboundHealthy = false;
    }

    if (account.marketplace === 'AMAZON') {
      const inboundRoute = readString(channelConfig.inbound_email_route);
      const sender = readString(channelConfig.smtp_sender_email);
      if (!inboundRoute) {
        inboundHealthy = false;
        details.push('Rota de e-mail de entrada não configurada.');
      }
      if (!sender) {
        inboundHealthy = false;
        details.push('Remetente SMTP aprovado não configurado.');
      }
    } else if (account.marketplace === 'SHOPEE') {
      if (!hasRefresh && !hasAccess) {
        inboundHealthy = false;
        details.push('Credenciais Shopee ausentes.');
      }
    } else if (account.marketplace === 'MERCADO_LIVRE') {
      if (!hasRefresh && !hasAccess) {
        inboundHealthy = false;
        details.push('Credenciais Meli ausentes.');
      }
    }

    let crrPercent: number | null = null;
    if (account.marketplace === 'SHOPEE') {
      crrPercent = await this.computeCrrPercent(account);
      if (crrPercent !== null && crrPercent < 80) {
        details.push(`CRR em ${crrPercent.toFixed(1)}% (meta ≥ 80%).`);
      }
    }

    if (details.length === 0) {
      details.push(
        outboundHealthy && inboundHealthy
          ? 'Canal operacional.'
          : 'Canal com restrições de operação.',
      );
    }

    const status = this.normalizedStatus(account, tokenExpired || authExpired, outboundHealthy);

    return {
      marketplace: account.marketplace,
      accountId: account.id,
      accountDisplayName: account.displayName,
      status,
      inboundHealthy,
      outboundHealthy,
      tokenExpiresAt: account.tokenExpiresAt ? account.tokenExpiresAt.toISOString() : null,
      detail: details.join(' '),
      crrPercent,
    };
  }

  private normalizedStatus(
    account: MarketplaceAccountRecord,
    credentialsInvalid: boolean,
    outboundHealthy: boolean,
  ): AccountStatus {
    if (account.status === 'DISCONNECTED') return 'DISCONNECTED';
    if (credentialsInvalid || !outboundHealthy) return 'TOKEN_EXPIRED';
    return account.status === 'ACTIVE' ? 'ACTIVE' : account.status;
  }

  /**
   * Shopee CRR approximation: share of open chat tickets whose channel metadata
   * marks the conversation as safe (last message outbound). Capped at 100 open
   * tickets — the figure is a telemetry indicator, not an accounting value.
   */
  private async computeCrrPercent(account: MarketplaceAccountRecord): Promise<number | null> {
    try {
      const page = await this.tickets.list(
        {
          marketplace: ['SHOPEE'],
          accountId: account.id,
          status: [...OPEN_TICKET_STATUSES],
        },
        { page: 1, pageSize: 100 },
      );
      if (page.total === 0 || page.items.length === 0) return null;

      let safe = 0;
      for (const ticket of page.items) {
        const metadata = ticket.channelMetadata ?? {};
        if (metadata.crr_safe !== false) safe += 1;
      }
      return Math.round((safe / page.items.length) * 1000) / 10;
    } catch (error) {
      this.logger.warn('health.crr_failed', {
        accountId: account.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** Emits the realtime health snapshot (called by token-refresh workers). */
  publishChannelHealth(views: ChannelHealthView[]): void {
    if (!this.realtime) return;
    const at = this.clock.now().toISOString();
    for (const view of views) {
      try {
        this.realtime.channelHealth({
          marketplace: view.marketplace,
          accountId: view.accountId,
          healthy: view.inboundHealthy && view.outboundHealthy,
          detail: view.detail.slice(0, 300),
          at,
        });
      } catch (error) {
        this.logger.debug('health.realtime_emit_failed', {
          accountId: view.accountId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

/* ---------------------------------------------------------------------- */
/* Helpers                                                                */
/* ---------------------------------------------------------------------- */

function readString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return null;
}

/**
 * Flattens and bounds a probe message. The body is unauthenticated (an
 * orchestrator has no JWT), so it gets the same treatment as the existing
 * `/health` detail: one line, capped, never a stack trace.
 */
function sanitizeReadinessError(message: string): string {
  return message.replace(/\s+/g, ' ').trim().slice(0, READINESS_ERROR_MAX_CHARS) || 'probe failed';
}

/**
 * Race an operation against a wall-clock deadline. The losing promise is still
 * observed (race attaches a rejection handler), so a late probe failure cannot
 * become an unhandled rejection; the timer is unref'ed so a pending probe never
 * keeps the event loop alive.
 */
function withDeadline<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref();

    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Kept explicit so the type of the marketplace key is checked at compile time. */
export type ChannelMarketplace = Marketplace;
