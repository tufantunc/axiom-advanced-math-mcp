# S3776 — double tour: linear-regression (44+92) and cli/parse (309+401)

## Findings

- `src/server/tools/linear-regression.ts:44` — `formatPolynomial`: the
  per-term assembly chain (first-term sign, |c|===1 coefficient elision,
  power spelling).
- `src/server/tools/linear-regression.ts:92` — `linearRegressionHandler`:
  the four-guard validation chain plus the four-model dispatch, each model
  mixing transform, positivity refusal, back-transform, and rendering.
- `src/cli/parse.ts:309` — `parseComputeArgs`: validation nested inside
  switch cases inside the flag loop.
- `src/cli/parse.ts:401` — `parsePlotArgs`: the post-loop `-q requires -o`
  check and the conditional-field command assembly add to the switch loop.

## Design

### linear-regression.ts
- `formatTerm(c, i, variable, isFirst): string` — the per-term chain;
  `formatPolynomial` becomes filter/map/join.
- `validateRegressionArgs(x, y, model, degree): string | null` — the four
  guards with their comments (shape → lengths → finite → degree), same
  order and messages.
- `fitLinearOrPolynomial` / `fitExponential` / `fitLogarithmic` /
  `fitPower` (async, return `string[]`) — each model's transform, positivity
  guard (THROWN: `formatRawError(error.message)` is byte-identical to
  `formatErrorResponse(msg)`, verified), back-transform, and render; model
  comments migrate. Handler: validate → try { `return formatRawResponse
  (await fit...)` } → catch.

### cli/parse.ts
- `requireDomain(v): string` and `requirePrecision(v): number` — the
  membership/integer-range validators with UsageErrors; the compute switch
  cases become one-liners.
- `buildPlotCommand(expression, output, out, variable, title, range):
  PlotCommand` — the `-q`-requires-`-o` check (comment migrated) and the
  conditional-field assembly (comment migrated). The switch and the
  RANGE_FIELDS dispatch stay in the loop.

## Verification

- Equivalence harness (real Giac): linear-regression — five models with
  good fits, every refusal (short arrays, length mismatch, non-finite,
  degree bounds, y≤0 / x≤0 positivity, unknown model), plus
  formatPolynomial edges (negative first term, ±1 coefficients, zero
  skipping, all-zero → '0'); parse — compute/verify/plot argument matrices
  (--domain valid/invalid, --precision at 1/50/0/51/fractional, `--`
  sentinel, foreign flags, missing values, -q without -o on plot, range
  flags).
- Five gates; review-pro correctness → tests-mutation (sequential).
