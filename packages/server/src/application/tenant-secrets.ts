/**
 * Shared redaction helpers for tenant-scoped artifacts (LGPD export and
 * backup/restore).
 *
 * `channel_config` is marketplace-specific and has no schema: every connector is
 * free to add fields. Dropping any key that LOOKS like a credential is the only
 * safe projection, so an unknown connector can never leak a token into an
 * export or a backup file.
 */

export const SECRET_KEY_PATTERN = /(token|secret|password|senha|api[_-]?key|private[_-]?key)/i;

/** Copy `channel_config` dropping any key that looks like a credential. */
export function sanitizeChannelConfig(
  config: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config ?? {})) {
    if (SECRET_KEY_PATTERN.test(key)) continue;
    safe[key] = value;
  }
  return safe;
}
