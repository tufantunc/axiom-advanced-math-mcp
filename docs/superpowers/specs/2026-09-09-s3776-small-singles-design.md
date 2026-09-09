# S3776 — small-singles sweep: exact-arithmetic, expression-validator, operators

## Findings

Three S3776 findings, one sweep tour:

- `src/server/tools/exact-arithmetic.ts:10` — `tryExactResult` is a
  three-stage chain (integer snap, trusted fraction, symbolic engine form)
  in one body.
- `src/server/tools/expression-validator.ts:10` — `validateExpression`
  contains the SAME balance loop twice (parens and brackets).
- `src/server/tools/multivariable/operators.ts:7` — `operatorHandler` mixes
  command construction for two families (vector ops, scalar ops) with
  validation and refusal returns.

## Design

- exact-arithmetic: `snapToInteger(n)`, `trustedFraction(n)`, and async
  `symbolicExactForm(expr, n)` extracted with their comments (the fraction
  stage is the TRUSTED_FRACTION round's code verbatim);
  `tryExactResult` = finite check → snap → fraction → symbolic → null.
- expression-validator: one `unbalancedDelimiters(expr, open, close,
  singular, plural)` helper, called twice; messages parameterized so the
  singular/plural wordings stay byte-identical.
- operators: `buildVectorCommand(operation, args, variables, varList)` and
  `buildScalarCommand(...)` in the calculus `buildSimpleCommand` convention —
  refusals are THROWN (`new Error(msg)`), and the handler's existing catch
  formats the identical string, so refusal output is byte-identical. The
  `variables` guard and the `evalWithLatex` call stay in the handler; the
  jacobian-matrix and diff-ordering comments migrate with their code.

## Verification

- Equivalence harness (real Giac): `tryExactResult` witnesses
  (0.9999999999999999→1 snap, sech(23.4)→null, sin(pi/5)'s 4456/7581 falling
  through to the engine, trusted 2/3 and 22/7, 45° conversion, '2e-9'
  re-render decline, nthRoot float-echo decline, combinations/unit declines,
  non-finite), `validateExpression` matrix (both delimiter kinds ×
  balanced/unbalanced/empty/whitespace, positions, plural forms), and
  `operatorHandler` end-to-end (gradient, hessian, partial, divergence,
  curl, jacobian, every refusal, unknown op).
- Five gates; review-pro correctness → tests-mutation (sequential).
