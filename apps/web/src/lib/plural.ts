/**
 * pt-BR plural helpers for visible copy.
 *
 * Portuguese agrees the noun and its adjectives with the count, and `0` takes
 * the plural ("0 lojas"). These helpers keep that rule in one place so screens
 * never render the old parenthesised plural style. No dependencies: generated
 * artifacts (`.env`/markdown) and render paths both use them.
 */

/** `${count} ${one}` when `count === 1`, `${count} ${many}` otherwise. */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Only the inflected noun/adjective: `token` for 1, `tokens` for 0 and 2+. */
export function pluralWord(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}
