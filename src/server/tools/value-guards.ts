/**
 * Runtime shape checks for values that arrive as `unknown`.
 *
 * These are not argument parsing — they say nothing about how a problem string
 * is read — so they live beside the handlers rather than inside `compute/`.
 * hypothesis-testing.ts was the only handler importing from `compute/`, and
 * what it wanted was these two predicates.
 */

/** True when every element is a finite number and there is at least one. */
export function isNumberList(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

/** True when every element is itself a non-empty list of finite numbers. */
export function isNumberMatrix(value: unknown): value is number[][] {
  return Array.isArray(value) && value.length > 0 && value.every(isNumberList);
}
