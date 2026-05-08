# Phase 2 — Compute Output Hygiene + Grader v3 (Design)

**Date:** 2026-05-08
**Status:** Approved
**Branch target:** `phase-2-output-hygiene` (off `main` post-Phase-1-removal)
**Supersedes:** Section "Phase 2 — Preprocessing & Fallback Chain" in `2026-05-07-sota-math-mcp-design.md`

## Why this revision

The original Phase 2 spec (preprocessing + fallback chain + silent-failure detection) was written before live A/B data existed. The post-Phase-0 CAS-quick run revealed the actual failure modes are different from the spec's assumptions:

| Original Phase 2 target | Live evidence (CAS-quick A condition, 60 problems) |
|---|---|
| Input preprocessing (Unicode/LaTeX → Giac) | Few affected cases — the model rarely sends malformed input |
| Multi-stage fallback chain | 1 empty-result, 1 GIAC_ERROR observed — small population |
| Silent-failure detection | Confirmed real (~2 problems) |

What the data shows instead:

- **~10/16 both-wrong problems are TRUNCATIONS** of the model's final LaTeX answer (4096-token budget hit during reasoning + tool calls + answer).
- **~3/16 are unsimplified or Unicode-mixed tool output** (`-1/2*2*x*(√(1-x^2))^-1` instead of `-x/sqrt(1-x^2)`).
- **2/3 regressions are grader gaps** — equation-form output (`\sin(x) = x - x^3/6 + ...` vs GT `x - x^3/6 + ...`) and bare comma-separated lists (`i,-i` vs `-i,i`).

