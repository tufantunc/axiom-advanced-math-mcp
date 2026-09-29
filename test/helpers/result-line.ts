/**
 * Matches one whole `Result: …` line, regex-escaping the needle — a substring
 * match passes on wrong answers that happen to contain the digits.
 *
 * Shared because two copies had already drifted: one was unanchored at the
 * start, so `xResult: 1/x` matched, and needed a trailing newline, so a Result
 * on the last line did not; the other escaped only the first `/` and no regex
 * metacharacter, so a needle like `(2^n)^2` built a pattern that could never
 * match — and a `not.toMatch` on it passed without testing anything.
 */
export function resultLine(value: string): RegExp {
  return new RegExp(`^Result: ${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm');
}
