import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  BillingCheckoutResult,
  BillingEventAuditRecord,
  BillingEventListResult,
  BillingEventSummary,
  BillingStatus,
  BillingWebhookCommand,
  BillingWebhookResult,
  BillingWebhookType,
  IBillingEventRepository,
  IBillingService,
  IClock,
  ILogger,
  IPlatformTenantRepository,
  ITenantRepository,
  TenantPlan,
  TenantRecord,
  TenantSubscriptionPatch,
} from '@sac/shared';
import {
  BILLING_EVENTS_DEFAULT_LIMIT,
  BILLING_EVENTS_MAX_LIMIT,
  BILLING_WEBHOOK_TYPES,
  BillingNotConfiguredError,
  ConflictError,
  NotFoundError,
  PLAN_LIMITS,
  SignatureVerificationError,
  ValidationError,
  isBillingWebhookType,
  isTenantActive,
  isTenantPlan,
  nextBillingStatus,
} from '@sac/shared';

/**
 * ============================================================================
 * BillingService - provider-agnostic payment gateway contract (Fase 4)
 * ============================================================================
 *
 * The API never calls a gateway. It exposes two contract surfaces:
 *
 *  - `handleWebhook`: the gateway (or an adapter in front of it) POSTs a
 *    NORMALIZED payload signed with HMAC SHA-256 of the raw body. The service
 *    verifies the signature, applies the subscription state machine to
 *    `tenants.billing_status` and records the event in `webhook_events` for
 *    idempotency/audit (`marketplace = BILLING`, `event_id = billing:<externalId>`).
 *  - `checkout`: the console asks for a hosted checkout URL. It is built from
 *    `BILLING_CHECKOUT_URL_TEMPLATE` with `{tenantId}`, `{slug}`, `{plan}`,
 *    `{email}`, `{successUrl}` and `{cancelUrl}`; no HTTP request leaves the API.
 *
 * Idempotency contract: a replayed `externalId` answers 200 with
 * `duplicate: true` and never re-applies the transition. The one exception is a
 * previous attempt recorded as FAILED: the retry reuses the audit row and tries
 * again instead of being treated as a duplicate.
 */

export interface BillingRuntimeConfig {
  /** HMAC key of the gateway webhook; absent -> 503 BILLING_NOT_CONFIGURED. */
  webhookSecret?: string;
  /** Provider hosted-checkout template; absent -> 503 on checkout. */
  checkoutUrlTemplate?: string;
  /** Where the gateway returns after a successful payment. */
  successUrl?: string;
  /** Where the gateway returns after a canceled payment. */
  cancelUrl?: string;
}

export interface BillingServiceDependencies {
  logger: ILogger;
  clock: IClock;
  billing: BillingRuntimeConfig;
  repos: {
    tenants: ITenantRepository;
    platformTenants: IPlatformTenantRepository;
    billingEvents: IBillingEventRepository;
  };
}

/** Longest `externalId` that still fits `billing:<id>` in `event_id` (255). */
const MAX_EXTERNAL_ID_LENGTH = 240;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Payload normalized before reaching the API (dates already coerced). */
export interface NormalizedBillingPayload {
  type: BillingWebhookType;
  tenantId?: string;
  tenantSlug?: string;
  plan?: TenantPlan;
  currentPeriodEnd?: Date;
  amountBrl?: number;
  externalId?: string;
}

export class BillingService implements IBillingService {
  private readonly logger: ILogger;
  private readonly clock: IClock;
  private readonly billing: BillingRuntimeConfig;
  private readonly tenants: ITenantRepository;
  private readonly platformTenants: IPlatformTenantRepository;
  private readonly billingEvents: IBillingEventRepository;

  constructor(deps: BillingServiceDependencies) {
    this.logger = deps.logger.child({ component: 'BillingService' });
    this.clock = deps.clock;
    this.billing = deps.billing;
    this.tenants = deps.repos.tenants;
    this.platformTenants = deps.repos.platformTenants;
    this.billingEvents = deps.repos.billingEvents;
  }

  /* ==================================================================== */
  /* Gateway webhook                                                      */
  /* ==================================================================== */

