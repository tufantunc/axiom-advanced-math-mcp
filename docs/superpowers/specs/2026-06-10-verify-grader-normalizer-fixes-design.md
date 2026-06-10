# Verify order_size Fix + Grader Candidate Pipeline + Normalizer Gaps

**Date:** 2026-06-10
**Status:** DESIGN — approved, pending implementation plan
**Priority order:** Component 1 (verify) → Component 2 (candidate pipeline) → Component 3 (normalizer)

## Background

The 2026-06-10 clean CAS re-run (`results/2026-06-10-12-13-49-zai-cas-quick.*`)
confirmed the worker-watchdog fix (128/128 tool calls, zero timeouts) but
measured CAS +MCP at 56.7% vs baseline 65%. Manual triage of all 26
tool-condition failures: **25 are grading/convention artifacts, 1 is a genuine
wrong answer** (#42). Verified empirically against the live grader and Giac:

| Pattern | Count | Example | Root cause |
|---|---|---|---|
| `+ C` integration constant | 12 | `x^2 + C` vs GT `x^2` | GT convention omits +C; `simplify((x^2+C)-(x^2))` = `C` ≠ 0 |
| Label/equation prefix | ~6 | `f'(x) = …`, `y = …`, `\dfrac{1}{x^2-1} = …` | symbolic equivalence never reaches RHS-extracted candidates |
| Trailing big-O | 3 | `… + \mathcal{O}(x^5` (often truncated) | no transform; fed by the verify defect below |
| Text-form separators | 2 | `\text{ for } x \neq 1`, `\text{ and }` | R2/R3 match comma forms only |
| Normalizer parse gaps | 2+ | `x^{2}\cos x`, `xe^x`, `3e^{-2x}` → `undef` | fused tokens / multi-char exponent loses braces |

Separately, a **real server defect**: the `verify` tool returns FALSE on true
taylor claims because `simplify(taylor(…) - poly)` leaves `x^5*order_size(x)`,
which fails the zero check. The model reacts by hedging (big-O tails, equation
prefixes) — feeding the artifact patterns above. Probes confirmed:

```
simplify(taylor(exp(x),x=0,4) - (1+x+x^2/2+x^3/6+x^4/24))  → x^5*order_size(x)
simplify((x^2+C) - (x^2))                                   → C
simplify((-4x)/((x^2-1)^2) - (-4*x/(x^2-1)^2))              → 0   (implicit mult OK)
simplify(3e^-2x - 3*exp(-2*x))                              → undef (exponent brace loss)
```

## Goals

1. `verify` returns TRUE (high confidence) on true taylor/series claims and
   parses `EXPR at x=a = b` claims (Component 1).
2. Grader residue transforms and RHS extraction compose with each other AND
   with symbolic equivalence, via a single candidate pipeline (Component 2).
3. Normalizer parses `\cos x`, `xe^x`, `e^{-2x}` forms into Giac-comparable
   canonicals (Component 3).

**Binding guardrail (unchanged):** grader changes must NEVER create false
positives. Every transform is a candidate-producer re-graded against ground
truth; a wrong answer cannot become right through any transform. The golden
corpus (incl. `x = 5` vs `5` as a deliberate non-match) must stay green.

**Non-goals:** arbitrary-constant alpha-equivalence (`C_1 cos x + C_2 sin x`
vs `C_0*cos(x)+C_1*sin(x)`, #37 — known limitation); stripping C-bearing
product terms like `+ C·e^{-x}` (#38 — general vs particular solution
distinction must survive); recovering truncated answers with unbalanced
parens beyond the big-O tail case; #42-style genuine model errors.

## Component 1 — verify: order_size + `at x=a` (`src/server/tools/verify/index.ts`)

- **Side pre-normalization.** In `handleIdentityVerification`, evaluate each
  side once through the engine; when the result contains `order_size`,
  replace that side with `stripOrderTerm(result)` (reuse from
  `output-cleanup.ts`). One fix point serving both the symbolic AND numeric
  paths (the numeric path currently dies with "Could not evaluate at any test
  point" on taylor sides).
- **Zero-modulo-order check.** In `verifySymbolic`, when `simplify(LHS-RHS)`
  is non-zero, split it at top level and drop `order_size` terms; if nothing
  remains, treat as zero (e.g. a bare `x^5*order_size(x)` residue → TRUE).
  Note: `stripOrderTerm` returns the ORIGINAL string when all terms would be
  dropped, so this check needs the term-split directly, not `stripOrderTerm`.
- **`at x=a` claims.** New `parseClaim` pattern, tried before the existing
  ones: `EXPR at VAR=VAL = RHS` → identity claim with LHS
  `subst(EXPR, VAR=VAL)`. Non-matching claims fall through to today's
  behavior.
- Error handling unchanged: every step degrades to current behavior on
  failure; never throws.

## Component 2 — grader candidate pipeline (`benchmark/graders/`)

New pure module `candidates.ts`:

```ts
generateCandidates(predicted: string, ground: string): string[]
```

BFS over transforms to depth ≤ 2, deduped, capped at ~12 candidates, original
string always first. Transforms (all v3-gated at the integration point):

| | Transform | New / extension |
|---|---|---|
| T1 | `extractRHS` | **Extension:** single-letter LHS accepted ONLY when `normalize(ground).kind === 'expression'` (`y = x^2` vs `x^2` ✓; `x = 5` vs scalar `5` still ✗). Signature gains an option, e.g. `allowSingleLetterLHS` |
| T2 | `stripTrailingConstraint` | **Extension:** `\text{ for } x \neq 1` form + `, C \in \mathbb{R}` tails |
| T3 | `stripValueLabels` | **Extension:** `\text{ and }` / ` and ` separators converted to commas first |
| T4 | `stripConstantTail` | **New:** trailing bare `+ C` / `+ C_1` term, only when ground truth contains no `C` |
| T5 | `stripBigOTail` | **New:** trailing `+ \mathcal{O}(x^k)` / `+ O(x^k)`, including the truncated unbalanced-paren form `+ \mathcal{O}(x^5` |
| T6 | `stripLogAbs` | **New (narrow):** absolute-value bars inside a logarithm only: `ln\|x\|` → `ln(x)` (textbook convention mismatch) |

Integration:

- **`gradeV2` (sync):** the current hand-written v3 blocks (RHS, R2, R3)
  become one loop over the candidate list with the inner sync re-grade
  (`_skipV3` recursion guard kept). Behavioral superset of today.
- **`gradeV2Async`:** when sync fails, iterate the SAME candidate list and
  attempt symbolic equivalence per candidate (existing kind-guards applied
  per candidate, not just to the raw string). First match wins. Cost is
  bounded by the bridge cache + 2s timeout + candidate cap. This is the
  structural fix: `f'(x) = \dfrac{-4x}{(x^2-1)^2}` finally reaches
  `simplify(…) = 0`; chains like `y(x) = Ce^x, \quad C \in \mathbb{R}`
  (T2 → T1 → symbolic) resolve naturally.
- Transforms stay pure, return `null` when not applicable, never throw.

## Component 3 — normalizer gaps (`benchmark/graders/normalizer.ts`)

In `latexToPlain` / canonical post-processing:

- **Multi-char exponent:** `^{tok}` where `tok` is a single alphanumeric
  token → `^tok` (today's behavior — keeps normalized-string matches);
  otherwise → `^(…)`: `e^{-2x}` → `e^(-2x)` (fixes the current silent
  `e^-2x` → `undef` bug).
- **`e` base → `exp(…)`:** only when a standalone `e` token is the base:
  `e^x` → `exp(x)`, `e^(-2x)` → `exp(-2x)`. Deterministic, independent of
  Giac's interpretation of `e`; ground truths already write `exp(...)`, so
  the normalized-string stage matches directly.
- **Implicit product (narrow):** insert `*` between a single-char token and a
  following `e^`: `xe^x` → `x*exp(x)`, `3e^{2x}` → `3*exp(2x)`. When the
  preceding character is part of a longer identifier (`lambdae^x`), leave it
  fused — conservative.
- **Unparenthesized function args:** BEFORE the generic command-strip, known
  functions (`\sin`, `\cos`, `\tan`, `\cot`, `\sec`, `\csc`, `\ln`, `\log`,
  `\exp`, `\sinh`, `\cosh`, `\tanh`, `\arcsin`, `\arccos`, `\arctan`) with a
  space-separated single-atom argument get wrapped: `\cos x` → `cos(x)`,
  preventing the `x^{2}\cos x` → `x^2cosx` fusion.

## Testing strategy (TDD — failing test first)

- **Guardrail:** existing golden corpus + full suite (544 tests) stays green
  unmodified — binding.
- Per-transform unit tests: the recovered form PLUS a twin guard case proving
  a wrong answer does not match (e.g. `x^3 + C` vs `x^2` stays wrong;
  `y = x^3` vs `x^2` stays wrong; wrong-coefficient big-O answer stays wrong).
- Candidate generator tests: dedup, cap, depth-2 chains (constraint→RHS),
  original-first ordering.
- verify integration tests (live engine): true taylor claim → TRUE/high;
  WRONG taylor claim (broken coefficient) → still FALSE; `at x=a` true/false
  pair; existing identity/solution behavior regression-guarded.
- Normalizer unit tests: `e^{-2x}`, `xe^x`, `\cos x`, plus `x^{2}` → `x^2`
  single-token regression protection.
- **End-to-end evidence:** offline regrade (`AXIOM_GRADER_V3=1`) of the
  2026-06-10 details JSONL — expect ~22-24 of the 26 tool failures and ~12
  baseline +C failures to flip; tool accuracy ~57% → ~90%+ band. Verify-tool
  impact requires a future live re-run (out of scope here).

## Execution

Isolated git worktree (parallel-session safety — standing instruction),
subagent-driven development, merge back to main locally when green.
