# Tier 2 — Compute Self-Verification

**Date:** 2026-06-09
**Branch:** `cas-tier2-3` (worktree, based on `main` @ Tier 1)
**Status:** DESIGN — approved, pending implementation plan

## Background

This is the second phase of "pushing the CAS verification pipeline." Tier 1
(merged: CAS output hygiene + extraction robustness) cleaned the output the
model copies. Tier 2 makes `compute` **verify its own answer** using the sound
CAS as the checker, and — for `solve` only — **escalate methods** (real →
complex → numeric) using verification as the selector.

### Goals (agreed with user)

The success criteria are explicitly **NOT** raw accuracy lift (our analysis
showed verification is a checker, not a generator — it cannot solve what the
model/CAS cannot). The targets are:

- **(A) Confidence/precision signal** — every `solve`/`factor`/`integrate`
  result carries a CAS-derived `verified` flag so a consumer can distinguish
  confident-but-wrong from confirmed answers.
- **(C) Narrow-band recovery** — `solve` escalates real→complex→numeric, picking
  the first method whose roots all verify. This recovers cases the primary
  method misses (e.g., an equation with only complex roots).

All logic is **server-side and deterministic** (no LLM, no benchmark dependency).
Agent-side retry measurement and the GLM-5.1 failure triage are deferred.

### Safety principle (non-negotiable)

Verification **never discards a result.** A failed verification annotates
`verified: false` and still returns the best answer. Escalation only **adds**
alternatives; it never removes the primary result. The verifier itself can be
imperfect (e.g., `simplify` may fail to prove a true equivalence), so a
verification miss must never block or alter a correct answer beyond labeling it.

### What already exists (reused)

The `verify` tool (`src/server/tools/verify/index.ts`) already implements the
round-trip patterns we reuse:
- solution check: `evalf(subst((lhs)-(rhs), var=value))`, `|result| < 1e-8`
- symbolic check: `simplify((lhs)-(rhs)) == 0`

Tier 2 embeds these checks **automatically into `compute`** (vs. the
agent-callable `verify` tool). Shared logic lives in a new focused module.

## Architecture (layered, server-side)

### 1. New module `src/server/tools/self-verify.ts`

Pure verification functions. Each calls `giacEngine`, returns a structured
result, and **never throws** (Giac error / `undef` → `verified: false` with a
detail string).

```ts
export interface VerificationResult {
  verified: boolean;
  method: string;   // 'substitution' | 'expand' | 'differentiation'
  detail: string;   // human-readable
}

export async function verifySolveSet(
  equation: string, variable: string, solutions: string[]
): Promise<VerificationResult>;

export async function verifyFactor(
  original: string, factored: string
): Promise<VerificationResult>;

export async function verifyIntegrate(
  integrand: string, variable: string, result: string
): Promise<VerificationResult>;

export async function verifySystem(
  equations: string[], variables: string[], tuple: string[]
): Promise<VerificationResult>;
```

- `verifySolveSet`: substitute each solution into `equation` (normalized to
  `(lhs)-(rhs)` form), `evalf`, check `|·| < 1e-8`. `verified` only if **every**
  solution checks and the set is non-empty. Empty set → `verified: false`
  (nothing was confirmed). detail names how many roots checked.
- `verifyFactor`: `simplify((expand(factored)) - (original))` → `verified` iff
  result is `0`.
- `verifyIntegrate`: `simplify(diff((result), variable) - (integrand))` →
  `verified` iff `0`.

### 2. Wiring into handlers

**`solve.ts` — escalation + verify (C):**

`solveEquationHandler` runs an escalation loop over candidate methods:

- Candidate order by domain:
  - default / `real`: `solve` → `csolve` → `fsolve` (numeric)
  - `complex`: `csolve` → `fsolve`
- For each candidate: `giacEngine.evaluate(expr)`, parse solutions (reusing
  Tier 1's `listToSet`/`splitTopLevel` to extract members), then
  `verifySolveSet`.
- Pick the **first candidate whose verification passes**; record a `methodNote`
  if it was not the primary method (e.g. `csolve (escalated — no real roots)`).
- If **no** candidate verifies, use the **primary** method's result (the natural
  first candidate) with `verified: false`. Never discard.
- The winning `giacExpr` + precomputed `VerificationResult` + `methodNote` are
  passed to `evalWithLatex` (so the chosen result still gets Tier 1's
  `listToSet` transform, `latex`, and caching). Verification is passed via a
  trivial callback returning the precomputed result — no redundant Giac calls.

`solveSystemHandler` — **annotate-only**, no escalation. A helper
`verifySystem(equations[], variables[], tuple)` in `self-verify.ts` substitutes
the solution tuple's values into each equation (`subst` of all `var=value`
pairs, `evalf`), and reports `verified` iff every equation evaluates `≈ 0`
(`< 1e-8`) and the tuple is non-empty. No method escalation.

**`algebra.ts` (factor) and `calculus.ts` (integrate) — annotate-only (A):**