  async handleWebhook(command: BillingWebhookCommand): Promise<BillingWebhookResult> {
    // 1. Configuration gate: an unconfigured deployment must fail loudly (503)
    //    instead of accepting unauthenticated subscription changes.
    const secret = this.billing.webhookSecret;
    if (secret === undefined || secret.length === 0) {
      this.logger.warn('billing.webhook.not_configured', {
        missing: ['BILLING_WEBHOOK_SECRET'],
      });
      throw new BillingNotConfiguredError(
        ['BILLING_WEBHOOK_SECRET'],
        'Set BILLING_WEBHOOK_SECRET to the shared HMAC secret configured in the payment gateway.',
      );
    }

    // 2. Signature over the EXACT raw bytes (never the re-serialized JSON).
    this.assertSignature(command.rawBody, command.signature, secret);

    // 3. Normalized payload validation (after the signature: a forged request
    //    must be rejected as 401 before it can probe the payload schema).
    const payload = parseBillingPayload(command.body);
    const receivedAt = this.clock.now();

    // 4. Tenant resolution: id wins; a slug is accepted for gateways that only
    //    know the workspace identifier. The workspace must be usable.
    const tenant = await this.resolveTenant(payload);

    this.logger.info('billing.webhook.received', {
      type: payload.type,
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      plan: payload.plan ?? null,
      amountBrl: payload.amountBrl ?? null,
      externalId: payload.externalId ?? null,
      receivedAt: receivedAt.toISOString(),
    });

    const externalId = payload.externalId ?? null;
    const eventId = externalId !== null ? `billing:${externalId}` : null;

    // 5. Idempotency: an event already handled (or currently being handled) is
    //    acknowledged with 200 and skipped. A FAILED row is eligible for retry.
    const existing = eventId !== null ? await this.billingEvents.findByEventId(eventId) : null;
    if (existing !== null && existing.tenantId !== null && existing.tenantId !== tenant.id) {
      // The unique key is global per gateway: reusing an externalId for another
      // workspace is a configuration error, never a silent cross-tenant write.
      this.logger.warn('billing.webhook.event_tenant_mismatch', {
        eventId,
        eventTenantId: existing.tenantId,
        tenantId: tenant.id,
      });
      throw new ConflictError('Billing event belongs to another workspace', {
        code: 'BILLING_EVENT_TENANT_MISMATCH',
        eventId,
      });
    }
    if (existing !== null && existing.status !== 'FAILED') {
      return this.duplicateResult(existing, tenant, payload, eventId);
    }

    let record: BillingEventAuditRecord | null = existing;
    if (record === null) {
      const recorded = await this.billingEvents.record({
        eventId,
        tenantId: tenant.id,
        type: payload.type,
        payload: serializePayload(payload),
        error: null,
      });
      record = recorded.record;

      // Two concurrent deliveries of the same externalId: the unique index made
      // one of them lose the insert race. Treat it as a duplicate.
      if (!recorded.created && record.status !== 'FAILED') {
        return this.duplicateResult(record, tenant, payload, eventId);
      }
    }

    // 6. Apply the state machine, then close the audit row.
    try {
      const { updated, previous } = await this.applySubscription(tenant, payload);
      await this.markStatus(record.id, 'PROCESSED');

      this.logger.info('billing.webhook.processed', {
        type: payload.type,
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        eventId,
        previousBillingStatus: previous,
        billingStatus: updated.billingStatus,
        plan: updated.plan,
        amountBrl: payload.amountBrl ?? null,
        currentPeriodEnd: payload.currentPeriodEnd?.toISOString() ?? null,
      });

      return {
        type: payload.type,
        eventId,
        tenantId: tenant.id,
        duplicate: false,
        previousBillingStatus: previous,
        billingStatus: updated.billingStatus,
        currentPeriodEnd: payload.currentPeriodEnd?.toISOString() ?? null,
      };
    } catch (error) {
      await this.markStatus(record.id, 'FAILED', errorMessage(error));
      this.logger.error('billing.webhook.failed', {
        type: payload.type,
        tenantId: tenant.id,
        eventId,
        error: errorMessage(error),
      });
      throw error;
    }
  }

