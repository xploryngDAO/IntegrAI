import type {
  IAccountRepository,
  IClock,
  ILogger,
  IStatusService,
  Marketplace,
  MarketplaceAccountRecord,
  SystemStatusChannel,
  SystemStatusLevel,
  SystemStatusService,
  SystemStatusSnapshot,
} from '@sac/shared';

import type { HealthProbes } from './HealthService';

/**
 * ============================================================================
 * StatusService - public status page (`GET /status`, `GET /api/v1/status`)
 * ============================================================================
 *
 * Anonymous, PII-free availability snapshot:
 *
 *  - `services`: the API itself plus the three infrastructure dependencies,
 *    measured with the SAME probes used by HealthService/DiagnosticsService
 *    (Postgres `SELECT 1`, Redis `PING`, S3 bucket probe). There is NO adapter
 *    or marketplace call here, so the endpoint never spends paid API quota.
 *  - `channels`: per-marketplace COUNTS derived from the stored account state
 *    (status, credentials, recent error). No account id, display name, detail
 *    message, operator e-mail or secret leaves the service.
 *
 * Failure policy: a failing dependency is data, not an exception. The response
 * is built even when every probe is down; the route adds a defensive fallback
 * for the (unexpected) case where the service itself throws.
 *
 * Level mapping (matches the public contract):
 *  - database OR redis down                      -> `down`
 *  - storage down OR any channel partly unhealthy -> `degraded`
 *  - everything healthy                           -> `operational`
 */

/** Hard ceiling per dependency probe; a hung check cannot hang the page. */
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
/** An account error inside this window keeps the account "unhealthy". */
const ERROR_GRACE_MS = 30 * 60 * 1_000;

export interface StatusServiceDependencies {
  logger: ILogger;
  clock: IClock;
  probes: HealthProbes;
  repos: { accounts: IAccountRepository };
  /** Test seam: shorten the probe timeout. */
  timeoutMs?: number;
}

export class StatusService implements IStatusService {
  private readonly logger: ILogger;
  private readonly clock: IClock;
  private readonly probes: HealthProbes;
  private readonly accounts: IAccountRepository;
  private readonly probeTimeoutMs: number;

  constructor(deps: StatusServiceDependencies) {
    this.logger = deps.logger.child({ component: 'StatusService' });
    this.clock = deps.clock;
    this.probes = deps.probes;
    this.accounts = deps.repos.accounts;
    this.probeTimeoutMs = Math.max(1, deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  }

  async snapshot(): Promise<SystemStatusSnapshot> {
    const startedAt = Date.now();
    const checkedAt = this.clock.now();

    // `probe` never rejects, so `Promise.all` always resolves.
    const [database, redis, storage] = await Promise.all([
      this.probe('database', this.probes.database),
      this.probe('redis', this.probes.redis),
      this.probe('storage', this.probes.storage),
    ]);
    const channels = await this.channels(checkedAt);

    const services: SystemStatusService[] = [
      // The API answered this very request: operational by construction. The
      // latency is the real duration of the whole check.
      { name: 'api', status: 'operational', latencyMs: Math.max(0, Date.now() - startedAt) },
      database,
      redis,
      storage,
    ];

    return {
      status: overallStatus(services, channels),
      checkedAt: this.clock.now().toISOString(),
      services,
      channels,
    };
  }

  /* ==================================================================== */
  /* Probes                                                               */
  /* ==================================================================== */

  private async probe(
    name: 'database' | 'redis' | 'storage',
    probe: () => Promise<void>,
  ): Promise<SystemStatusService> {
    const startedAt = Date.now();
    try {
      await withTimeout(probe(), this.probeTimeoutMs, `${name} probe`);
      return { name, status: 'operational', latencyMs: Math.max(0, Date.now() - startedAt) };
    } catch (error) {
      // No detail in the payload: connection strings and provider messages are
      // not safe for an anonymous endpoint.
      this.logger.warn('status.probe_failed', {
        probe: name,
        error: error instanceof Error ? error.message.slice(0, 300) : 'probe failed',
      });
      return { name, status: 'down', latencyMs: Math.max(0, Date.now() - startedAt) };
    }
  }

  /* ==================================================================== */
  /* Channels (aggregated, no PII)                                        */
  /* ==================================================================== */

  private async channels(now: Date): Promise<SystemStatusChannel[]> {
    let accounts: MarketplaceAccountRecord[];
    try {
      accounts = await this.accounts.list();
    } catch (error) {
      // The database probe already reports the root cause; the page must still
      // render the service section instead of failing as a whole.
      this.logger.warn('status.channels_failed', {
        error: error instanceof Error ? error.message.slice(0, 300) : String(error),
      });
      return [];
    }

    const byMarketplace = new Map<
      Marketplace,
      { accounts: number; healthy: number; lastErrorAt: Date | null }
    >();

    for (const account of accounts) {
      let entry = byMarketplace.get(account.marketplace);
      if (entry === undefined) {
        entry = { accounts: 0, healthy: 0, lastErrorAt: null };
        byMarketplace.set(account.marketplace, entry);
      }

      entry.accounts += 1;
      if (isHealthyAccount(account, now)) entry.healthy += 1;
      if (account.lastErrorAt !== null) {
        if (entry.lastErrorAt === null || account.lastErrorAt > entry.lastErrorAt) {
          entry.lastErrorAt = account.lastErrorAt;
        }
      }
    }

    return [...byMarketplace.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([marketplace, entry]) => ({
        marketplace,
        accounts: entry.accounts,
        healthy: entry.healthy,
        lastErrorAt: entry.lastErrorAt?.toISOString() ?? null,
      }));
  }
}

/* ---------------------------------------------------------------------- */
/* Helpers                                                                */
/* ---------------------------------------------------------------------- */

/**
 * Aggregate level of the snapshot. Only `database`/`redis` make the platform
 * `down`: without them the API cannot serve support work. A missing storage or
 * a partially unhealthy channel is a `degraded` operation, not an outage.
 */
export function overallStatus(
  services: readonly SystemStatusService[],
  channels: readonly SystemStatusChannel[],
): SystemStatusLevel {
  const isDown = (name: SystemStatusService['name']): boolean =>
    services.some((service) => service.name === name && service.status === 'down');

  if (isDown('database') || isDown('redis')) return 'down';
  if (isDown('storage')) return 'degraded';
  if (channels.some((channel) => channel.healthy < channel.accounts)) return 'degraded';
  return 'operational';
}

/**
 * Healthy from stored state only (no live marketplace call):
 *  - the account is `ACTIVE`;
 *  - at least one credential is stored;
 *  - no error was recorded in the last 30 minutes.
 *
 * An expired access token alone is not "unhealthy": token refresh is automatic
 * and counting it would keep the public page degraded most of the day.
 */
export function isHealthyAccount(account: MarketplaceAccountRecord, now: Date): boolean {
  if (account.status !== 'ACTIVE') return false;
  const hasCredentials =
    isNonEmpty(account.accessTokenEnc) || isNonEmpty(account.refreshTokenEnc);
  if (!hasCredentials) return false;
  if (account.lastErrorAt !== null && now.getTime() - account.lastErrorAt.getTime() < ERROR_GRACE_MS) {
    return false;
  }
  return true;
}

function isNonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref: () => void }).unref();
    }
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
