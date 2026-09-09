# S3776 — decompose checkQuadratic and exactValueHandler (26 + 26)

## Findings

- `src/server/tools/sequence-utils.ts:123` — `checkQuadratic` (cognitive
  complexity 26): difference computation, constancy check, coefficient
  solving, extrapolation, and the formula-string assembly chain (A = ±1
  spellings, B/C sign prefixes, the all-zero `'0'` fallback) in one function.
- `src/server/tools/exact-value.ts:5` — `exactValueHandler` (26): three fat
  switch cases (to_exact, to_decimal, simplify_fraction) with the dispatch,
  validation, and rendering intertwined.

## Design

### sequence-utils.ts
Three module-level helpers; `checkQuadratic` becomes a composition:

- `diffs(arr): number[]` — adjacent differences (used twice: d1 from terms,
  d2 from d1).
- `quadraticFormula(A, B, C): string` — the parts-assembly chain verbatim
  (A===1 → 'n²', A===-1 → '-n²', sign prefixes only when parts exist,
  `parts.join(' ') || '0'`).
- `nextQuadraticTerms(A, B, C, length): number[]` — the 3-term extrapolation
  loop.

`checkKnownSequences` and all other exports untouched.

### exact-value.ts
Geometry-style per-op extraction; the handler keeps ordering and the catch:

- `toExact(args)` (async — awaits tryExactResult) including the parseFloat
  refusal.
- `toDecimal(args)` (async — QuickCalcService) including the precision
  display logic and the nonFinite note, comments migrated.
- `simplifyFraction(value)` (sync) — regex, sign/GCD normalization, den===1
  branch, LaTeX.

Dispatch: `return await` for the two async ops (real promises — the
optimization.ts lesson), plain `return` for the sync one (the S4123
lesson). `gcd` stays module-level.

## Verification

- Equivalence harness (real Giac): sequence side — arithmetic/geometric/
  quadratic families (integer, fractional, and non-integer A), the A=0/B=0/
  C=0 edges (linear/constant sequences through checkQuadratic), short
  inputs, and the checkKnownSequences composite path; exact-value side —
  to_exact (rational, not-found, invalid), to_decimal (with/without
  precision, 1e308*10 nonFinite, unitful "1/2 m"), simplify_fraction
  (negative, den===1, zero numerator, invalid, sign-carrying "4/-8").
- Five gates; review-pro correctness → tests-mutation (sequential).
