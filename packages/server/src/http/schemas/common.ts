import { z } from 'zod';
import type { ZodIssue } from 'zod';
import { ValidationError } from '@sac/shared';

export type InputLocation = 'body' | 'query' | 'params' | 'headers';

export interface ValidationIssueView {
  path: string;
  code: string;
  message: string;
}

/** Flatten zod issues into the `details.issues` contract the web client renders. */
export function describeZodIssues(error: { readonly issues: readonly ZodIssue[] }): ValidationIssueView[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.map((segment) => String(segment)).join('.') : '(root)',
    code: issue.code,
    message: issue.message,
  }));
}

export function invalidInput(where: InputLocation, error: { readonly issues: readonly ZodIssue[] }): ValidationError {
  return new ValidationError(`Invalid request ${where}`, {
    where,
    issues: describeZodIssues(error),
  });
}

/**
 * Parse an untrusted HTTP input with a zod schema, throwing a 422
 * `VALIDATION_ERROR` (with field details) on failure.
 */
export function parseInput<TSchema extends z.ZodType<unknown>>(
  schema: TSchema,
  value: unknown,
  where: InputLocation,
): z.output<TSchema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalidInput(where, parsed.error);
  return parsed.data;
}

/** Treat an empty query parameter (`?search=`) as "absent". */
export function blankAsUndefined<TOutput>(
  schema: z.ZodType<TOutput>,
): z.ZodType<TOutput> {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim().length === 0 ? undefined : value),
    schema,
  );
}

/** Comma separated query list -> validated array (contract: `?marketplace=A,B`). */
export function csvToStrings(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
