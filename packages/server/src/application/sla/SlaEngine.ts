import {
  CACHE_KEYS,
  DEFAULT_QUEUE_BY_MARKETPLACE,
  PRIORITY_BY_TICKET_TYPE,
  PRIORITY_RANK,
  SHOPEE_COMMERCIAL_QUEUE,
  SHOPEE_SPECIALIZED_QUEUE,
  SLA_DEFAULTS,
  TERMINAL_TICKET_STATUSES,
} from '@sac/shared';
import type {
  ICache,
  IClock,
  ILogger,
  IRealtimePublisher,
  ISlaPolicyRepository,
  ITicketRepository,
  Marketplace,
  SlaState,
  SlaPolicyRecord,
  SupportTicketRecord,
  TicketPriority,
  TicketType,
} from '@sac/shared';

/**
 * ============================================================================
 * SLA engine
 * ============================================================================
 *
 * One place that turns "a message arrived on channel X with ticket type Y" into
 * a deadline, an internal target, a priority and an owning queue.
 *
 * Rules implemented (see docs/CHANNEL_CONTRACTS.md and .env.example):
 *  - marketplace/ticket-type defaults come from `SLA_DEFAULTS`;
 *  - an active `sla_policies` row for the account (or the marketplace-wide row
 *    with `accountId = null`) overrides target/warning minutes;
 *  - AMAZON: the buyer-seller messaging corridor is 24h, but our internal target
 *    is 18h and the deadline is capped at 24h;
 *  - SHOPEE: chat conversations are governed by the 12h Chat Response Rate, so
 *    the deadline never exceeds 12h for chat-like ticket types;
 *  - MERCADO_LIVRE claims: the marketplace `due_date` is authoritative and
 *    overrides both the deadline and the target;
 *  - `slaState` is derived from the deadline + the policy warning window;
 *  - `sweep()` flags newly breached tickets and publishes realtime updates.
 *
 * The engine is intentionally unaware of Prisma/Redis — it depends on the
 * repository ports only, so it is trivially unit-testable.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** Hard compliance caps applied on top of the configured target. */
const AMAZON_CORRIDOR_MINUTES = 24 * 60;
const AMAZON_INTERNAL_TARGET_MINUTES = 18 * 60;
const SHOPEE_CRR_MINUTES = 12 * 60;

const DEFAULT_WARNING_MINUTES = 120;
const DEFAULT_SWEEP_LIMIT = 200;

/**
 * Business-hours calendar used when a policy sets `businessHoursOnly`.
 * Brazilian operation: Monday-Friday, 09:00-18:00 America/Sao_Paulo.
 */
const BUSINESS_TIMEZONE = 'America/Sao_Paulo';
const BUSINESS_START_HOUR = 9;
const BUSINESS_END_HOUR = 18;

export interface SlaPlanInput {
  accountId: string;
  marketplace: Marketplace;
  ticketType: TicketType;
  /** Authoritative marketplace clock of the event that started the SLA leg. */
  receivedAt: Date;
  hasActiveClaim?: boolean;
  /** Meli claim `due_date` (authoritative override). */
  claimDueDate?: Date | null;
  /** Adapter hint (`HydratedInboundMessage.priority`). */
  priorityHint?: TicketPriority;
  /** Force a specific queue (adapter triage may know better). */
  queueHint?: string | null;
  metadata?: Record<string, unknown> | null;
}

export type SlaPlanSource =
  | 'POLICY_OVERRIDE'
  | 'CLAIM_DUE_DATE'
  | 'AMAZON_CORRIDOR'
  | 'SHOPEE_CRR'
  | 'MARKETPLACE_DEFAULT';

export interface SlaPlan {
  deadlineAt: Date;
  targetAt: Date;
  warningMinutes: number;
  slaLegMinutes: number;
  priority: TicketPriority;
  queue: string;
  source: SlaPlanSource;
  notes: string[];
}

export interface SlaSnapshot {
  state: SlaState;
  deadlineAt: Date;
  targetAt: Date | null;
  warningMinutes: number;
  remainingMs: number;
  isBreached: boolean;
}

