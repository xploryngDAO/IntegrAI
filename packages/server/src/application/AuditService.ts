import type {
  AuditEventInput,
  AuditEventRecord,
  AuditEventView,
  AuditListFilter,
  AuditLogPage,
  AuditLogQuery,
  CreateAuditEventInput,
  IAuditEventRepository,
  IAuditService,
  IClock,
  ILogger,
} from '@sac/shared';
import {
  AUDIT_DEFAULT_PER_PAGE,
  AUDIT_MAX_PER_PAGE,
  ValidationError,
  redactPiiForLogs,
} from '@sac/shared';

/**
 * ============================================================================
 * AuditService - best-effort administrative/security trail
 * ============================================================================
 *
 * Two hard rules:
 *
 *  1. `record` NEVER throws and NEVER blocks the caller. The business operation
 *     already succeeded (or already failed with its own error); losing the audit
 *     row is logged as a warning, never surfaced as a 500. Writes run in the
 *     background and `flush()` (tests / graceful shutdown) waits for them.
 *  2. `metadata` is scrubbed BEFORE persisting: password/token/secret/OTP keys
 *     are dropped, nested objects are bounded and e-mail/phone patterns are
 *     redacted with `redactPiiForLogs`. The actor e-mail lives in its own
 *     column because the contract allows it there.
 *
 * `list` is the read side used by `GET /admin/audit-logs`: the tenant always
 * comes from the caller's JWT and the page size is capped at 100.
 */
export class AuditService implements IAuditService {
  private readonly logger: ILogger;
  private readonly repository: IAuditEventRepository;
  private readonly pending = new Set<Promise<void>>();

  constructor(deps: {
    logger: ILogger;
    clock: IClock;
    repo: IAuditEventRepository;
  }) {
    this.logger = deps.logger.child({ component: 'AuditService' });
    this.repository = deps.repo;
  }

  /* ==================================================================== */
  /* Write (best effort)                                                  */
  /* ==================================================================== */

  record(input: AuditEventInput): void {
    try {
      const normalized = normalizeAuditInput(input);
      let tracked: Promise<void>;
      tracked = this.repository
        .create(normalized)
        .catch((error: unknown) => {
          // A broken audit sink must never break the flow that produced the
          // event. Only the action code is logged (the metadata is untrusted).
          this.logger.warn('audit.write_failed', {
            action: normalized.action,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          this.pending.delete(tracked);
        });
      this.pending.add(tracked);
    } catch (error) {
      // Normalization itself is defensive, but `record` is contractually
      // throw-free even if a caller passes a hostile object.
      this.logger.warn('audit.record_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Awaits every queued write. Never rejects (each write already swallows). */
  async flush(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }

  /* ==================================================================== */
  /* Read (paginated + filtered)                                          */
  /* ==================================================================== */

  async list(tenantId: string, query: AuditLogQuery = {}): Promise<AuditLogPage> {
    const page = clampInteger(query.page, 1, Number.MAX_SAFE_INTEGER, 1);
    const perPage = clampInteger(
      query.perPage,
      1,
      AUDIT_MAX_PER_PAGE,
      AUDIT_DEFAULT_PER_PAGE,
    );

    if (
      query.from !== undefined &&
      query.to !== undefined &&
      query.from.getTime() > query.to.getTime()
    ) {
      throw new ValidationError('`from` must be before or equal to `to`', {
        from: query.from.toISOString(),
        to: query.to.toISOString(),
      });
    }

    const filter: AuditListFilter = {
      tenantId,
      offset: (page - 1) * perPage,
      limit: perPage,
    };
    const action = nonEmpty(query.action);
    if (action !== undefined) filter.action = action;
    const actorId = nonEmpty(query.actorId);
    if (actorId !== undefined) filter.actorId = actorId;
    if (query.from !== undefined) filter.from = query.from;
    if (query.to !== undefined) filter.to = query.to;

    const { items, total } = await this.repository.list(filter);
    return {
      items: items.map(toAuditView),
      page,
      perPage,
      total,
    };
  }
}

/* ====================================================================== */
/* Normalization + redaction                                              */
/* ====================================================================== */

const MAX_ACTION_LENGTH = 96;
const MAX_EMAIL_LENGTH = 180;
const MAX_RESOURCE_TYPE_LENGTH = 80;
const MAX_RESOURCE_ID_LENGTH = 180;
const MAX_IP_LENGTH = 64;
const MAX_USER_AGENT_LENGTH = 255;
const MAX_STRING_LENGTH = 400;
const MAX_ARRAY_LENGTH = 50;
const MAX_METADATA_DEPTH = 3;

/**
 * Keys whose VALUE must never be persisted. Matching is case-insensitive and
 * intentionally broad: losing a harmless key is preferable to storing a
 * credential or a one-time code.
 */
const SENSITIVE_KEY_PATTERN =
  /(password|passwd|senha|token|secret|segredo|hash|authorization|credential|otp|totp|recovery|code|cookie|api[-_]?key)/i;

function normalizeAuditInput(input: AuditEventInput): CreateAuditEventInput {
  return {
    action: truncate(input.action, MAX_ACTION_LENGTH) || 'unknown',
    tenantId: nullable(input.tenantId),
    actorId: nullable(input.actorId),
    actorEmail: truncate(input.actorEmail, MAX_EMAIL_LENGTH),
    resourceType: truncate(input.resourceType, MAX_RESOURCE_TYPE_LENGTH),
    resourceId: truncate(input.resourceId, MAX_RESOURCE_ID_LENGTH),
    ip: truncate(input.ip, MAX_IP_LENGTH),
    userAgent: truncate(input.userAgent, MAX_USER_AGENT_LENGTH),
    metadata: sanitizeAuditMetadata(input.metadata),
  };
}

/**
 * Recursively removes sensitive keys and redacts PII from string values.
 * Exported so the redaction rules can be unit-tested without a database.
 */
export function sanitizeAuditMetadata(
  input: unknown,
  depth = 0,
): Record<string, unknown> {
  if (!isPlainObject(input)) return {};

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) continue;
    const clean = sanitizeValue(value, depth + 1);
    if (clean !== undefined) output[key] = clean;
  }
  return output;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    return truncate(redactPiiForLogs(value), MAX_STRING_LENGTH);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_METADATA_DEPTH) return '[truncated]';
    return value
      .slice(0, MAX_ARRAY_LENGTH)
      .map((entry) => sanitizeValue(entry, depth + 1))
      .filter((entry) => entry !== undefined);
  }
  if (isPlainObject(value)) {
    if (depth >= MAX_METADATA_DEPTH) return '[truncated]';
    return sanitizeAuditMetadata(value, depth);
  }
  // Functions, symbols, bigint: nothing safe to serialize.
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toAuditView(record: AuditEventRecord): AuditEventView {
  return {
    id: record.id,
    tenantId: record.tenantId,
    actorId: record.actorId,
    actorEmail: record.actorEmail,
    action: record.action,
    resourceType: record.resourceType,
    resourceId: record.resourceId,
    ip: record.ip,
    userAgent: record.userAgent,
    metadata: record.metadata,
    createdAt: record.createdAt.toISOString(),
  };
}

function nullable(value: string | null | undefined): string | null {
  const normalized = (value ?? '').trim();
  return normalized.length > 0 ? normalized : null;
}

function truncate(value: string | null | undefined, maxLength: number): string | null {
  const normalized = (value ?? '').trim();
  if (normalized.length === 0) return null;
  return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength);
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = (value ?? '').trim();
  return normalized.length > 0 ? normalized : undefined;
}

function clampInteger(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
