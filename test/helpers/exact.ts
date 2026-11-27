/** n! exactly, as an oracle for the engine's own arithmetic. */
export function factorial(n: number): bigint {
  let f = 1n;
  for (let k = 2n; k <= BigInt(n); k++) f *= k;
  return f;
}