export interface SlaSweepResult {
  scanned: number;
  breached: number;
  atRisk: number;
  recovered: number;
  errors: number;
}

export interface SlaEngineDependencies {
  clock: IClock;
  logger: ILogger;
  realtime: IRealtimePublisher;
  tickets: ITicketRepository;
  slaPolicies: ISlaPolicyRepository;
  /** Optional short-lived cache of resolved policies (avoids N lookups/sweep). */
  cache?: ICache;
}

interface ResolvedPolicy {
  firstResponseMinutes: number;
  targetMinutes: number;
  warningMinutes: number;
  businessHoursOnly: boolean;
  source: 'OVERRIDE' | 'DEFAULT';
}

export class SlaEngine {
  private readonly clock: IClock;
  private readonly logger: ILogger;
  private readonly realtime: IRealtimePublisher;
  private readonly tickets: ITicketRepository;
  private readonly slaPolicies: ISlaPolicyRepository;
  private readonly cache: ICache | null;

  /** Per-instance memo so a sweep does not hit the DB once per ticket. */
  private readonly policyMemo = new Map<string, ResolvedPolicy | null>();

  constructor(deps: SlaEngineDependencies) {
    this.clock = deps.clock;
    this.logger = deps.logger.child({ component: 'SlaEngine' });
    this.realtime = deps.realtime;
    this.tickets = deps.tickets;
    this.slaPolicies = deps.slaPolicies;
    this.cache = deps.cache ?? null;
  }

  /* ------------------------------------------------------------------ */
  /* Policy resolution                                                   */
  /* ------------------------------------------------------------------ */

  private policyMemoKey(accountId: string, marketplace: Marketplace, ticketType: TicketType): string {
    return `${accountId}:${marketplace}:${ticketType}`;
  }

