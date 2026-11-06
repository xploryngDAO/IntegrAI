/**
 * Typed application errors shared by the HTTP layer, workers and adapters.
 * `code` is a stable machine string used by the UI and by DLQ triage.
 */

import type { TenantPlan } from './plans';

export type AppErrorDetails = Record<string, unknown> | undefined;

export class AppError extends Error {
  public readonly code: string;
  public readonly httpStatus: number;
  public readonly details: AppErrorDetails;
  public readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    httpStatus = 500,
    details?: AppErrorDetails,
    retryable = false,
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
    this.retryable = retryable;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: AppErrorDetails) {
    super('VALIDATION_ERROR', message, 422, details);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super('NOT_FOUND', `${resource} not found${id ? `: ${id}` : ''}`, 404, { resource, id });
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Authentication required') {
    super('AUTHENTICATION_ERROR', message, 401);
  }
}

export class AuthorizationError extends AppError {
  constructor(message = 'Insufficient permissions') {
    super('AUTHORIZATION_ERROR', message, 403);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: AppErrorDetails) {
    super('CONFLICT', message, 409, details);
  }
}

/**
 * Plan quota exhausted (Fase 4).
 *
 * `409` (the request is valid, the workspace just has no room left) with the
 * exact numbers the UI needs to render an upgrade prompt:
 * `details = { limit, current, plan, resource }`.
 */
export class PlanLimitReachedError extends AppError {
  constructor(input: {
    plan: TenantPlan;
    limit: number;
    current: number;
    resource: 'agents' | 'accounts';
  }) {
    super(
      'PLAN_LIMIT_REACHED',
      `Plan ${input.plan} allows ${input.limit} ${input.resource} but the workspace already uses ${input.current}`,
      409,
      {
        plan: input.plan,
        limit: input.limit,
        current: input.current,
        resource: input.resource,
      },
    );
  }
}

/**
 * The authenticated operator belongs to a suspended/soft-deleted workspace.
 * `403` (the identity is valid, the workspace is not) with a stable code so the
 * SPA can show the "workspace unavailable" screen instead of a login loop.
 */
export class TenantInactiveError extends AppError {
  constructor(status: string, tenantId?: string | null) {
    super('TENANT_INACTIVE', `Workspace is ${status.toLowerCase()} and cannot be used`, 403, {
      status,
      tenantId: tenantId ?? null,
    });
  }
}

/**
 * Amazon SP-API OAuth prerequisite missing (Fase 2).
 *
 * `409` (not `500`) because the API is healthy and the operator can fix it by
 * setting the listed environment variables; `details.missing` and
 * `details.remediation` are rendered verbatim by the accounts UI.
 */
export class AmazonOAuthNotConfiguredError extends AppError {
  constructor(missing: string[], remediation: string) {
    super(
      'AMAZON_OAUTH_NOT_CONFIGURED',
      `Amazon OAuth is not configured (missing: ${missing.join(', ')}). ${remediation}`,
      409,
      { provider: 'AMAZON', missing, remediation },
    );
  }
}

export class PolicyViolationError extends AppError {
  public readonly violations: Array<{ code: string; message: string; match?: string }>;

  constructor(
    violations: Array<{ code: string; message: string; match?: string }>,
    marketplace: string,
  ) {
    super(
      'POLICY_VIOLATION',
      `Outbound message blocked by ${marketplace} policy: ${violations.map((v) => v.code).join(', ')}`,
      422,
      { violations, marketplace },
    );
    this.violations = violations;
  }
}

export class RateLimitError extends AppError {
  constructor(bucket: string, retryAfterMs?: number) {
    super('RATE_LIMITED', `Rate limit hit for bucket ${bucket}`, 429, { bucket, retryAfterMs }, true);
  }
}

export class MarketplaceApiError extends AppError {
  public readonly marketplace: string;
  public readonly status: number;
  public readonly payload: unknown;

  constructor(
    marketplace: string,
    status: number,
    message: string,
    payload?: unknown,
    retryable = status >= 500 || status === 429,
  ) {
    super('MARKETPLACE_API_ERROR', `[${marketplace}] ${message}`, 502, { marketplace, status }, retryable);
    this.marketplace = marketplace;
    this.status = status;
    this.payload = payload;
  }
}

export class TokenRefreshError extends AppError {
  constructor(marketplace: string, message: string, details?: AppErrorDetails) {
    super('TOKEN_REFRESH_ERROR', `[${marketplace}] ${message}`, 502, details, false);
  }
}

export class SignatureVerificationError extends AppError {
  constructor(marketplace: string, reason: string) {
    super('INVALID_SIGNATURE', `[${marketplace}] ${reason}`, 401, { reason });
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;
  if (error instanceof Error) {
    return new AppError('INTERNAL_ERROR', error.message, 500, { stack: error.stack });
  }
  return new AppError('INTERNAL_ERROR', 'Unknown error', 500, { error: String(error) });
}
