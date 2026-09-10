# S3776 — decompose validateParams and verifyOdeSolution (23 + 23)

## Findings

- `src/server/tools/calculus.ts:112` — `validateParams` (cognitive complexity
  23): five switch cases, each an if-chain over required fields; the
  solve_ode case adds the unsupported-argument refusal with its load-bearing
  comment.
- `src/server/tools/self-verify.ts:650` — `verifyOdeSolution` (23): input
  shape guards, the equation cut (first member → equationOnly →
  isOneBareEquation refusal), the six-rule substitution chain, and the
  residual verdict path (zero → conditions cross-check; nonzero → branch
  markers, probe sampling, disproof). Every decline carries a comment
  documenting the exact failure it prevents.

## Design

### calculus.ts
Per-operation validators in the geometry style; `validateParams` becomes a
five-line dispatch: `validateDifferentiate` / `validateIntegrate` /
`validateLimit` / `validateTaylor` / `validateSolveOde`, each returning
`string | null`. The solve_ode validator migrates with the "Refused, not
ignored" comment block. `buildSimpleCommand` is not flagged and is untouched.

### self-verify.ts
Four helpers; `verifyOdeSolution` stays the orchestrator with its early
returns and the overall contract doc:

- `extractBareEquation(equation)` → `{ status: 'decline' | 'refuse' | 'ok',
  equationOnly? }` — first-member cut, empty decline, isOneBareEquation
  refusal with its detail text.
- `substituteAnswer(equationOnly, answer, functionName, variable)` (pure) —
  the six replaceAll rules, comments attached ("longest spelling first",
  "two lookaheads", the leftover-mention declines stay at the orchestrator
  where they read the result).
- `checkConditions(clauseSource, equationOnly, functionName, variable,
  answer, evaluate)` (async) — the post-zero half: odeClauses cross-check,
  everyConditionHolds, the two verified detail strings.
- `disproveResidual(residual, equationOnly, variable, evaluate)` (async) —
  branch-marker decline, the three probe points with residualMagnitudeAt,
  the two constant assignments, and the disproof verdict.

Comment migration is the sensitive part: each block moves with its code,
in order, none rewritten.

## Verification

- Equivalence harness (real Giac): calculus param matrix (every missing
  field per operation, order/taylor edges, unsupported_argument, unknown op)
  plus the solve_ode witness set through the full handler; verifyOdeSolution
  witnesses (y(x)=5 → residual -5, y(0)=x^2 → 2x·eˣ, sqrt(y) domain decline,
  y''(x) leftover decline, conditional ✓ spellings, branch-marker cases).
- Five gates; review-pro correctness → tests-mutation (sequential). Existing
  pin coverage is rich: verify-ode-solution 89 rows, handler-seam 426.
