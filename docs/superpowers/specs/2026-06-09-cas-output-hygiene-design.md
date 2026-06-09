# Tier 1 — CAS Output Hygiene + Extraction Robustness

**Date:** 2026-06-09
**Branch:** `cas-output-hygiene`
**Status:** DESIGN — approved, pending implementation plan

## Background

This is the first phase of "pushing the CAS verification pipeline" — the path
from an LLM agent calling a math tool, through Giac, back to a graded answer.
It follows the phased plan agreed with the user (Tier 1 first as a deterministic,
unit-testable unit; Tier 2/3 designed afterward with what we learn here).

### Origin: a reframed bug

We started chasing a "LaTeX truncation bug" blamed for CAS-quick failures #55
(Taylor series of eˣ) and #57 (Maclaurin series of cos x). Reproduction against
the live Giac engine showed **the tool does NOT truncate** — it returns the full,
correct result and full, correct LaTeX:

```
series(exp(x),x,0,4)
  result : "1+x+1/2*x^2+1/6*x^3+1/24*x^4+x^5*order_size(x)"   (complete, 46 chars)
  latex  : "\"1+x+\\frac{1}{2} \\cdot x^{2}+...+\\frac{1}{24} \\cdot x^{4}+x^{5} \\mathrm{order\\_size}\\left(x\\right)\""  (complete, 119 chars)
```

The truncation in the benchmark trace came from **the model mangling/cutting the
long, ugly output when copying it into its own answer** — not a tool defect. We
cannot directly fix the model, but we **can make the output short and clean so
there is nothing to truncate or mis-copy.** So "#1 truncation" is reframed as
**output hygiene**, not a bug fix.

The investigation surfaced real, pervasive defects:

| # | Defect | Scope | Effect on #55/#57 |
|---|---|---|---|
| A | `latex()` output wrapped in literal `"..."` quotes | **All** compute responses | Indirect — ugly/long output misleads the model |
| B | `order_size(x)` big-O remainder carried in `result`+`latex` | series/taylor | **Direct** — clean short target = nothing to truncate |
| C | `\boxed{}` extraction has no fail-safe for an incomplete last box | benchmark grader | Direct — recover the previous complete box |
| D | `solve` leaks Giac internal `list[...]` notation | solve responses | Indirect (newly discovered) |

### Reproduction evidence

`latex()` quoting is **general**, not series-specific:

```
factor(x^2-4)    | result="(x-2)*(x+2)" | latex="\"(x-2)\\cdot (x+2)\""
solve(x^2-4,x)   | result="list[-2,2]"  | latex="\"\\{-2,2\\}\""
integrate(x^2,x) | result="x^3/3"       | latex="\"\\frac{x^{3}}{3}\""
```

`order_size` appears at zero AND non-zero centers (so the strip must be general):

```
series(exp(x),x,0,4) | "1+x+1/2*x^2+1/6*x^3+1/24*x^4+x^5*order_size(x)"
series(ln(x),x,1,3)  | "x-1-1/2*(x-1)^2+1/3*(x-1)^3+(x-1)^4*order_size(x-1)"
```

`solve` emits `list[...]` (square brackets), which existing normalizers miss
(they match `[...]` and `list(...)`, but the real format is `list[...]`):

```
solve(x^2-4,x)               | "list[-2,2]"
solve(x-3,x)                 | "list[3]"
solve(x^2+1,x)               | "[]"        (no real roots)
csolve(x^2+1,x)              | "list[i,-i]"
solve([x+y=3,x-y=1],[x,y])   | "list[[2,1]]"   (nested system solution)
```

## Goals

1. Remove stray quotes from all `latex()` output (A).
2. Strip the big-O `order_size(...)` remainder from series/taylor results and
   their LaTeX (B).
3. Make answer extraction fall back to the last *complete* `\boxed{}` when the
   final one is incomplete (C).
4. Convert `solve`'s `list[...]` into clean set/tuple notation in both the text
   response the model sees and the structured JSON path (D).

**Non-goals:** changing the grader's matching logic; touching Tier 2/3
(round-trip verify, dual-method, error recovery); fixing the model's truncation
behavior directly. No benchmark run is required to validate Tier 1 — it is fully
covered by deterministic unit/integration tests.

## Architecture: layered cleanup

Cleanup lives where it is semantically correct, not in one global hub:

- **Generic cleanup → `src/server/tools/giac-eval.ts` (`evalWithLatex`)**
  Quote-strip (A) and `order_size` strip (B). Both are globally safe:
  `order_size` is produced only by series/taylor; the quote artifact is purely
  a `latex()` string-type wrapper.
- **Solve-semantic cleanup → solve handler(s) + `normalize.ts`**
  `list[...]` → clean set/tuple (D). Applied only where we know the result is a
  solution set. Delivered via a new optional `resultTransform` hook on
  `evalWithLatex` so the generic helper stays ignorant of solve semantics.
- **Extraction robustness → `benchmark/graders/answer-parser.ts`**
  Boxed fail-safe (C). Benchmark side only.

### The `resultTransform` hook

`evalWithLatex` gains an optional callback:

```ts
export interface EvalOptions {
  giacExpr: string;
  operation: string;
  errorMessage?: string;
  resultTransform?: (raw: string) => string; // NEW
}
```

Applied to `result` immediately after the first `evaluate`, BEFORE the
`latex(result)` call and before caching/formatting. This keeps `evalWithLatex`
generic (it just applies whatever transform it is given) while the solve-specific
`list → set` logic lives in the solve handler. `order_size` stripping (B) stays
inline/unconditional inside `evalWithLatex` (it is generic, not solve-specific).

