# SonarQube Batch 1b — String/array modernization rules

Date: 2026-08-31
Branch: `fix/sonarqube` (follows the S7773 batch on the same branch)
Rules: S7781, S6594, S7755, S7780, S7765, S6606, S4138, S2933, S7786,
S6582, S5906, S6551 (Batch 1 remainder).

## Problem

After S7773, the remaining Batch 1 SonarQube findings are string/array
modernization rules. A fresh audit of the current branch found **84 sites**
(scan drift adjusted: two Sonar findings no longer exist in the code — S7772
`module` import in version.ts and S5869 duplicate character class — and
S7781 grew from 19 to 49 sites because the current `prefer-string-replace-all`
count includes preprocessing chains the Aug-21 scan under-counted).

**Deferred by user decision:** S7769 (`Math.hypot` ×6) moves to its own
mini-batch — it is the only rule here that is not bit-identical (hypot
reorders rounding), and this repo treats silent numerical drift as a
first-class risk. It will be done separately with golden-output comparison.

## Scope

| Group | Rule | Sites | Method |
|---|---|---|---|
| A1 | S7781 `.replace(/…/g)` → `.replaceAll(/…/g, …)` | 49 | oxlint autofix |
| A2 | S7755 `arr[arr.length-1]` → `.at(-1)` | 6 | oxlint autofix |
| A3 | S7780 `'\\x'` → `` String.raw`\x` `` | 4 | oxlint autofix |
| B1 | S6594 `str.match(re)` → `re.exec(str)` | 14 | manual |
| B2 | S7765 `.some(t => t === 0)` → `.includes(0)` | 1 | manual |
| B2 | S6606 `if (primary === null) primary = …` → `??=` | 1 | manual |
| B2 | S4138 index `for` → `for…of` | 1 | manual |
| B2 | S2933 field → `readonly` | 1 | manual |
| B2 | S7786 `new Error` → `new TypeError` (type-check throws) | 2 | manual |
| B2 | S6582 `!x || x.f` → `x?.f` | 2 | manual |
| B3 | S6551 `String(args.claim ?? '')` → typeof guard | 1 | manual |
| C | S5906 generic assertions → `toHaveLength` | 2 | manual (tests) |

## Approach (chosen: oxlint guard + autofix, manual remainder)

Same pattern as S7773. Enable three unicorn rules in `.oxlintrc.json`
(`prefer-string-replace-all`, `prefer-at`, `prefer-string-raw` at `warn`),
run `npm run lint:fix` for groups A1–A3, then apply the manual edits for
B1–B3 and C. The rules stay enabled afterwards as regression guards. The
`unicorn` plugin is already active (S7773), so no new category rules switch
on as a side effect (verified: current lint is at 0 warnings).

Rejected: fully manual (slower, no guard); autofix-only (leaves 25 findings).

## Semantic safety argument (verified site-by-site during design)

- **A1 replaceAll:** all 49 sites use a `/g` regex; the autofix only renames
  the method and keeps the regex verbatim (probe-verified on scratch copies).
  `replaceAll` accepts a global regex with identical matching and replacement
  semantics, including capture-group tokens like `'$1 deg'`. Backtracking
  behavior is unchanged (relevant because these include the preprocessing
  degree/combinatorics regexes the performance pack tracks).
- **A2 `.at(-1)`:** identical value for the observed `arr[arr.length - 1]`
  pattern; `.at` returns `undefined` out of range just like the bracket form.
- **A3 String.raw:** produces the same string value; the regex literal it
  feeds is unchanged.
- **B1 match→exec:** `str.match(re)` and `re.exec(str)` return the same
  object for a non-global regex. All 14 sites verified non-global:
  exact-value.ts:41, numerical-methods.ts:265, verify/index.ts:292 (×2, one
  line), 319, 332, normalize.ts:132–135, extractors.ts:79, 375, 388, 474.
  The four GLOBAL match sites (quick-calc-service.ts:19, compute/router.ts:68,
  extractors.ts:66, 86 — the `(x.match(/re/g) || []).length` counting idiom)
  are NOT flagged by Sonar and must not be touched.
- **B2 singles:** `??=` at solve.ts:95 — `primary` is only ever `null` or an
  object, so `primary ??= {…}` ≡ `if (primary === null) primary = {…}`.
  Optional chaining at geometry3d/vec.ts:14 and hypothesis-testing.ts:123 —
  truth tables verified identical (`x?.length !== n` is true when `x` is
  undefined, matching `!x || x.length !== n`). `TypeError` at cli/render.ts:70
  and giac/wasm-wrapper.ts:123 — both are type-shape validation throws; all
  nearby catches use `err instanceof Error ? err.message : …`, which still
  matches a TypeError subclass. `readonly` on quick-calc-service.ts `math` —
  assigned once in the constructor only. `includes(0)` ≡ `some(t => t === 0)`
  for numbers. `for…of` over `(PlotPoint | null)[]` at plot/evaluator.ts:92.
- **B3 claim:** `typeof args.claim === 'string' ? args.claim : ''` — for the
  schema-valid string input identical to `String(args.claim ?? '')`; for a
  hypothetically malformed object payload it yields `''` instead of
  `'[object Object]'` — a defensive improvement, not a regression.
- **C assertions:** `toHaveLength` is strictly stronger than the generic
  checks it replaces (bench-math-levels.test.ts:53, http-app.test.ts:170).

## Commit strategy

Two commits:
1. `refactor: prefer replaceAll/at/String.raw over legacy forms` —
   `.oxlintrc.json` + the 59 autofixed sites (purely mechanical diff).
2. `refactor: modernize match/some/for/optional-chain and error types` —
   the 23 manual code sites + 2 test assertions, rule-by-rule in the message.

## Verification

All five gates (`npm run typecheck`, `npm run lint`, `npm test`,
`npm run test:integration`) plus diff-purity checks: in commit 1 only the
three intended patterns may change and regex literals must be byte-identical
to their pre-image; in commit 2 each manual site is reviewed against this
spec's safety argument. Then a review-pro pass over both commits
(correctness + tests + performance dispatch — performance because A1 touches
the preprocessing regex set).
