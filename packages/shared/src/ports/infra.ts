import type { AgentPresenceStatus } from '../enums';

/* This file deliberately avoids importing DTOs to keep infra ports dependency
 * free; only primitive shapes cross the boundary. */

export interface ILogger {
  child(bindings: Record<string, unknown>): ILogger;
  trace(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface IClock {
  now(): Date;
}

export interface ICache {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
  /** Atomic SET NX EX. Returns true when the key was created by this call. */
  setNx(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  del(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  ttl(key: string): Promise<number>;
  /** Fixed-window counter; returns the value after increment. */
  incr(key: string, ttlSeconds: number): Promise<number>;
  hset(key: string, values: Record<string, string>): Promise<void>;
  hgetall<T extends Record<string, string>>(key: string): Promise<T | null>;
  /** Set membership helpers used for the presence index. */
  sadd(key: string, members: string[]): Promise<void>;
  srem(key: string, members: string[]): Promise<void>;
  smembers(key: string): Promise<string[]>;
}

export interface IDistributedLock {
  /**
   * Acquire a Redlock over `resources`, run `fn`, always release.
   * Throws `LockAcquisitionError` when the lock cannot be acquired in time.
   */
  withLock<T>(
    resources: string[],
    ttlMs: number,
    fn: () => Promise<T>,
    options?: { retryDelayMs?: number; maxAttempts?: number },
  ): Promise<T>;
  /** Best-effort: returns false instead of throwing when the lock is busy. */
  tryWithLock<T>(resources: string[], ttlMs: number, fn: () => Promise<T>): Promise<{ acquired: boolean; value?: T }>;
}

export interface RateLimitOptions {
  cost?: number;
  /** Milliseconds to wait for a token before giving up (0 = fail fast). */
  timeoutMs?: number;
}

export interface IRateLimiter {
  /** Token bucket; resolves true when a token was consumed. */
  consume(bucket: string, options?: RateLimitOptions): Promise<boolean>;
  /** Waits (with backoff) until a token is available; throws RateLimitError. */
  acquire(bucket: string, options?: RateLimitOptions): Promise<void>;
  reset(bucket: string): Promise<void>;
}

export interface PutObjectInput {
  key: string;
  body: Buffer | string;
  contentType?: string;
  metadata?: Record<string, string>;
  /** Content-MD5 base64 (Amazon uploadDestinations requirement). */
  contentMd5?: string;
}

export interface StoredObject {
  key: string;
  uri: string;
  size: number;
  sha256: string;
}

/** Outcome of a bulk delete; missing objects count as deleted (idempotent). */
export interface DeleteObjectsResult {
  /** Keys confirmed absent after the call (actually removed or already gone). */
  deleted: number;
  /** Keys the provider refused to delete (permissions, transport, ...). */
  failed: number;
}

export interface IObjectStorage {
  putObject(input: PutObjectInput): Promise<StoredObject>;
  getObject(key: string): Promise<Buffer>;
  /** Uploads a binary buffer to an external pre-signed S3 URL (Amazon PUT). */
  putToPresignedUrl(url: string, body: Buffer, headers?: Record<string, string>): Promise<void>;
  presignGet(key: string, expiresInSeconds?: number): Promise<string>;
  buildUri(key: string): string;
  /**
   * Deletes one object. Idempotent: a key that does not exist (NoSuchKey /
   * NotFound) is treated as already deleted instead of throwing.
   */
  deleteObject(key: string): Promise<void>;
  /**
   * Bulk delete used by the LGPD purge. Must NEVER abort the caller for a
   * partially failed batch: keys that could not be removed are counted in
   * `failed` and the remaining keys are still attempted. Missing keys count as
   * `deleted` (NoSuchKey tolerance).
   */
  deleteObjects(keys: string[]): Promise<DeleteObjectsResult>;
}

/**
 * New-device login alert payload.
 *
 * `ip`/`userAgent` are the already-normalized fingerprint the session store
 * matched against (absent when the request carries no usable fingerprint - the
 * caller never sends the alert in that case). `at` is the login instant from the
 * injected clock, so the e-mail and the audit row agree on the same timestamp.
 */
export interface NewSessionAlertEmail {
  to: string;
  name?: string;
  ip?: string | null;
  userAgent?: string | null;
  at: Date;
  tenantName?: string | null;
}

/**
 * Role-change alert payload (ADMIN changed the role of another operator).
 *
 * Sent to the AFFECTED operator's inbox - never to the actor - after the change
 * was persisted. `previousRole`/`newRole` are the raw role codes (the template
 * localizes them); `changedBy` is the actor e-mail, absent when the caller has
 * no operator identity; `tenantName` is the workspace display name resolved
 * best effort by the caller.
 */
export interface RoleChangedAlertEmail {
  to: string;
  name?: string;
  previousRole: string;
  newRole: string;
  changedBy?: string | null;
  tenantName?: string | null;
}

/**
 * Account activation/deactivation alert payload. One interface for both
 * directions: the caller picks the method, the body only varies by verb.
 */
export interface AccountStatusAlertEmail {
  to: string;
  name?: string;
  changedBy?: string | null;
  tenantName?: string | null;
}

/**
 * Transactional e-mail port.
 *
 * Implementations must never log the raw token/link in production and must
 * degrade gracefully (log-only) when SMTP is not configured outside production.
 */
export interface IEmailService {
  sendVerificationEmail(to: string, link: string, name?: string): Promise<void>;
  /** Fase 1: `/reset-password?token=...` link; single use, 30 min TTL. */
  sendPasswordResetEmail(to: string, link: string, name?: string): Promise<void>;
  /** Fase 1: `/invite?token=...` link; single use, 7 day TTL. */
  sendInvitationEmail(to: string, link: string, inviterName?: string): Promise<void>;
  /**
   * Security alert for a login from an unknown device. Best effort by contract:
   * implementations must never throw (the login already succeeded) and must
   * keep the dev-only log fallback when SMTP is not configured.
   */
  sendNewSessionAlert(input: NewSessionAlertEmail): Promise<void>;
  /**
   * Account-management alerts (ADMIN acts on ANOTHER operator's account).
   * Best effort by contract, exactly like `sendNewSessionAlert`: the change is
   * already persisted, so implementations must never throw and must keep the
   * dev-only log fallback when SMTP is not configured.
   */
  sendRoleChangedAlert(input: RoleChangedAlertEmail): Promise<void>;
  sendAccountDeactivatedAlert(input: AccountStatusAlertEmail): Promise<void>;
  sendAccountReactivatedAlert(input: AccountStatusAlertEmail): Promise<void>;
}

export interface ISecretCipher {
  /** AES-256-GCM. Format: `v1:<keyId>:<ivB64>:<tagB64>:<cipherB64>`. */
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
  /** Deterministic HMAC-SHA256 (hex) for equality lookups on encrypted data. */
  hash(value: string): string;
  keyId: string;
}

export interface HttpRequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  formData?: FormData;
  timeoutMs?: number;
  retries?: number;
  /** Certificate/agent hints are intentionally not exposed. */
  signal?: AbortSignal;
}

export interface HttpResponse<T = unknown> {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: T;
  durationMs: number;
  requestId?: string;
}

export interface IHttpClient {
  request<T = unknown>(options: HttpRequestOptions): Promise<HttpResponse<T>>;
  requestBinary(options: HttpRequestOptions): Promise<HttpResponse<Buffer>>;
}

export interface PublishOptions {
  jobId?: string;
  delayMs?: number;
  attempts?: number;
  priority?: number;
  /** Deduplicate identical jobs by this key (BullMQ jobId strategy). */
  dedupeKey?: string;
}

export interface IQueuePublisher {
  publish<TPayload extends object>(queue: string, payload: TPayload, options?: PublishOptions): Promise<string>;
  /** Publishes to the dead-letter queue with the original failure context. */
  publishToDlq(originalQueue: string, payload: object, error: unknown): Promise<void>;
}

/* ------------------------------ Realtime ---------------------------------- */

export interface TicketRealtimeEvent {
  ticketId: string;
  marketplace: string;
  status: string;
  priority: string;
  slaDeadlineAt: string;
  assignedAgentId: string | null;
  unreadCount: number;
  updatedAt: string;
}

export interface MessageRealtimeEvent {
  ticketId: string;
  messageId: string;
  direction: string;
  channelRouteUsed: string;
  preview: string;
  marketplaceCreatedAt: string;
}

export interface ChannelHealthSnapshot {
  marketplace: string;
  accountId: string;
  healthy: boolean;
  detail: string;
  at: string;
}

export interface AgentPresenceEvent {
  agentId: string;
  agentName: string;
  presence: AgentPresenceStatus;
  queueChange?: string;
  at: string;
}

export interface IRealtimePublisher {
  ticketUpdated(event: TicketRealtimeEvent): void;
  messageCreated(event: MessageRealtimeEvent): void;
  queueChanged(payload: { reason: string; ticketId?: string; at: string }): void;
  channelHealth(snapshot: ChannelHealthSnapshot): void;
  agentPresence(event: AgentPresenceEvent): void;
}
