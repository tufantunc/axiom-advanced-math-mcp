# S3776 — decompose verify/index.ts's three flagged functions (64 / 144 / 354)

## Findings

SonarQube S3776 ×3 on `src/server/tools/verify/index.ts`:

- `:64` `isOrderResidueOnly` — the depth-tracking additive-term splitter is
  the complexity; the predicate itself is tiny.
- `:144` `verifyNumeric` — two distinct sub-strategies in one body: the
  no-variables direct evaluation and the multi-variable sampled-points loop.
- `:354` `findMainEquals` — the loop body's comparison-operator skip
  decisions (`==`, `!=`, `<=`, `>=`) nested inside depth tracking.

`verifyHandler`, `handleIdentityVerification`, `handleSolutionVerification`,
`formatVerifyResponse`, and `parseClaim` are under threshold and untouched.

## Design

- `splitAdditiveTerms(expr): string[]` — the splitter extracted (depth
  tracking over `()[]{}`, `+`/`-` boundaries only at depth 0, empty-term and
  lone-dash filtering). `isOrderResidueOnly` becomes the
  `includes('order_size')` guard plus `terms.every(t =>
  t.includes('order_size'))`. The JSDoc stays on `isOrderResidueOnly`; the
  splitter gets its own short doc.
- `verifyNumericDirect(lhs, rhs)` — the `vars.length === 0` branch: both
  `evalf`s, the NaN → "could not check" comment and refusal, `diff < 1e-8`.
- `verifyNumericSampled(lhs, rhs, vars)` — the `testPoints` loop: the nested
  `subst` chain, the skip-undefined-points comments, passCount/failures, and
  the `totalTested === 0` refusal. `verifyNumeric` becomes `lname` →
  `parseVariableList` → dispatch.
- `isComparisonOperator(expr, i): boolean` — the `==` / `!=` / `<=` / `>=`
  checks with their inline comments; `findMainEquals` keeps the depth
  tracking and calls it.

All comments migrate with their code, verbatim.

## Verification

- Equivalence harness (real Giac): `verifyHandler` end-to-end matrix — true
  and false identities (with and without variables, exercising both numeric
  arms), series results carrying `order_size` remainders (the
  `isOrderResidueOnly` witnesses), `at`-pattern claims, solution claims,
  unparseable claims, `method` = numeric/symbolic/both, `format` = json/text,
  claims containing `==`/`<=` (the `findMainEquals` skips), multi-variable
  claims (sampled arm with failures).
- Five gates; review-pro correctness → tests-mutation (sequential).
