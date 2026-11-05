/**
 * Prisma error guards.
 *
 * Prisma's `PrismaClientKnownRequestError` is not re-exported as a stable value
 * type across generator versions, so the error code is matched structurally:
 * `P2002` = unique constraint violation (idempotent replays), `P2025` = record
 * not found (delete/update races).
 */

interface PrismaErrorLike {
  code?: unknown;
  meta?: unknown;
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as PrismaErrorLike).code;
  return typeof code === 'string' ? code : null;
}

/** Unique constraint violation (duplicate `external_message_id`, event id, ...). */
export function isUniqueConstraintViolation(error: unknown): boolean {
  return errorCode(error) === 'P2002';
}

/** Record required for update/delete was not found. */
export function isRecordNotFound(error: unknown): boolean {
  return errorCode(error) === 'P2025';
}
