# Tier 3 — Pre-Giac Input Normalization

**Date:** 2026-06-09
**Branch:** `cas-tier3` (worktree, based on `main` @ Tier 1+2)
**Status:** DESIGN — approved, pending implementation plan

## Background

Third phase of "pushing the CAS verification pipeline." The original Tier 3 idea
was "structured Giac error detection + a deterministic syntax normalizer." A
live probe against Giac collapsed that scope:

| Original Tier 3 piece | Reality (probed) |
|---|---|
| Syntax normalizer (implicit mult `2x`, `**`, `integrate` alias, `√`) | Giac already tolerates all of these → **unnecessary (YAGNI)** |
| Structured error detection | `undef` is already caught by `evalWithLatex`; `infinity`/empty are often **valid** answers (limits, integrals, no-real-roots); the silent-failure *warning* already exists behind the `output-hygiene` flag and was judged marginal |
| **Pre-Giac input normalization** | **Real, novel, cheap win** — unicode in the INPUT silently corrupts Giac's parse |

The one clear gap: **unicode math characters in the input expression corrupt
Giac's parse**, producing silently wrong results, and the existing `unicodeToAscii`
hygiene is applied only to OUTPUT (and only behind a flag). Probed failures:

```
factor(x²-4)  -> "(xmicro-2)*(xmicro+2)"   // ² mangled to "micro" — silently WRONG
2·x           -> "undef"                    // middot rejected
```

Notably, Giac *does* tolerate the typographic minus `−` (U+2212) and implicit
multiplication, so those need no handling.

## Goal

Normalize unicode math characters in user input **before** it reaches Giac, so
expressions like `factor(x²-4)` and `2·x` compute correctly instead of producing
corrupt or `undef` results. Deterministic, default-on, server-side. Reuses the
existing `unicodeToAscii` helper.

**Non-goals:** a syntax normalizer (Giac handles implicit mult / `**` / aliases /
`√`); structured error/failure detection (separate, marginal, and largely
covered); agent-side recovery; superscript-minus (`x⁻¹`) handling (rare, fiddly);
fraction glyphs (`½`, rare in input).

## Architecture (layered, server-side, default-on)

### 1. Extend `unicodeToAscii` (`src/server/tools/unicode-normalize.ts`)

Add one mapping for the middot multiplication sign:

```ts
.replace(/·/g, '*')   // U+00B7 middot → multiply
```

`unicodeToAscii` is a shared pure function (already used by output hygiene and the
benchmark grader normalizer), so this addition benefits every consumer and keeps
one canonical normalization. It already maps `√ π × ÷ ² ³ ⁰ ¹ ⁴⁵⁶⁷⁸⁹`.

### 2. Normalize input in `evalWithLatex` (`src/server/tools/giac-eval.ts`)

At the very top of `evalWithLatex`, before computing `cacheKey` and before any
Giac call:

```ts
const giacExpr = unicodeToAscii(options.giacExpr);
```

(Destructure the rest of `options` as today; derive `giacExpr` from the normalized
value.) This covers every compute operation routed through `evalWithLatex`
(factor, simplify, expand, partial_fractions, solve, solve_system, differentiate,
integrate, limit, taylor, matrix ops, …). ASCII input is unchanged (the function
only rewrites specific unicode glyphs), so there is no over-matching risk.

**Cache benefit:** because normalization happens before `cacheKey`, `factor(x²-4)`
and `factor(x^2-4)` resolve to the same cache entry.

### 3. Normalize `claim` in the `verify` tool (`src/server/tools/verify/index.ts`)

The `verify` tool takes a user `claim` string (e.g. `"x² = x·x"`). Normalize it at
the start of the handler, before the claim is parsed into LHS/RHS or a
solution-check:

```ts
const claim = unicodeToAscii(rawClaim);
```

## Data flow

`computeHandler({ problem: 'factor(x²-4)' })` → router builds `factor(x²-4)` →
dispatch → `evalWithLatex({ giacExpr: 'factor(x²-4)', … })` → `unicodeToAscii`
→ `factor(x^2-4)` → Giac → `(x-2)*(x+2)`. Without normalization the same input
yields `(xmicro-2)*(xmicro+2)`.

## Error handling

- `unicodeToAscii` is a pure, total string function — it cannot throw and leaves
  unmatched characters untouched. A non-unicode expression passes through byte for
  byte.
- No new failure paths. Normalization only widens the set of inputs Giac parses
  correctly; it never changes a previously-correct result (ASCII is a fixed point).

## Testing strategy (TDD — failing test first)

- **`unicode-normalize` unit:** `unicodeToAscii('2·x')` → `'2*x'`; confirm an
  existing case (`x²` → `x^2`) still holds; ASCII passthrough unchanged.
- **compute integration (real engine):**
  - `computeHandler({ problem: 'factor(x²-4)' })` → output contains
    `Result: (x-2)*(x+2)` and NOT `micro`.
  - `computeHandler({ problem: '2·x' })` → `Result: 2*x` (not `undef`).
- **verify integration (real engine):**
  - `verify({ claim: 'x² = x·x' })` → `verified: true` (after normalization to
    `x^2 = x*x`).
- **regression:** full suite green; ASCII-input tests unaffected.

## Affected files

| File | Change |
|---|---|
| `src/server/tools/unicode-normalize.ts` | add `·` → `*` mapping |
| `src/server/tools/giac-eval.ts` | normalize `giacExpr` via `unicodeToAscii` before cacheKey/eval |
| `src/server/tools/verify/index.ts` | normalize `claim` via `unicodeToAscii` at handler entry |
| tests (unit + integration) | unicode-normalize, compute, verify coverage |

## Out of scope (consistent with the narrowed Tier 3)

- Syntax normalizer (Giac tolerates implicit mult / `**` / aliases / `√` / U+2212).
- Default silent-failure warnings (remain behind the `output-hygiene` flag —
  judged marginal earlier; reversing that needs measurement, not in scope here).
- Superscript-minus (`x⁻¹`) and fraction glyphs (`½`) — rare, deferred.
- The deferred GLM-5.1 failure-trace triage.