  /**
   * Resolves the effective policy: account override > marketplace override >
   * hardcoded default. The repository is asked for the account-scoped row first
   * and then for the `accountId = null` marketplace-wide row.
   */
  async resolvePolicy(
    accountId: string,
    marketplace: Marketplace,
    ticketType: TicketType,
  ): Promise<ResolvedPolicy> {
    const memoKey = this.policyMemoKey(accountId, marketplace, ticketType);
    const memoized = this.policyMemo.get(memoKey);
    if (memoized) return memoized;

    const defaults = SLA_DEFAULTS[marketplace][ticketType];
    let policy: SlaPolicyRecord | null = null;
    try {
      policy = await this.slaPolicies.find(accountId, marketplace, ticketType);
      if (!policy) policy = await this.slaPolicies.find(null, marketplace, ticketType);
    } catch (error) {
      this.logger.warn('sla.policy_lookup_failed', {
        accountId,
        marketplace,
        ticketType,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const resolved: ResolvedPolicy =
      policy && policy.isActive
        ? {
            firstResponseMinutes: policy.firstResponseMinutes,
            targetMinutes: Math.max(1, policy.targetMinutes),
            warningMinutes: Math.max(0, policy.warningMinutes),
            businessHoursOnly: policy.businessHoursOnly,
            source: 'OVERRIDE',
          }
        : {
            firstResponseMinutes: defaults.targetMinutes,
            targetMinutes: defaults.targetMinutes,
            warningMinutes: defaults.warningMinutes,
            businessHoursOnly: false,
            source: 'DEFAULT',
          };

    this.policyMemo.set(memoKey, resolved);
    return resolved;
  }

  /** Invalidates the per-process memo (used after a policy change). */
  invalidatePolicyCache(): void {
    this.policyMemo.clear();
  }

  /* ------------------------------------------------------------------ */
  /* Deadline computation                                                */
  /* ------------------------------------------------------------------ */

  async computePlan(input: SlaPlanInput): Promise<SlaPlan> {
    const policy = await this.resolvePolicy(input.accountId, input.marketplace, input.ticketType);
    const notes: string[] = [];
    let warningMinutes = policy.warningMinutes;
    let source: SlaPlanSource = policy.source === 'OVERRIDE' ? 'POLICY_OVERRIDE' : 'MARKETPLACE_DEFAULT';
    let deadlineAt: Date;
    let targetAt: Date;

    // The marketplace clock is authoritative but can be malformed (adapter bug /
    // skewed payload); never let an invalid Date poison the ticket.
    const receivedAt =
      input.receivedAt instanceof Date && !Number.isNaN(input.receivedAt.getTime())
        ? input.receivedAt
        : this.clock.now();
    if (receivedAt !== input.receivedAt) notes.push('INVALID_MARKETPLACE_CLOCK');

    const claimDueDate = this.sanitizeDueDate(input.claimDueDate, receivedAt);

    if (claimDueDate) {
      // Mercado Livre claims: the API `due_date` is the single source of truth.
      deadlineAt = claimDueDate;
      targetAt = claimDueDate;
      source = 'CLAIM_DUE_DATE';
      notes.push('CLAIM_DUE_DATE_OVERRIDE');
    } else {
      let effectiveTarget = policy.targetMinutes;

      if (input.marketplace === 'AMAZON') {
        // Buyer-Seller messaging corridor: 24h hard cap, 18h internal target.
        const cappedForCorridor = Math.min(effectiveTarget, AMAZON_CORRIDOR_MINUTES);
        if (cappedForCorridor !== effectiveTarget) {
          notes.push('AMAZON_24H_CORRIDOR');
        }
        effectiveTarget = cappedForCorridor;
        const internalTarget = Math.min(effectiveTarget, AMAZON_INTERNAL_TARGET_MINUTES);
        deadlineAt = this.addMinutes(receivedAt, effectiveTarget, policy.businessHoursOnly);
        targetAt = this.addMinutes(receivedAt, internalTarget, policy.businessHoursOnly);
        if (internalTarget < effectiveTarget) notes.push('AMAZON_INTERNAL_TARGET_18H');
        if (policy.source === 'OVERRIDE') source = 'POLICY_OVERRIDE';
        else source = 'AMAZON_CORRIDOR';
      } else if (input.marketplace === 'SHOPEE' && this.isShopeeChatLike(input.ticketType)) {
        // Chat Response Rate: the conversation must not stay unanswered > 12h.
        effectiveTarget = Math.min(effectiveTarget, SHOPEE_CRR_MINUTES);
        deadlineAt = this.addMinutes(receivedAt, effectiveTarget, policy.businessHoursOnly);
        targetAt = deadlineAt;
        if (policy.source === 'OVERRIDE') source = 'POLICY_OVERRIDE';
        else source = 'SHOPEE_CRR';
        notes.push('SHOPEE_CRR_12H');
        warningMinutes = Math.min(warningMinutes, effectiveTarget);
      } else {
        deadlineAt = this.addMinutes(receivedAt, effectiveTarget, policy.businessHoursOnly);
        targetAt = deadlineAt;
      }
    }

    if (deadlineAt.getTime() <= receivedAt.getTime()) {
      // Defensive: a skewed marketplace clock must never produce a past deadline
      // that instantly breaches a fresh ticket.
      deadlineAt = new Date(receivedAt.getTime() + MINUTE_MS);
      notes.push('DEADLINE_CLAMPED_TO_ONE_MINUTE');
    }
    if (targetAt.getTime() > deadlineAt.getTime()) {
      targetAt = deadlineAt;
    }

    const slaLegMinutes = Math.max(
      1,
      Math.round((deadlineAt.getTime() - receivedAt.getTime()) / MINUTE_MS),
    );

    const queue = this.resolveQueue(input);
    const priority = this.resolvePriority({
      ticketType: input.ticketType,
      hasActiveClaim: input.hasActiveClaim === true || input.ticketType === 'CLAIM_DISPUTE',
      priorityHint: input.priorityHint,
      deadlineAt,
      targetAt,
      warningMinutes,
      now: this.clock.now(),
    });

    return {
      deadlineAt,
      targetAt,
      warningMinutes: Math.min(warningMinutes, Math.max(1, slaLegMinutes)),
      slaLegMinutes,
      priority,
      queue,
      source,
      notes,
    };
  }

  private sanitizeDueDate(dueDate: Date | null | undefined, receivedAt: Date): Date | null {
    if (!dueDate) return null;
    if (Number.isNaN(dueDate.getTime())) return null;
    // A due date in the past is kept (the ticket is already late) but never
    // earlier than the inbound event itself - that would corrupt `slaLegMinutes`.
    if (dueDate.getTime() < receivedAt.getTime()) return receivedAt;
    return dueDate;
  }

  private isShopeeChatLike(ticketType: TicketType): boolean {
    return ticketType === 'PRE_SALE' || ticketType === 'POST_SALE_ORDER' || ticketType === 'PROACTIVE';
  }

  private addMinutes(start: Date, minutes: number, businessHoursOnly: boolean): Date {
    if (!businessHoursOnly) {
      return new Date(start.getTime() + minutes * MINUTE_MS);
    }
    return addBusinessMinutes(start, minutes);
  }

  resolveQueue(input: Pick<SlaPlanInput, 'marketplace' | 'ticketType' | 'queueHint'>): string {
    if (input.queueHint && input.queueHint.trim() !== '') return input.queueHint;
    if (input.marketplace === 'SHOPEE') {
      if (input.ticketType === 'CANCELLATION' || input.ticketType === 'RETURN_REFUND') {
        return SHOPEE_SPECIALIZED_QUEUE;
      }
      if (input.ticketType === 'PRE_SALE') return SHOPEE_COMMERCIAL_QUEUE;
    }
    return DEFAULT_QUEUE_BY_MARKETPLACE[input.marketplace];
  }

  private resolvePriority(input: {
    ticketType: TicketType;
    hasActiveClaim: boolean;
    priorityHint?: TicketPriority;
    deadlineAt: Date;
    targetAt: Date;
    warningMinutes: number;
    now: Date;
  }): TicketPriority {
    let priority: TicketPriority = PRIORITY_BY_TICKET_TYPE[input.ticketType];
    if (input.hasActiveClaim) priority = 'CRITICAL_SLA';
    if (input.priorityHint && PRIORITY_RANK[input.priorityHint] < PRIORITY_RANK[priority]) {
      priority = input.priorityHint;
    }

    const riskFrom = this.riskFrom(input.targetAt, input.deadlineAt, input.warningMinutes).getTime();
    const remainingMs = input.deadlineAt.getTime() - input.now.getTime();
    if (input.now.getTime() >= riskFrom && priority !== 'CRITICAL_SLA') {
      priority = 'HIGH';
    }
    if (remainingMs <= 0) priority = 'CRITICAL_SLA';
    return priority;
  }

  private riskFrom(targetAt: Date, deadlineAt: Date, warningMinutes: number): Date {
    const anchor = Math.min(targetAt.getTime(), deadlineAt.getTime());
    return new Date(anchor - warningMinutes * MINUTE_MS);
  }

  /* ------------------------------------------------------------------ */
  /* State evaluation                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Pure-ish state computation from a ticket deadline. Uses the policy warning
   * window (async because it may hit the SLA policy repository) and returns the
   * full snapshot the cockpit needs.
   */
  async evaluate(ticket: SupportTicketRecord): Promise<SlaSnapshot> {
    const policy = await this.resolvePolicy(ticket.accountId, ticket.marketplace, ticket.ticketType);
    const warningMinutes = Math.min(policy.warningMinutes, Math.max(1, policy.targetMinutes));
    return this.evaluateWithWarning(ticket, warningMinutes);
  }

  evaluateWithWarning(ticket: SupportTicketRecord, warningMinutes: number): SlaSnapshot {
    const now = this.clock.now();
    const deadlineAt = ticket.slaDeadlineAt;
    const targetAt = ticket.slaTargetAt;
    const remainingMs = deadlineAt.getTime() - now.getTime();
    const terminal = (TERMINAL_TICKET_STATUSES as readonly string[]).includes(ticket.status);

    let state: SlaState;
    if (terminal) {
      state = 'MET';
    } else if (ticket.slaBreached || remainingMs <= 0) {
      state = 'BREACHED';
    } else {
      const riskFrom = this.riskFrom(targetAt ?? deadlineAt, deadlineAt, warningMinutes);
      state = now.getTime() >= riskFrom.getTime() ? 'AT_RISK' : 'ON_TRACK';
    }

    return {
      state,
      deadlineAt,
      targetAt,
      warningMinutes,
      remainingMs,
      isBreached: state === 'BREACHED',
    };
  }

  /* ------------------------------------------------------------------ */
  /* Commands                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Recomputes the SLA of an existing ticket using the latest inbound event as
   * the start of the leg (marketplace clock, never ingestion time).
   */
  async refresh(ticket: SupportTicketRecord): Promise<SlaSnapshot> {
    const legStart = ticket.lastInboundAt ?? ticket.createdAt;
    const plan = await this.computePlan({
      accountId: ticket.accountId,
      marketplace: ticket.marketplace,
      ticketType: ticket.ticketType,
      receivedAt: legStart,
      hasActiveClaim: ticket.hasActiveClaim,
    });
    const snapshot = this.evaluateWithWarning(
      {
        ...ticket,
        slaDeadlineAt: plan.deadlineAt,
        slaTargetAt: plan.targetAt,
        slaBreached: ticket.slaBreached,
      },
      plan.warningMinutes,
    );
    return snapshot;
  }

  /**
   * Cron sweep. Marks newly breached tickets, downgrades/upgrades AT_RISK, and
   * publishes the realtime events consumed by the queue column.
   */
  async sweep(options?: { limit?: number; warningWindowMs?: number }): Promise<SlaSweepResult> {
    const limit = options?.limit ?? DEFAULT_SWEEP_LIMIT;
    const now = this.clock.now();
    const result: SlaSweepResult = { scanned: 0, breached: 0, atRisk: 0, recovered: 0, errors: 0 };

    // 1. Hard breaches -----------------------------------------------------
    let due: SupportTicketRecord[] = [];
    try {
      due = await this.tickets.findSlaDue(now, limit);
      result.scanned += due.length;
    } catch (error) {
      result.errors += 1;
      this.logger.error('sla.sweep.find_due_failed', { error: errorMessage(error) });
    }

    const breachCandidates = due.filter(
      (ticket) =>
        !ticket.slaBreached &&
        !(TERMINAL_TICKET_STATUSES as readonly string[]).includes(ticket.status),
    );

    if (breachCandidates.length > 0) {
      try {
        await this.tickets.markBreached(
          breachCandidates.map((ticket) => ticket.id),
          now,
        );
      } catch (error) {
        result.errors += 1;
        this.logger.error('sla.sweep.mark_breached_failed', {
          count: breachCandidates.length,
          error: errorMessage(error),
        });
      }

      for (const ticket of breachCandidates) {
        try {
          const updated = await this.tickets.update(ticket.id, {
            slaBreached: true,
            slaState: 'BREACHED',
            priority: ticket.priority === 'CRITICAL_SLA' ? 'CRITICAL_SLA' : 'CRITICAL_SLA',
          });
          await this.cache?.set(CACHE_KEYS.slaTicketClock(ticket.id), 'BREACHED', 300);
          this.realtime.ticketUpdated({
            ticketId: updated.id,
            marketplace: updated.marketplace,
            status: updated.status,
            priority: updated.priority,
            slaDeadlineAt: updated.slaDeadlineAt.toISOString(),
            assignedAgentId: updated.assignedAgentId,
            unreadCount: updated.unreadCount,
            updatedAt: updated.updatedAt.toISOString(),
          });
          this.realtime.queueChanged({ reason: 'sla_breached', ticketId: updated.id, at: now.toISOString() });
          result.breached += 1;
        } catch (error) {
          result.errors += 1;
          this.logger.warn('sla.sweep.breach_emit_failed', {
            ticketId: ticket.id,
            error: errorMessage(error),
          });
        }
      }
    }

    // 2. Approaching deadlines / recovery ---------------------------------
    const warningWindowMs = options?.warningWindowMs ?? DEFAULT_WARNING_MINUTES * MINUTE_MS;
    let approaching: SupportTicketRecord[] = [];
    try {
      approaching = await this.tickets.findAtRisk(now, warningWindowMs, limit);
      result.scanned += approaching.length;
    } catch (error) {
      result.errors += 1;
      this.logger.error('sla.sweep.find_at_risk_failed', { error: errorMessage(error) });
    }

    for (const ticket of approaching) {
      if ((TERMINAL_TICKET_STATUSES as readonly string[]).includes(ticket.status)) continue;
      try {
        const snapshot = await this.evaluate(ticket);
        if (snapshot.state === ticket.slaState) continue;
        if (snapshot.state !== 'AT_RISK' && snapshot.state !== 'ON_TRACK') continue;

        const updated = await this.tickets.update(ticket.id, { slaState: snapshot.state });
        this.realtime.ticketUpdated({
          ticketId: updated.id,
          marketplace: updated.marketplace,
          status: updated.status,
          priority: updated.priority,
          slaDeadlineAt: updated.slaDeadlineAt.toISOString(),
          assignedAgentId: updated.assignedAgentId,
          unreadCount: updated.unreadCount,
          updatedAt: updated.updatedAt.toISOString(),
        });
        if (snapshot.state === 'AT_RISK') {
          result.atRisk += 1;
          this.realtime.queueChanged({ reason: 'sla_at_risk', ticketId: updated.id, at: now.toISOString() });
        } else {
          result.recovered += 1;
        }
      } catch (error) {
        result.errors += 1;
        this.logger.warn('sla.sweep.state_update_failed', {
          ticketId: ticket.id,
          error: errorMessage(error),
        });
      }
    }

    if (result.breached > 0 || result.atRisk > 0) {
      this.logger.info('sla.sweep.completed', { ...result });
    }
    return result;
  }
}

/* ---------------------------------------------------------------------- */
/* Business-hours calendar                                                */
/* ---------------------------------------------------------------------- */

const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

const zonedFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIMEZONE,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function zonedParts(date: Date): { weekday: number; hour: number; minute: number } {
  const parts = zonedFormatter.formatToParts(date);
  const weekdayRaw = parts.find((part) => part.type === 'weekday')?.value ?? 'Mon';
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
  return {
    weekday: WEEKDAY_INDEX[weekdayRaw] ?? 0,
    // `hour` can be "24" at midnight depending on the ICU version.
    hour: hour === 24 ? 0 : hour,
    minute,
  };
}

export function isBusinessMinute(date: Date): boolean {
  const { weekday, hour } = zonedParts(date);
  if (weekday > 4) return false;
  return hour >= BUSINESS_START_HOUR && hour < BUSINESS_END_HOUR;
}

/**
 * Adds business minutes to a date. Minute-granular because SLAs are expressed in
 * minutes; the loop is bounded (weekends at most double the iterations).
 */
export function addBusinessMinutes(start: Date, minutes: number): Date {
  let remaining = Math.max(0, Math.ceil(minutes));
  let cursor = new Date(start.getTime());
  let guard = 0;
  const maxIterations = Math.max(1, remaining) * 6 * 24 * 60;
  while (remaining > 0 && guard < maxIterations) {
    cursor = new Date(cursor.getTime() + MINUTE_MS);
    guard += 1;
    if (isBusinessMinute(cursor)) remaining -= 1;
  }
  return cursor;
}

export const SLA_TIME_CONSTANTS = {
  MINUTE_MS,
  HOUR_MS,
  AMAZON_CORRIDOR_MINUTES,
  AMAZON_INTERNAL_TARGET_MINUTES,
  SHOPEE_CRR_MINUTES,
} as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