Phase 2 is therefore re-scoped to a hybrid of original spec items (silent-failure detection only) plus three live-evidence-driven additions. Each component is small, surgical, and behind its own `--features` flag for ablation discipline (Phase 1's lesson: ablation is non-negotiable).

## Goals

- Address the dominant failure modes observed in live data
- Preserve the existing tool/grader behavior when flags are off (zero-risk addition)
- Use ablation flags to measure each component's effect in isolation
- Stay surgical: no new architecture, no new modules beyond small pure-function helpers

## Non-goals (this phase)

- Input preprocessing (deferred — few affected cases)
- Multi-stage fallback chain with retry (deferred — silent-failure WARNING is enough)
- Truncated-LaTeX repair in grader (risky — defer)
- LaTeX paraphrase root-cause fix (Phase 2.5 prompt experiment)
- Self-consistency / N-sample voting (Phase 3)
- Olympiad wrapper (Phase 4)

## Architecture

Three independent components, each behind a `--features` flag. No new architecture.

```
┌─ benchmark/config.ts ────────────────────────┐
│  --features=tokens-8k → maxTokens 4096→8192 │  Truncation
├─ src/server/tools/compute/* ─────────────────┤
│  --features=output-hygiene →                 │  Output
│   • Unicode → ASCII (√→sqrt, ²→^2, π→pi)    │  hygiene
│   • Optional simplify (structurally complex) │
│   • Silent-failure warning appended          │
├─ benchmark/graders/grader-v2.ts ─────────────┤
│  --features=grader-v3 →                      │  Grader v3
│   • Equation-form RHS extract                │
│   • Bare comma-separated list set match      │
└──────────────────────────────────────────────┘
```

No new top-level modules. Two small pure-function helpers (`extract-rhs.ts`, `bare-list.ts`, `unicode-normalize.ts`, `compute/hygiene.ts`) — each ≤60 lines, single-responsibility, fully unit-testable.

## Component 2.1 — Truncation fix (`tokens-8k`)

**Problem.** ~10/16 both-wrong CAS cases truncated at the final answer (e.g., `\dfrac{1}{1+x^2` missing `})`). Model exceeds the 4096-token budget while writing reasoning + tool-call traces + final answer.

**Fix.** When `--features=tokens-8k` is in the features list, `buildConfig()` returns `maxTokens: 8192` instead of 4096.

**File changes:**
- `benchmark/config.ts` — `maxTokens` becomes `features.includes('tokens-8k') ? 8192 : 4096`

**No env var needed.** `maxTokens` is a config field consumed by the runner directly (in `runners/baseline.ts` and `runners/tool-augmented.ts`). It does not need to cross the MCP-server boundary.

**Test:**
- Unit test: `buildConfig(['tokens-8k'])` returns `{ maxTokens: 8192, ... }`; without the flag returns 4096.
- No golden corpus entry — this isn't a tool/grader change.
- Live ablation is the measurement.

**Cost.** Roughly doubles per-problem token usage on long responses. CAS-quick (60 problems) ≈ +$0.50–1.00 per run. Acceptable.

**Hypothesis.** Recovers 3–6 problems on CAS-quick. Truncated finals were correct in content; grader would have matched if the closing brace existed.

## Component 2.2 — Compute output hygiene (`output-hygiene`)

**Problem (three sub-patterns):**

1. **Unicode in tool output.** `diff(sqrt(1-x^2))` returns `-1/2*2*x*(√(1-x^2))^-1` — the `√` is Unicode. Model sees mixed encoding, renders its own LaTeX in response. The grader's normalizer canonicalizes `√` → `sqrt` for comparison, but by then the model's final answer has diverged.
2. **Unsimplified output.** Same example: result should be `-x/sqrt(1-x^2)`, but Giac returned a structurally complex form. Grader's symbolic-equivalence stage catches this for matching, but the model copies the ugly form into its final answer, where it's then truncated.
3. **Silent failures.** `Result: []` (e.g., `desolve` returning empty), `GIAC_ERROR`, `NaN`, `Inf`, `undef`. Model treats `[]` as a valid answer.

**Fix.** Activated by `process.env.AXIOM_COMPUTE_HYGIENE === '1'` (set when `--features=output-hygiene`). Three-step post-process pipeline applied in `src/server/tools/compute/index.ts` between `dispatch()` and `formatOutput()`.

### 2.2a — Silent-failure warning

```typescript
function detectFailure(displayText: string): string | null {
  const t = displayText.trim();
  if (/^Result:\s*\[\]/.test(t)) return 'empty result';
  if (/GIAC_ERROR/.test(t)) return 'Giac error';
  if (/\b(NaN|Inf|-Inf|undef)\b/.test(t)) return 'non-finite result';
  return null;
}
```

If detected, prepend a warning line to the response text, e.g.:

```
[Warning: empty result; the tool returned [] — the answer may not exist or the
input form may be unsupported. Consider trying a different formulation.]
Result: []
LaTeX: "[]"
...
```

The warning shifts the failure from invisible to flagged. **No retry, no fallback.** Per scope.

### 2.2b — Unicode → ASCII normalize on display

On the result and decimal/latex lines that the model sees, replace:

| From | To |
|---|---|
| `√` | `sqrt` |
| `²`, `³`, `⁰`, `¹`, `⁴`–`⁹` | `^2`, `^3`, `^0`, `^1`, `^4`–`^9` |
| `π` | `pi` |
| `×` | `*` |
| `÷` | `/` |

Reuse rules from `benchmark/graders/normalizer.ts` `unicodeToPlain()`. Extract the rules into a new shared module `src/server/tools/unicode-normalize.ts` (single function, ~20 lines) so the runtime tool output and the grader use the same canonical form.

### 2.2c — Optional simplify

Trigger only when the result has structural complexity signals:
- contains `^-` (negative exponent), OR
- contains both `*` and `/` mixed at depth >1 (top-level mixed is normal), OR
- contains nested parens deeper than 2

If trigger fires:
1. Call Giac `simplify(<result>)` via the existing engine
2. If simplified is **shorter** (fewer characters), use it as the displayed result
3. If Giac errors or simplified is longer/equal, keep the original

**Conservative trigger.** Avoids `simplify` on already-clean output. Cost (extra Giac call) only paid on suspicious-looking results.

**File changes:**
- `src/server/tools/unicode-normalize.ts` (new, ~20 lines): pure function, exports `unicodeToAscii(s: string): string`
- `src/server/tools/compute/hygiene.ts` (new, ~80 lines): exports `applyHygiene(response, giacEngine): Promise<typeof response>` orchestrating the three steps
- `src/server/tools/compute/index.ts` (modified, ~5 lines): when `AXIOM_COMPUTE_HYGIENE=1`, await `applyHygiene(response, giacEngine)` after dispatch
- `benchmark/index.ts` (modified, +1 line): `if (config.features.includes('output-hygiene')) process.env.AXIOM_COMPUTE_HYGIENE = '1';`
- `benchmark/runners/mcp-proxy.ts` — already passes env to spawned MCP server (Phase 1 fix); inherits automatically

**Tests:**
- `test/unicode-normalize.test.ts` (new): unit tests for the rule set, including round-trip with grader normalizer for consistency
- `test/compute-hygiene.test.ts` (new): unit tests for `applyHygiene` covering each of the three steps in isolation
- Golden fixture additions: at least 3 cases hitting Unicode-replace, simplify-trigger, and silent-failure-warning paths

**Hypothesis.** +2–4 problems on CAS-quick. Lower-bound because LaTeX paraphrase happens regardless of source format. Upper-bound because cleaner tool output may reduce paraphrase frequency too.

## Component 2.3 — Grader v3 (`grader-v3`)

**Problem (two specific regressions + a few both-wrong):**

1. **Equation-form output (#56).** Model wrote `\sin(x) = x - \frac{x^3}{6} + \frac{x^5}{120} + O(x^6)`. GT is just the RHS: `x-x^3/6+x^5/120`. Grader compares full string ↔ full string, fails.
2. **Bare comma-list (#49).** Eigenvalues output `i,-i`, GT `-i,i`. Same set, different order. Grader-v2's set match requires `{...}` braces; bare comma list isn't recognized as a set, falls into expression-vs-expression string match, fails.

**Fix.** Behind `process.env.AXIOM_GRADER_V3 === '1'` (set when `--features=grader-v3`). Add two stages to `gradeV2()` in `benchmark/graders/grader-v2.ts`. **No new `grader-v3.ts` file** — extension pattern, not replacement.

### 2.3a — Equation-form RHS extract

Inserted at the top of `gradeV2()`, after the exact-string match:

```typescript
if (process.env.AXIOM_GRADER_V3 === '1') {
  const pRHS = extractRHS(predicted);
  const gRHS = extractRHS(ground);
  if (pRHS !== null) {
    const r = gradeV2Inner(pRHS, ground, opts);  // sync recursion guard
    if (r.match) return finish(true, 'equation-rhs-match', r.kind, r.method);
  }
  if (gRHS !== null) {
    const r = gradeV2Inner(predicted, gRHS, opts);
    if (r.match) return finish(true, 'equation-rhs-match', r.kind, r.method);
  }
}
```

`extractRHS(s: string): string | null` lives in `benchmark/graders/extract-rhs.ts` (new, ~20 lines, pure):

- Strip outer LaTeX wrappers (`\boxed{}`, surrounding `$...$`)
- Find a top-level `=` (depth 0 after counting parens/braces/brackets)
- LHS must be non-empty AND look like a function-call or symbolic expression — explicitly reject when LHS is a single variable followed by `=` (e.g., `x = 5`, where the equation IS the answer, not a renaming)
- Returns RHS trimmed, or `null`

`gradeV2Inner` is the existing v2 logic with the v3 stage skipped — prevents recursion.

### 2.3b — Bare comma-separated list set match

Modify the existing set-match block in `gradeV2()`. Currently:

```typescript
const pSet = setMembers(p.canonical) ?? conditionalToSet(p.canonical);
const gSet = setMembers(g.canonical) ?? conditionalToSet(g.canonical);
```

When `AXIOM_GRADER_V3=1`, append a third fallback:

```typescript
const pSet = setMembers(p.canonical) ?? conditionalToSet(p.canonical) ?? bareCommaList(p.canonical);
const gSet = setMembers(g.canonical) ?? conditionalToSet(g.canonical) ?? bareCommaList(g.canonical);
```

`bareCommaList(s: string): string[] | null` lives in `benchmark/graders/bare-list.ts` (new, ~25 lines):

- Reject if `s` contains `=` or comparison operators (these aren't lists)
- Split top-level `,` (depth 0 — not inside parens/brackets/braces)
- Require ≥2 members
- Each member must look "atomic" — heuristic: contains no top-level `+` (which would suggest the whole thing is one expression). Top-level `-` is acceptable (signed term).
- Examples that match: `i,-i`, `sqrt(2),-sqrt(2)`, `1,-1,2,-2`
- Examples that reject (correctly fail-fast): `a*x+b*y,c` (has top-level `+` mixed with `,`), `x = 5, y = 6` (has `=`)

### File changes
- `benchmark/graders/extract-rhs.ts` (new, ~20 lines)
- `benchmark/graders/bare-list.ts` (new, ~25 lines)
- `benchmark/graders/grader-v2.ts` (modified, ~50 lines added: imports + gated stages + `gradeV2Inner` recursion-guard wrapper)
- `benchmark/index.ts` (modified, +1 line: env var set when feature flag present)
- `test/extract-rhs.test.ts` (new): unit tests including edge cases (variable assignment `x=5` → null, simple equation `f(x)=...` → RHS, no `=` → null)
- `test/bare-list.test.ts` (new): unit tests for positive and negative cases
- `test/grader-v2.test.ts` (extended): v3-gated stage integration tests
- `test/golden/grader.golden.test.ts` (extended): new fixtures for the regressions

### Hypothesis
+2–3 problems on CAS-quick: the two specific regressions plus a few both-wrong with equation-form outputs.

### Risks
- **Equation-RHS over-match.** If LHS is a numeric expression that happens to equal the RHS, we might match wrongly. Mitigation: LHS must contain at least one variable letter or function call (not pure numeric). Mitigation 2: only one side at a time tries the extraction — the symmetric attempt is independent.
- **Bare-list over-match.** Strings like `f(x), g(x)` would parse as a list. The atomic-member heuristic catches the simple cases. Edge cases (intentionally) left for future iteration if observed in regressions.

## Success metrics

| Flag | Hypothesis | CAS-quick target (60) | MATH L4-L5 quick (100, secondary) |
|---|---|---|---|
| Baseline (`v2` only) | current state | 68.3% / 3 reg | not yet measured live |
| `+tokens-8k` | truncation recovers correct answers | 72–78% / 1–2 reg | small lift on long-LaTeX problems |
| `+output-hygiene` | cleaner output reduces paraphrase + flags failures | 70–72% / 2 reg | comparable lift |
| `+grader-v3` | catches 2 specific gaps + a few similar | 70–71% / 1 reg | small (less equation-form there) |
| **All combined** (`v2,tokens-8k,output-hygiene,grader-v3`) | stack | **78–83% / ≤2 reg** | measurable improvement |

Cost-per-correct (Pareto control): tokens-8k ~doubles tokens, others negligible. Total ratio target: ≤1.5× the v2-only run.

## Test plan

Per component:
1. Unit tests for new helpers (pure functions — easy to cover thoroughly)
2. Integration tests with the env var set (verify gating works, no regression when off)
3. Golden corpus entries for the specific regressions each component targets

After all three components ship:
4. **Five live ablation runs** on CAS-quick:
   - `--features=v2` (control)
   - `--features=v2,tokens-8k`
   - `--features=v2,output-hygiene`
   - `--features=v2,grader-v3`
   - `--features=v2,tokens-8k,output-hygiene,grader-v3` (combined)
5. Phase 2 results doc captures all five numbers + delta-per-flag + interaction analysis. Estimated: 2.5–3 hours total benchmark runtime, ~$5–10 cost.

If a flag shows **net negative** in its isolated ablation (Phase 1 lesson), the commit stays in main but the flag stays off-by-default and the results doc explicitly documents the failure mode. We do not silently ship regressions.

## File-changes summary

### New files (5)
- `src/server/tools/unicode-normalize.ts` (~20 lines)
- `src/server/tools/compute/hygiene.ts` (~80 lines)
- `benchmark/graders/extract-rhs.ts` (~20 lines)
- `benchmark/graders/bare-list.ts` (~25 lines)
- Plus test files for each: `test/unicode-normalize.test.ts`, `test/compute-hygiene.test.ts`, `test/extract-rhs.test.ts`, `test/bare-list.test.ts`

### Modified files (4)
- `benchmark/config.ts` — `maxTokens` becomes feature-conditional
- `benchmark/index.ts` — sets `AXIOM_COMPUTE_HYGIENE` and `AXIOM_GRADER_V3` when their flags are present
- `src/server/tools/compute/index.ts` — calls `applyHygiene` post-dispatch when env set
- `benchmark/graders/grader-v2.ts` — adds two v3-gated stages

### Tests added/extended
- 4 new test files (unit, see above)
- `test/grader-v2.test.ts` — v3 stage tests
- `test/golden/grader.golden.test.ts` — 5+ new fixtures (equation-RHS, bare-list, plus a few from the regression dataset)
- `test/golden/fixtures.ts` — corresponding `GraderCase` entries

### Phase 2 results doc (after live ablation)
- `docs/superpowers/specs/2026-05-08-phase-2-results.md` — captured numbers and findings

## Open questions

These are validated empirically during the live ablation; no a-priori answers needed:

1. Does `tokens-8k` interact with the model's behavior beyond simple "more room" (e.g., does it encourage the model to be MORE verbose, eating most of the new budget)?
2. Does `output-hygiene`'s post-simplify ever produce a form Giac considers equivalent but that the grader's symbolic-equivalence stage doesn't recognize?
3. Does `grader-v3`'s equation-RHS stage cause any false positives on existing golden cases? (Should be ruled out by the test suite; live data confirms.)

## Next steps (after this spec is approved)

Invoke `superpowers:writing-plans` to produce a bite-sized TDD implementation plan covering:
- Three components ordered by ROI / dependency (likely: tokens-8k first — quick win + new baseline; then output-hygiene; then grader-v3)
- Each component as its own task series with TDD steps
- Final task: 5-condition ablation run + Phase 2 results doc
