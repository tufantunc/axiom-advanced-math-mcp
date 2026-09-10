# S3776 — decompose analyzeNumberCore (cognitive complexity 36)

## Finding

SonarQube S3776 on `src/server/tools/number-utils.ts:3`: `analyzeNumberCore`
has cognitive complexity 36 (threshold 15). The file's helpers
(`parseIfactor`, `listDivisors`, `divisorCount`, `divisorSum`,
`isPerfectSquare`, `isPerfectCube`, `isTriangular`, `triangularIndex`,
`isFibonacci`) are already small and exported — the complexity is entirely in
the report-building section logic of `analyzeNumberCore` (lines 3–68):
primality with a trial-division fallback, factorization with two fallback
branches, the divisor block with two gates (`count <= 30` listing,
`absN > 1` perfect-number), Euler totient with an EMPTY catch (a failure adds
no line), and the shape predicates.

## Design

Extract five section functions; `analyzeNumberCore` becomes a composition
that preserves BOTH the engine-call order (`isprime` → `ifactor` → `euler`)
and the output line order:

```ts
export async function analyzeNumberCore(n: number): Promise<string[]> {
  const absN = Math.abs(n);
  const primeLines = await primalityLines(absN);
  const { lines: factorLines, factors } = await factorize(absN);
  return [
    `Number: ${n}`,
    ...primeLines,
    ...factorLines,
    ...divisorLines(absN, factors),
    ...(await eulerTotientLine(absN)),
    ...shapeNotes(absN),
  ];
}
```

- `primalityLines(absN)` (async): engine `isprime` + trial-division fallback
  in the catch. Returns `['Prime: Yes|No']`.
- `factorize(absN)` (async): `absN <= 1` branch, engine `ifactor` + parse,
  `could not compute` fallback. Returns `{ lines, factors }` — this makes the
  factors-sharing between sections explicit instead of closure state.
- `divisorLines(absN, factors)` (sync): early-return for `absN < 1`;
  count/list/sum with the `count <= 30` gate; perfect-number only when
  `absN > 1`.
- `eulerTotientLine(absN)` (async): only `absN > 0`; the empty catch is
  preserved as `return []` (a failed totient adds NO line).
- `shapeNotes(absN)` (sync): perfect square/cube/triangular/fibonacci.

The exported helpers are untouched. The original has no comments; none to
migrate.

## Verification

- Equivalence harness: pre-refactor module (`git show 731cadb:…`) vs new,
  real Giac engine, byte-compare of the returned lines array. Edge numbers:
  -7 (negative), 0, 1, 2, 6, 12 (powers in factorization), 28 and 496
  (perfect), 36, 997 (prime), 720720 (240 divisors — exercises the
  `count <= 30` gate), 2^20, 2^31-1 (large prime), 97 (prime with shape
  notes), 55 (triangular + fibonacci).
- The catch paths (engine throws) cannot fire with a working engine, so they
  are covered by mutation instead: harness + tests-reviewer mutations.
- Five gates; review-pro correctness → tests-mutation (sequential).
- Note: no existing test file references `analyzeNumberCore` directly — the
  tests reviewer decides whether pins are owed.
