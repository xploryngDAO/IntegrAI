import type { FastifyInstance } from 'fastify';

/**
 * ============================================================================
 * In-process Prometheus registry (no dependency)
 * ============================================================================
 *
 * A deliberately tiny, allocation-bounded metrics store:
 *
 *  - `sac_http_requests_total{method,status_class}` - a Map keyed by the
 *    normalized method (8 known verbs + `OTHER`) and the response class
 *    (`1xx`..`5xx` + `other`), so the cardinality is capped at 63 series no
 *    matter how much traffic or how many URLs the process sees;
 *  - `sac_http_request_duration_seconds` - one histogram with the Prometheus
 *    default buckets (global, unlabeled: the per-request `sum`/`count` is what
 *    the latency alerts use);
 *  - `sac_process_uptime_seconds` - read from `process.uptime()` at scrape time;
 *  - `sac_db_up` / `sac_redis_up` / `sac_storage_up` - gauges written by the
 *    latest `GET /health/ready` probe (the readiness endpoint is what knows the
 *    dependency state; scraping must stay cheap and synchronous).
 *
 * The registry is per HTTP application instance (created in `buildHttpApp`), so
 * tests never share counters and a restart resets them - Prometheus handles
 * counter resets natively with `rate()`.
 */

/** Prometheus' default latency buckets, in seconds. */
export const HTTP_DURATION_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
] as const;

/** Verbs kept as-is; anything else collapses into `OTHER` (bounded labels). */
const KNOWN_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'TRACE',
]);

const KNOWN_STATUS_CLASSES: ReadonlySet<string> = new Set(['1xx', '2xx', '3xx', '4xx', '5xx']);

export type DependencyName = 'db' | 'redis' | 'storage';

const DEPENDENCIES: readonly DependencyName[] = ['db', 'redis', 'storage'];

interface HistogramState {
  /** Cumulative counts: `counts[i]` is the number of observations <= bucket i. */
  readonly counts: number[];
  sum: number;
  count: number;
}

/** Maps an arbitrary HTTP verb to one of the bounded label values. */
export function normalizeHttpMethod(method: string): string {
  const upper = method.trim().toUpperCase();
  return KNOWN_METHODS.has(upper) ? upper : 'OTHER';
}

/** Maps a status code to its Prometheus class label (`2xx`, `4xx`, ...). */
export function statusClassOf(statusCode: number): string {
  if (!Number.isFinite(statusCode)) return 'other';
  const value = Math.trunc(statusCode);
  if (value < 100 || value > 599) return 'other';
  const label = `${Math.floor(value / 100)}xx`;
  return KNOWN_STATUS_CLASSES.has(label) ? label : 'other';
}

/** Escapes a Prometheus label value (double quotes / backslash / newline). */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Fixed notation (no exponent) with enough precision for milliseconds. */
function formatNumber(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return '0';
  const normalized = value < 0 ? 0 : value;
  return normalized.toFixed(decimals);
}

export class MetricsRegistry {
  private readonly requestCounts = new Map<string, number>();
  private readonly duration: HistogramState = {
    counts: HTTP_DURATION_BUCKETS_SECONDS.map(() => 0),
    sum: 0,
    count: 0,
  };
  private readonly dependencies = new Map<DependencyName, boolean>();

  /** Records one finished HTTP request (called from the `onResponse` hook). */
  recordRequest(method: string, statusCode: number, durationMs: number): void {
    const key = `${normalizeHttpMethod(method)}|${statusClassOf(statusCode)}`;
    this.requestCounts.set(key, (this.requestCounts.get(key) ?? 0) + 1);

    const seconds = Number.isFinite(durationMs) && durationMs > 0 ? durationMs / 1_000 : 0;
    for (let index = 0; index < HTTP_DURATION_BUCKETS_SECONDS.length; index += 1) {
      const bound = HTTP_DURATION_BUCKETS_SECONDS[index];
      if (bound !== undefined && seconds <= bound) this.duration.counts[index] += 1;
    }
    this.duration.sum += seconds;
    this.duration.count += 1;
  }

