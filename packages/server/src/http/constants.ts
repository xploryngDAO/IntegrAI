/**
 * HTTP layer constants. Keep wire-level values here so routes, controllers and
 * the realtime hub cannot drift apart.
 */

/** Prefix every browser-facing endpoint is mounted under (docs/API_CONTRACT.md). */
export const API_PREFIX = '/api/v1';

/** Socket.IO mount path - the web client hardcodes this. */
export const HUB_PATH = '/socket.io';

/** Room every authenticated socket joins; receives queue-wide events. */
export const HUB_ROOM_ALL = 'all';

/**
 * Global request body cap (webhooks + JSON).
 *
 * The 12 MiB ceiling is driven by the Amazon SES inbound relay: the raw MIME
 * message travels inside the signed body and may carry attachments. It is NOT
 * meant for the authenticated JSON API - that surface is capped much lower by
 * `MAX_API_JSON_BYTES` (see `buildHttpApp`).
 */
export const DEFAULT_BODY_LIMIT_BYTES = 12 * 1024 * 1024;

/**
 * JSON body cap for `/api/v1/*`.
 *
 * No authenticated JSON endpoint needs more than a few hundred KiB (the largest
 * field - message body - is limited by Zod). Keeping it at 1 MiB shrinks the
 * pre-auth allocation an attacker can trigger through `application/json`
 * without touching the webhook ingress, which keeps its 12 MiB allowance.
 */
export const MAX_API_JSON_BYTES = 1024 * 1024;

/** Attachment upload cap (Amazon MIME/size restrictions). */
export const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Whole-request deadline (headers + body) enforced by the HTTP server.
 *
 * Above the 30 s diagnostics budget and below Node's 300 s default, so a
 * slowloris/body-drip client cannot hold a socket forever.
 */
export const HTTP_REQUEST_TIMEOUT_MS = 60_000;

/** Presigned GET lifetime for attachments (contract: 5 minutes). */
export const SIGNED_URL_TTL_SECONDS = 300;

/** Page size contract: `pageSize <= 100`, default 40. */
export const DEFAULT_PAGE_SIZE = 40;
export const MAX_PAGE_SIZE = 100;

/** Response header carrying the measured webhook handler duration. */
export const WEBHOOK_DURATION_HEADER = 'x-sac-duration-ms';

/**
 * Header carrying the HMAC SHA-256 (hex) of the raw billing webhook body.
 * The gateway contract is provider-agnostic: an adapter in front of Stripe/
 * Pagar.me must produce this header and the normalized payload.
 */
export const BILLING_SIGNATURE_HEADER = 'x-billing-signature';

/**
 * Diagnostics perform live token exchanges and marketplace reads, so they get a
 * generous per-request deadline (30s) instead of the normal fast-path budget.
 * Exceeding it answers 504 without affecting webhooks or any other route.
 */
export const DIAGNOSTICS_TIMEOUT_MS = 30_000;

/** Storage prefix attachments are written under. */
export const ATTACHMENTS_KEY_PREFIX = 'attachments/';

// The upload MIME allowlist/blocklist lives next to the attachment policy
// (`application/files/upload-policy.ts`) so the HTTP controller and FileService
// share exactly one list.
