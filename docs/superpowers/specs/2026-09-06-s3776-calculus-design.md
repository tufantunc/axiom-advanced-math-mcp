# S3776 — decompose calculusHandler's guard tail (cognitive complexity 39)

## Finding

SonarQube S3776 on `src/server/tools/calculus.ts:153`: `calculusHandler` has
cognitive complexity 39 (threshold 15). The handler's head is already
decomposed (`validateParams`, `buildSimpleCommand`, `buildGiacExpression`);
the complexity lives in the tail — two deeply nested guard regions:

1. **Solution-vector guard** (functions path, ~lines 202–277): sentinel
   checks (`detectFailure`, `poly1[`, `ilaplace(`, token-`infinity`) plus the
   disproof check, with nested message selection.
2. **Single-equation guard** (~lines 293–422): per-branch infinity check,
   failure diagnosis if/else chains, and the `verifyOdeSolution` residual
   check.

Both regions carry long load-bearing comments (documented witness inputs,
mutation counts, inert-argument warnings) that must migrate with their code.

## Design

Extract three module-level functions; the handler stays the owner of
ordering and remains a linear validate → build → eval → guard pipeline.

- `buildVerifyCallback(operation, args, system)` — the
  `isIndefiniteIntegral` / `system` branches that choose the `verify`
  callback handed to `evalWithLatex`.
- `solutionVectorGuard(response, hasConditions)` — the functions-path
  sentinel + disproof guard. Returns the formatted error response or
  `undefined`.
- `singleEquationGuard(response, args)` (async) — the whole
  `!functions && operation === 'solve_ode'` path. Awaited at the call site
  so a Giac throw cannot escape the handler's catch (`return await`
  discipline from the optimization.ts round).

Handler tail becomes:

```ts
if (functions) {
  const refusal = solutionVectorGuard(response, hasConditions);
  if (refusal) return refusal;
} else if (operation === 'solve_ode') {
  const refusal = await singleEquationGuard(response, args);
  if (refusal) return refusal;
}
return response;
```

## Rules

- All comments move with their code, verbatim.
- Extracted functions derive their own inputs from `args` / `response`.
- No behavior change: target is byte-identical output.

## Verification

- Equivalence harness: pre-refactor module (`git show 157f891:…`) vs the
  new one, both against the real Giac engine, on a curated matrix covering
  every operation family and every documented witness input
  (`x^x` → `[[infinity,infinity]]`, `[y'=z,z'=-y+sqrt(x)]` disproof,
  over-determined IVP → `[]`, `y(pi/2)=1` BVP → infinity, `2*y*y'=1`
  branch-infinity, `y(x)=5` residual −5, `k_undefined*z` name collision).
- Five gates (format, lint, typecheck, unit, integration).
- review-pro: correctness (read-only) first, then tests-mutation.
