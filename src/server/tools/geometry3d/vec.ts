/** Round like geometry.ts: integers stay integers, others round to 1e10. */
export function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 1e10) / 1e10);
}

/** Format a vector as "[a, b, c]" with formatNumber on each component. */
export function vfmt(v: number[]): string {
  return `[${v.map(formatNumber).join(', ')}]`;
}

/** Validate that `list` is exactly `n` finite numbers; throw with `label` otherwise. */
export function need(list: number[] | undefined, n: number, label: string): number[] {
  if (!list || list.length !== n || list.some((x) => !Number.isFinite(x))) {
    throw new Error(`${label} must be a list of ${n} numbers`);
  }
  return list;
}

/**
 * Vector primitives below assume callers pass validated, equal-length numeric
 * vectors (use `need(...)` first). They do NOT guard lengths — mismatched or
 * non-finite inputs propagate NaN silently rather than throwing.
 */
export const vsub = (a: number[], b: number[]): number[] => a.map((x, i) => x - b[i]);
export const vdot = (a: number[], b: number[]): number => a.reduce((s, x, i) => s + x * b[i], 0);
export const vcross = (a: number[], b: number[]): number[] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const vnorm = (a: number[]): number => Math.sqrt(vdot(a, a));

/** True if |x| is below a small epsilon — for robust degeneracy checks on float results. */
export const isZero = (x: number): boolean => Math.abs(x) < 1e-12;