  /* ==================================================================== */
  /* Hosted checkout (no external call)                                   */
  /* ==================================================================== */

  async checkout(tenantId: string): Promise<BillingCheckoutResult> {
    const template = this.billing.checkoutUrlTemplate?.trim();
    if (template === undefined || template.length === 0) {
      this.logger.warn('billing.checkout.not_configured', {
        missing: ['BILLING_CHECKOUT_URL_TEMPLATE'],
      });
      throw new BillingNotConfiguredError(
        ['BILLING_CHECKOUT_URL_TEMPLATE'],
        'Set BILLING_CHECKOUT_URL_TEMPLATE (and BILLING_SUCCESS_URL / BILLING_CANCEL_URL) to the hosted checkout URL of the payment provider.',
      );
    }

    const tenant = await this.tenants.findById(tenantId);
    if (tenant === null) throw new NotFoundError('Tenant', tenantId);
    if (tenant.deletedAt !== null || tenant.status === 'DELETED') {
      throw new ConflictError('Deleted workspaces cannot start a checkout', {
        code: 'TENANT_DELETED',
        tenantId,
      });
    }

    const values: Record<string, string> = {
      tenantId: tenant.id,
      slug: tenant.slug,
      plan: tenant.plan,
      email: tenant.billingEmail ?? '',
      successUrl: this.billing.successUrl ?? '',
      cancelUrl: this.billing.cancelUrl ?? '',
    };

    let checkoutUrl = template;
    for (const [key, value] of Object.entries(values)) {
      checkoutUrl = checkoutUrl.split(`{${key}}`).join(encodeURIComponent(value));
    }

    // A broken template is a deployment error, not a client error: fail with the
    // same stable 503 the missing template produces.
    let parsed: URL;
    try {
      parsed = new URL(checkoutUrl);
    } catch {
      throw new BillingNotConfiguredError(
        ['BILLING_CHECKOUT_URL_TEMPLATE'],
        'BILLING_CHECKOUT_URL_TEMPLATE must render an absolute http(s) URL after placeholder substitution.',
      );
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new BillingNotConfiguredError(
        ['BILLING_CHECKOUT_URL_TEMPLATE'],
        'BILLING_CHECKOUT_URL_TEMPLATE must render an absolute http(s) URL after placeholder substitution.',
      );
    }

    this.logger.info('billing.checkout.created', {
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      plan: tenant.plan,
      hasBillingEmail: tenant.billingEmail !== null,
    });

    return { checkoutUrl };
  }

  /* ==================================================================== */
  /* Audit listing                                                        */
  /* ==================================================================== */

  async listEvents(limit = BILLING_EVENTS_DEFAULT_LIMIT): Promise<BillingEventListResult> {
    const safeLimit = clampLimit(limit);
    const records = await this.billingEvents.listRecent(safeLimit);
    const items: BillingEventSummary[] = records.map((record) => ({
      id: record.id,
      type: record.type,
      tenantId: record.tenantId,
      tenantSlug: record.tenantSlug,
      status: record.status,
      receivedAt: record.receivedAt.toISOString(),
    }));
    return { items, limit: safeLimit };
  }

  /* ==================================================================== */
  /* Internals                                                            */
  /* ==================================================================== */

  private assertSignature(
    rawBody: Buffer,
    signature: string | null | undefined,
    secret: string,
  ): void {
    const provided = normalizeSignature(signature);
    if (provided === null) {
      this.logger.warn('billing.webhook.invalid_signature', { reason: 'MISSING_SIGNATURE' });
      throw new SignatureVerificationError('BILLING', 'missing x-billing-signature header');
    }

    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    if (!constantTimeEqual(expected, provided)) {
      this.logger.warn('billing.webhook.invalid_signature', { reason: 'SIGNATURE_MISMATCH' });
      throw new SignatureVerificationError('BILLING', 'HMAC SHA-256 signature mismatch');
    }
  }