**Ordering inside `evalWithLatex`:**
1. `result = await evaluate(giacExpr)`
2. `if (resultTransform) result = resultTransform(result)`  (D, solve only)
3. `result = stripOrderTerm(result)`  (B, generic, unconditional)
4. `latex = stripQuotes(await evaluate(\`latex(${result})\`))` then existing replace chain (A)
5. cache + `formatToolResponse`

Because `result` is cleaned before `latex(result)`, the LaTeX is automatically
clean too (no separate order_size strip on the LaTeX string needed).

## Component designs

### A — `latex()` quote stripping

In `evalWithLatex`, before the existing `\dfrac`/`\displaystyle` replace chain,
strip a matching pair of surrounding literal double-quotes:

```ts
if (rawLatex.length >= 2 && rawLatex.startsWith('"') && rawLatex.endsWith('"')) {
  rawLatex = rawLatex.slice(1, -1);
}
```

Guard: strip only when BOTH ends are quotes (never touch quote-free LaTeX). The
existing `!rawLatex.startsWith('latex')` guard is preserved (checked on the
original value, before stripping).

### B — `order_size` remainder stripping

A pure helper `stripOrderTerm(expr: string): string`:

- If `expr` does not contain `order_size`, return it unchanged.
- Split `expr` at top-level `+`/`-` (depth-aware over `()[]{}`), preserving each
  term's leading sign.
- Drop any term containing `order_size`.
- Re-join. If the result is empty (should not happen for valid series), return
  the original.

Confirmed safe globally: no operation other than series/taylor emits
`order_size`. Handles both `x^5*order_size(x)` (center 0) and
`(x-1)^4*order_size(x-1)` (non-zero center).

### C — boxed fail-safe extraction

Rework the boxed branch of `extractModelAnswer` in `answer-parser.ts`:

- Collect ALL `\boxed{` start indices (not just `lastIndexOf`).
- For each, attempt to balance braces to find its closing `}` at depth 0.
- Keep the **last one that balances completely** and return its (cleaned) inner
  content.
- If none balance completely, fall through to the next extraction method
  (current behavior).

This recovers cases where the model emits a complete box followed by an
incomplete one (the #55/#57 pattern): the earlier complete box wins.

### D — `list[...]` → clean set/tuple

A pure helper `listToSet(raw: string): string` (lives with the solve handler):

1. Trim. Strip an optional leading `list` prefix → leaves `[...]` or `[]`.
2. If it is not bracket-enclosed, return `raw` unchanged (defensive).
3. Split the inner content at top-level commas (depth-aware).
4. Map members:
   - 0 members → `{}`
   - members are themselves `[a,b]` (tuple/system) → each → `(a, b)`; one tuple →
     `(a, b)`, multiple → `{(a,b), (c,d)}`
   - 1 scalar member → bare (`3`)
   - ≥2 scalar members → `{a, b, ...}`
5. On any parse failure, return `raw` (never throw).

| Giac raw | Clean form |
|---|---|
| `list[-2,2]` | `{-2, 2}` |
| `list[3]` | `3` |
| `list[[2,1]]` | `(2, 1)` |
| `list[i,-i]` | `{i, -i}` |
| `[]` | `{}` |

Solve handler(s) pass `listToSet` as the `resultTransform`. Separately,
`normalize.ts` `buildData` `set` case adds the `/^list\[(.+)\]$/` alternative so
the `format: 'json'` path structures the real Giac format correctly.

## Error handling

- **A:** only strips a matched quote pair; quote-free LaTeX untouched.
- **B:** non-series results (no `order_size`) pass through unchanged; empty
  result guard returns original.
- **D:** any malformed/unparseable list returns the raw string; helper never
  throws, so a parsing surprise degrades to today's behavior rather than crashing.
- All four are additive/defensive: a failure of any cleanup yields the current
  (pre-change) output, never an error.

## Testing strategy (TDD — failing test first)

- **A (integration, giac-bridge):** assert the `latex` field has no leading or
  trailing `"` for `factor`, `solve`, `integrate`, `series`.
- **B:** `stripOrderTerm` unit tests + integration: series/taylor `result` and
  `latex` contain no `order_size`; center 0 and non-zero; idempotent on
  order-free input.
- **C:** pure-string unit tests in the benchmark grader suite: complete box then
  incomplete box → previous complete box; single box; nested braces inside a box;
  no box → falls through.
- **D:** `listToSet` unit tests for every row in the table above, plus the empty
  `[]` case and a malformed-input passthrough; `normalize.ts` `set` buildData test
  with `list[...]` input.

## Affected files

| File | Change |
|---|---|
| `src/server/tools/giac-eval.ts` | A (quote strip), B (`stripOrderTerm`), `resultTransform` hook |
| solve handler (`compute/router.ts` and/or `advanced-solve-service.ts`) | pass `listToSet` transform (D) |
| `src/server/tools/compute/normalize.ts` | add `list[...]` regex to `set` buildData (D) |
| `benchmark/graders/answer-parser.ts` | boxed fail-safe (C) |
| `test/*` (giac-bridge, new unit tests) | A/B/C/D coverage |

## Out of scope (later tiers)

- Tier 2: round-trip verification inside `compute`, dual-method cross-check.
- Tier 3: structured Giac error detection + agent retry/feedback, deterministic
  syntax normalizer.
- Deferred study: GLM-5.1 failure-trace triage (tool-loss / capable-but-erring /
  incapable buckets) on fresh benchmark output.