These handlers build a `giacExpr` then call `evalWithLatex`. For the **factor**
and **integrate** operations only, pass a `verify` callback that runs the
corresponding round-trip check on the result. Other operations in these
handlers are untouched.

### 3. Output plumbing

**`evalWithLatex` (`giac-eval.ts`)** gains two optional fields on `EvalOptions`:

```ts
verify?: (result: string) => Promise<VerificationResult>;
methodNote?: string;
```

- `verify` is called on the **pre-`resultTransform` mathematical result** (the
  form Giac produced and can re-parse — consistent with Tier 1's rule that
  `latex` is derived from the raw result). For `factor`/`integrate` there is no
  transform, so this is the Giac result. For `solve`, the precomputed
  verification is returned by the trivial callback.
- The resulting `VerificationResult` and `methodNote` flow into
  `formatToolResponse`.

**`response-formatter.ts`** — `MathToolResponse` gains optional
`verification?: VerificationResult` and `methodNote?: string`. Rendering (after
`Command:`, before the blank line / `The answer is`):

```
Method: csolve (escalated — no real roots)        // only when methodNote present
Verified: ✓ (substitution: 2/2 roots satisfy the equation)   // ALWAYS present when verification given
```

Failure: `Verified: ✗ (substitution: 0/2 roots confirmed)`.

**`normalize.ts` + `types.ts`** — `ComputeEnvelope` gains an optional
`verification?: { verified: boolean; method: string; detail: string }`.
`parseResponseLines` parses the `Verified:` line back into this field for the
`format: 'json'` path (consistent with how normalize already re-parses text
lines).

## Data flow (solve example, x²+1=0, default domain)

1. `solveEquationHandler` escalation:
   - `solve(x^2+1,x)` → `list[]` (empty) → `verifySolveSet` → `verified:false`
   - `csolve(x^2+1,x)` → `list[i,-i]` → substitute → `verified:true`
   - Pick `csolve`; `methodNote = 'csolve (escalated — no real roots)'`.
2. `evalWithLatex({ giacExpr: 'csolve(x^2+1,x)', resultTransform: listToSet,
   verify: () => precomputed, methodNote })`.
3. Result line `{i, -i}` (Tier 1 transform), `Verified: ✓`, `Method:` note.
4. `normalize` parses the `Verified:` line → envelope `verification`.

## Error handling

- self-verify functions wrap all Giac calls in try/catch → `verified: false`,
  detail describes the failure. Never throw.
- Escalation: if every candidate errors, fall back to the primary candidate's
  raw result with `verified: false`. The handler's outer try/catch (existing)
  still returns a clean error only for true input errors (e.g. missing args).
- A verification miss is informational. It never changes the returned answer
  (beyond the label) and never turns a success into an error response.

## Testing strategy (TDD — failing test first)

- **self-verify (integration, real engine):**
  - `verifySolveSet('x^2-4','x',['-2','2'])` → verified; `['-2','3']` → not.
  - `verifySolveSet` empty `[]` → not verified.
  - `verifyFactor('x^2-4','(x-2)*(x+2)')` → verified; wrong factoring → not.
  - `verifyIntegrate('2*x','x','x^2')` → verified; `'x^3'` → not.
- **solve escalation (integration):**
  - `x^2+1` default domain → result `{i, -i}`, `Verified: ✓`, methodNote present.
  - `x^2-4` → `{-2, 2}`, verified, **no** methodNote (primary verified).
  - A genuinely unverifiable case → `verified:false`, primary result still returned.
- **factor/integrate annotation:** verified line present and correct for both a
  confirmable and a non-confirmable case.
- **output shape:** text always contains a `Verified:` line; `format:'json'`
  envelope contains the `verification` field with correct `verified`.
- **regression:** full suite green; existing solve/factor/integrate tests
  (mostly `toContain`) unaffected by the added line.

## Affected files

| File | Change |
|---|---|
| `src/server/tools/self-verify.ts` (NEW) | `VerificationResult` + 3 verify fns |
| `src/server/tools/giac-eval.ts` | `verify?` callback + `methodNote?` → formatToolResponse |
| `src/server/tools/response-formatter.ts` | render `Verified:` (always) + `Method:` lines |
| `src/server/tools/solve.ts` | escalation chain + verification (single eq); annotate (system) |
| `src/server/tools/algebra.ts` | factor: verify callback |
| `src/server/tools/calculus.ts` | integrate: verify callback |
| `src/server/tools/compute/normalize.ts` | parse `Verified:` line → envelope |
| `src/server/tools/compute/types.ts` | `ComputeEnvelope.verification` field |
| tests (new + existing) | self-verify, escalation, output, regression |

## Out of scope

- Tier 3 (separate next cycle): structured Giac error detection + deterministic
  syntax normalizer.
- Agent-side retry on the `verified:false` signal (benchmark/LLM-driven).
- The deferred GLM-5.1 failure-trace triage.
- Escalation for `factor`/`integrate` (no meaningful Giac alternative; annotate
  only).
- Escalation for systems of equations (annotate only).