  private async resolveTenant(payload: NormalizedBillingPayload): Promise<TenantRecord> {
    let tenant: TenantRecord | null = null;
    if (payload.tenantId !== undefined) {
      tenant = await this.tenants.findById(payload.tenantId);
      if (tenant !== null && payload.tenantSlug !== undefined && tenant.slug !== payload.tenantSlug) {
        throw new ValidationError('tenantId and tenantSlug refer to different workspaces', {
          tenantId: payload.tenantId,
          tenantSlug: payload.tenantSlug,
        });
      }
    }
    if (tenant === null && payload.tenantSlug !== undefined) {
      tenant = await this.tenants.findBySlug(payload.tenantSlug);
    }

    if (tenant === null) {
      this.logger.warn('billing.webhook.unknown_tenant', {
        tenantId: payload.tenantId ?? null,
        tenantSlug: payload.tenantSlug ?? null,
      });
      throw new NotFoundError('Tenant', payload.tenantId ?? payload.tenantSlug);
    }

    if (!isTenantActive(tenant)) {
      this.logger.warn('billing.webhook.inactive_tenant', {
        tenantId: tenant.id,
        status: tenant.status,
        deletedAt: tenant.deletedAt?.toISOString() ?? null,
      });
      throw new ConflictError('Billing events cannot be applied to an inactive workspace', {
        code: 'TENANT_INACTIVE',
        status: tenant.status,
        tenantId: tenant.id,
      });
    }

    return tenant;
  }

  private async applySubscription(
    tenant: TenantRecord,
    payload: NormalizedBillingPayload,
  ): Promise<{ updated: TenantRecord; previous: BillingStatus }> {
    const previous = tenant.billingStatus;
    const target = nextBillingStatus(payload.type, previous);

    const patch: TenantSubscriptionPatch = {};
    if (target !== undefined && target !== previous) patch.billingStatus = target;

    // A plan change realigns the quotas to the plan defaults, exactly like the
    // console's `PATCH /platform/tenants/:id`; custom quotas survive events that
    // do not change the plan.
    if (payload.plan !== undefined && payload.plan !== tenant.plan) {
      const limits = PLAN_LIMITS[payload.plan];
      patch.plan = payload.plan;
      patch.maxAccounts = limits.maxAccounts;
      patch.maxAgents = limits.maxAgents;
    }

    if (Object.keys(patch).length === 0) {
      return { updated: tenant, previous };
    }
    const updated = await this.platformTenants.applySubscription(tenant.id, patch);
    return { updated, previous };
  }

  private duplicateResult(
    record: BillingEventAuditRecord,
    tenant: TenantRecord,
    payload: NormalizedBillingPayload,
    eventId: string | null,
  ): BillingWebhookResult {
    this.logger.info('billing.webhook.duplicate', {
      type: payload.type,
      tenantId: tenant.id,
      eventId,
      existingStatus: record.status,
      existingReceivedAt: record.receivedAt.toISOString(),
    });

    return {
      type: record.type ?? payload.type,
      eventId,
      tenantId: tenant.id,
      duplicate: true,
      previousBillingStatus: tenant.billingStatus,
      billingStatus: tenant.billingStatus,
      currentPeriodEnd: payload.currentPeriodEnd?.toISOString() ?? null,
    };
  }

  private async markStatus(
    id: string,
    status: 'PROCESSED' | 'FAILED',
    error?: string,
  ): Promise<void> {
    try {
      await this.billingEvents.markStatus(id, status, {
        error: error ?? null,
        processedAt: this.clock.now(),
      });
    } catch (markError) {
      // The business transition must not be undone by an audit-write hiccup.
      this.logger.error('billing.webhook.audit_status_failed', {
        webhookEventId: id,
        status,
        error: errorMessage(markError),
      });
    }
  }
}

/* ====================================================================== */
/* Payload normalization + helpers                                        */
/* ====================================================================== */

/**
 * Validates the NORMALIZED gateway payload.
 *
 * Deliberately hand-written (no zod) so the application layer stays free of
 * transport/schema dependencies; the HTTP layer only forwards `request.body`.
 */