  /** Records the latest readiness result for a dependency (1 = up, 0 = down). */
  setDependencyUp(name: DependencyName, up: boolean): void {
    this.dependencies.set(name, up);
  }

  /** Test helper: forget every observation. */
  reset(): void {
    this.requestCounts.clear();
    this.duration.counts.fill(0);
    this.duration.sum = 0;
    this.duration.count = 0;
    this.dependencies.clear();
  }

  /**
   * Renders the whole exposition in Prometheus text format (version 0.0.4).
   * Deterministic ordering keeps scrapes diff-friendly.
   */
  render(now: number = Date.now()): string {
    const lines: string[] = [];

    lines.push('# HELP sac_http_requests_total Total HTTP requests handled since process start.');
    lines.push('# TYPE sac_http_requests_total counter');
    for (const key of [...this.requestCounts.keys()].sort()) {
      const [method = 'OTHER', statusClass = 'other'] = key.split('|');
      const value = this.requestCounts.get(key) ?? 0;
      lines.push(
        `sac_http_requests_total{method="${escapeLabelValue(method)}",status_class="${escapeLabelValue(
          statusClass,
        )}"} ${value}`,
      );
    }

    lines.push(
      '# HELP sac_http_request_duration_seconds HTTP request duration in seconds.',
    );
    lines.push('# TYPE sac_http_request_duration_seconds histogram');
    for (let index = 0; index < HTTP_DURATION_BUCKETS_SECONDS.length; index += 1) {
      const bound = HTTP_DURATION_BUCKETS_SECONDS[index];
      if (bound === undefined) continue;
      lines.push(
        `sac_http_request_duration_seconds_bucket{le="${String(bound)}"} ${
          this.duration.counts[index] ?? 0
        }`,
      );
    }
    lines.push(
      `sac_http_request_duration_seconds_bucket{le="+Inf"} ${this.duration.count}`,
    );
    lines.push(
      `sac_http_request_duration_seconds_sum ${formatNumber(this.duration.sum, 6)}`,
    );
    lines.push(`sac_http_request_duration_seconds_count ${this.duration.count}`);

    const uptimeSeconds = typeof process.uptime === 'function' ? process.uptime() : 0;
    lines.push('# HELP sac_process_uptime_seconds Process uptime in seconds.');
    lines.push('# TYPE sac_process_uptime_seconds gauge');
    lines.push(`sac_process_uptime_seconds ${formatNumber(uptimeSeconds, 3)}`);

    for (const dependency of DEPENDENCIES) {
      const up = this.dependencies.get(dependency) === true;
      const help =
        dependency === 'db'
          ? 'Last database readiness probe (1 = up, 0 = down/not probed yet).'
          : dependency === 'redis'
            ? 'Last Redis readiness probe (1 = up, 0 = down/not probed yet).'
            : 'Last object-storage readiness probe (1 = up, 0 = down/not probed yet).';
      lines.push(`# HELP sac_${dependency}_up ${help}`);
      lines.push(`# TYPE sac_${dependency}_up gauge`);
      lines.push(`sac_${dependency}_up ${up ? 1 : 0}`);
    }

    // Trailing newline: Prometheus' text parser accepts either, but the final
    // newline is what every official client emits.
    return `${lines.join('\n')}\n`;
  }
}

/**
 * Wires request observation into the application.
 *
 * `onResponse` fires for every reply (200, 401, 429, 500, 404), and
 * `reply.elapsedTime` is Fastify's own wall-clock measurement, so no extra
 * per-request timer/decoration is needed.
 */
export function registerHttpMetrics(app: FastifyInstance, registry: MetricsRegistry): void {
  app.addHook('onResponse', async (request, reply) => {
    registry.recordRequest(request.method, reply.statusCode, reply.elapsedTime);
  });
}
