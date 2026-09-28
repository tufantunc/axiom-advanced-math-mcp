/**
 * Matches one whole `Result: …` line, regex-escaping the needle — a substring
 * match passes on wrong answers that happen to contain the digits.
 *
 * Shared because two copies had already drifted: one was unanchored at the
 * start, so `xResult: 1/x` matched, and needed a trailing newline, so a Result
 * on the last line did not; the other escaped `/` but not a second one. A
 * negative assertion built from a wrong needle passes without testing anything.
 */
export function resultLine(value: string): RegExp {
  return new RegExp(`^Result: ${value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`, 'm');
}