export function parseBillingPayload(body: unknown): NormalizedBillingPayload {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError('Billing webhook body must be a JSON object');
  }

  const raw = body as Record<string, unknown>;
  if (!isBillingWebhookType(raw.type)) {
    throw new ValidationError('Billing webhook type is invalid', {
      field: 'type',
      allowed: [...BILLING_WEBHOOK_TYPES],
    });
  }

  const tenantId = nonEmptyString(raw.tenantId);
  const tenantSlug = nonEmptyString(raw.tenantSlug);
  if (tenantId === undefined && tenantSlug === undefined) {
    throw new ValidationError('Billing webhook requires tenantId or tenantSlug');
  }
  if (tenantId !== undefined && !UUID_PATTERN.test(tenantId)) {
    throw new ValidationError('tenantId must be a UUID', { field: 'tenantId' });
  }
  if (tenantSlug !== undefined && tenantSlug.length > 80) {
    throw new ValidationError('tenantSlug must be at most 80 characters', { field: 'tenantSlug' });
  }

  let plan: TenantPlan | undefined;
  if (raw.plan !== undefined && raw.plan !== null) {
    if (!isTenantPlan(raw.plan)) {
      throw new ValidationError('plan is invalid', { field: 'plan' });
    }
    plan = raw.plan;
  }

  let currentPeriodEnd: Date | undefined;
  if (raw.currentPeriodEnd !== undefined && raw.currentPeriodEnd !== null) {
    currentPeriodEnd = toDate(raw.currentPeriodEnd);
    if (currentPeriodEnd === undefined) {
      throw new ValidationError('currentPeriodEnd must be a valid ISO-8601 date', {
        field: 'currentPeriodEnd',
      });
    }
  }

  let amountBrl: number | undefined;
  if (raw.amountBrl !== undefined && raw.amountBrl !== null) {
    if (typeof raw.amountBrl !== 'number' || !Number.isFinite(raw.amountBrl) || raw.amountBrl < 0) {
      throw new ValidationError('amountBrl must be a non-negative number', { field: 'amountBrl' });
    }
    amountBrl = raw.amountBrl;
  }

  const externalId = nonEmptyString(raw.externalId);
  if (externalId !== undefined && externalId.length > MAX_EXTERNAL_ID_LENGTH) {
    throw new ValidationError(
      `externalId must be at most ${MAX_EXTERNAL_ID_LENGTH} characters`,
      { field: 'externalId' },
    );
  }

  return {
    type: raw.type,
    ...(tenantId !== undefined ? { tenantId } : {}),
    ...(tenantSlug !== undefined ? { tenantSlug } : {}),
    ...(plan !== undefined ? { plan } : {}),
    ...(currentPeriodEnd !== undefined ? { currentPeriodEnd } : {}),
    ...(amountBrl !== undefined ? { amountBrl } : {}),
    ...(externalId !== undefined ? { externalId } : {}),
  };
}

function serializePayload(payload: NormalizedBillingPayload): Record<string, unknown> {
  return {
    type: payload.type,
    tenantId: payload.tenantId ?? null,
    tenantSlug: payload.tenantSlug ?? null,
    plan: payload.plan ?? null,
    currentPeriodEnd: payload.currentPeriodEnd?.toISOString() ?? null,
    amountBrl: payload.amountBrl ?? null,
    externalId: payload.externalId ?? null,
  };
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toDate(value: unknown): Date | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  return undefined;
}

/** Accepts `sha256=<hex>` (GitHub-style) or the bare hex digest. */
function normalizeSignature(signature: string | null | undefined): string | null {
  if (typeof signature !== 'string') return null;
  const value = signature.trim().toLowerCase();
  if (value.length === 0) return null;
  const hex = value.startsWith('sha256=') ? value.slice('sha256='.length) : value;
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

function constantTimeEqual(expected: string, provided: string): boolean {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(provided, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return BILLING_EVENTS_DEFAULT_LIMIT;
  return Math.min(BILLING_EVENTS_MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 300 ? message : `${message.slice(0, 299)}…`;
}

export { normalizeSignature, serializePayload };
