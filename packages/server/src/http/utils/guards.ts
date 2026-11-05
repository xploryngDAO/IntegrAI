/** Narrowing helpers used by the HTTP boundary (no `any` leaks inward). */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
