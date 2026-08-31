# SonarQube Batch 1b Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clear the remaining Batch 1 SonarQube rules (84 sites): 59 via oxlint autofix (replaceAll/at/String.raw), 25 via manual modernization (match→exec, includes, ??=, for-of, readonly, TypeError, optional chaining, typeof-guard, toHaveLength).

**Architecture:** Same guard+autofix pattern as S7773 — enable three unicorn rules in `.oxlintrc.json`, run `npm run lint:fix`, then apply 25 manual edits with per-site before/after specified below. Two commits: mechanical autofix first, manual modernization second.

**Tech Stack:** oxlint 1.51.0 (already configured with the `unicorn` plugin), TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-08-31-sonar-batch1b-design.md`

## Global Constraints

- Work only inside `/Users/tufantunc/Desktop/Projects/Personal/axiom-advanced-math-mcp/.claude/worktrees/fix-sonarqube`, branch `fix/sonarqube`. The main checkout belongs to another session — never touch it.
- Node >= 20 (replaceAll/.at/??=/String.raw all safe), TS target ES2022.
- **Never modify these four GLOBAL match sites** (they use the counting idiom and are out of scope): `quick-calc-service.ts:19`, `compute/router.ts:68`, `compute/extractors.ts:66`, `compute/extractors.ts:86`.
- In commit 1, regex literals must stay **byte-identical** — only the `.replace(` → `.replaceAll(` method name, `[arr.length - 1]` → `.at(-1)`, and `'\\x'` → `` String.raw`\x` `` shapes may change.
- S7769 (Math.hypot ×6) is OUT of scope by user decision — do not touch `Math.sqrt(x*x + y*y)` sites.
- CI gates in order: `npm run typecheck`, `npm run lint` (0 warnings expected at each commit), `npm test`, and `npm run test:integration` once at the very end (slow, builds first).
- Do not push.

---

### Task 1: Enable 3 rules, autofix 59 sites, commit

**Files:**
- Modify: `.oxlintrc.json`
- Modify (autofix): 15 files under `src/server/tools/` (unicode-normalize, svg-renderer, quick-calc-preprocessor, combinatorics, combinatorics-rewrite, compute/extractors, exact-arithmetic, giac-eval, multivariable/optimization, symbolic/handler, advanced-solve-service, number-utils, sequence-utils, and any others the fixer reaches)

**Interfaces:**
- Consumes: nothing.
- Produces: lint config with three more guarded rules; a purely mechanical diff of 59 sites.

- [ ] **Step 1: Add the three rules to `.oxlintrc.json`**

The `rules` object gains three entries (inserted after `"unicorn/prefer-number-properties": "warn"`):

```json
    "unicorn/prefer-number-properties": "warn",
    "unicorn/prefer-string-replace-all": "warn",
    "unicorn/prefer-at": "warn",
    "unicorn/prefer-string-raw": "warn"
```

(plugins stays `["typescript", "unicorn"]` — already present from S7773.)

- [ ] **Step 2: Run the autofix**

Run: `npm run lint:fix`
Expected: exit 0. A following `npm run lint` must report `Found 0 warnings and 0 errors` (the fixer resolves everything it flagged; probe runs showed all three rules fix cleanly).

- [ ] **Step 3: Diff purity — three shapes only**

Run: `git diff -U0 src/ | grep -E "^[+-]" | grep -vE "^(\+\+\+|---)" | grep -vE "replaceAll|String.raw|\.at\("`
Expected: only the mirror (minus) lines of the three shapes — i.e. every remaining printed line starts with `-` and contains `.replace(`, `[...length - 1]`, or a `'\\\\` string literal. No `+` lines outside the three shapes.

Run: `git diff src/ | grep -E "^-" | grep -oE "/.*/[a-z]*," | sort > /tmp/regex-before.txt; git diff src/ | grep -E "^\+" | grep -oE "/.*/[a-z]*," | sort > /tmp/regex-after.txt; diff /tmp/regex-before.txt /tmp/regex-after.txt`
Expected: empty (regex literals byte-identical).

- [ ] **Step 4: Typecheck + unit tests**

Run: `npm run typecheck && npm test`
Expected: typecheck exit 0; all tests pass (779 as of planning; 0 failures is the invariant).

- [ ] **Step 5: Commit**

```bash
git add .oxlintrc.json src/
git commit -m "refactor: prefer replaceAll, at() and String.raw over legacy forms

Enable three more unicorn rules in oxlint and autofix all 59 sites:
.replace(/…/g, …) -> .replaceAll(/…/g, …) (identical for global regexes,
the pattern is kept verbatim), arr[arr.length - 1] -> arr.at(-1), and
'\\\\x' string literals -> String.raw`\\x` (same string value). The rules
stay enabled as regression guards."
```

---

### Task 2: Manual modernization — 25 sites, commit

**Files:**
- Modify: `src/server/tools/compute/extractors.ts` (4 sites), `src/server/tools/compute/normalize.ts` (4), `src/server/tools/verify/index.ts` (5), `src/server/tools/exact-value.ts` (1), `src/server/tools/numerical-methods.ts` (1), `src/server/tools/sequence-utils.ts` (1), `src/server/tools/solve.ts` (1), `src/server/tools/plot/evaluator.ts` (1), `src/server/tools/geometry3d/vec.ts` (1), `src/server/tools/hypothesis-testing.ts` (1), `src/server/tools/quick-calc-service.ts` (1), `src/cli/render.ts` (1), `src/server/giac/wasm-wrapper.ts` (1), `test/bench-math-levels.test.ts` (1), `test/http-app.test.ts` (1)

**Interfaces:**
- Consumes: Task 1's autofixed tree.
- Produces: clean Sonar batch-1b tree; `npm run lint` stays at 0 warnings.

#### B1 — match → exec (14 sites, all verified non-global)

- [ ] **Step 1: extractors.ts (4 sites)**

```ts
// extractors.ts:79 — was: const match = problem.match(/(\[\s*\[[\s\S]*\]\s*\])/);
const match = /(\[\s*\[[\s\S]*\]\s*\])/.exec(problem);

// extractors.ts:375 — was: const combMatch = trimmed.match(/^[Cc](?:omb)?\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/);
const combMatch = /^[Cc](?:omb)?\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(trimmed);

// extractors.ts:388 — was: const permMatch = trimmed.match(/^[Pp](?:erm)?\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/);
const permMatch = /^[Pp](?:erm)?\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(trimmed);

// extractors.ts:474 — was: const kvMatch = part.match(/(\w+)\s*=\s*([\d.eE+-]+)/);
const kvMatch = /(\w+)\s*=\s*([\d.eE+-]+)/.exec(part);
```

- [ ] **Step 2: normalize.ts (4 sites, one chained expression)**

```ts
// normalize.ts:132-135 — was: trimmed.match(/^\{(.+)\}$/) || trimmed.match(...) x4
      const setMatch =
        /^\{(.+)\}$/.exec(trimmed) ||
        /^\[(.+)\]$/.exec(trimmed) ||
        /^list\[(.+)\]$/.exec(trimmed) ||
        /^list\((.+)\)$/.exec(trimmed);
```

- [ ] **Step 3: verify/index.ts (4 sites on 3 lines)**

```ts
// verify/index.ts:292 — was: giacOutput.match(/^\[(.+)\]$/)?.[1] || giacOutput.match(/^list\((.+)\)$/)?.[1] || ''
    /^\[(.+)\]$/.exec(giacOutput)?.[1] || /^list\((.+)\)$/.exec(giacOutput)?.[1] || '';

// verify/index.ts:319 — was: const solutionMatch = claim.match(\n  /(\w+)…/i\n);
  const solutionMatch =
    /(\w+)\s*=\s*([^,\s]+)\s+(?:satisfies|is\s+(?:a\s+)?solution\s+(?:of|to))\s+(.+)/i.exec(claim);

// verify/index.ts:332 — was: const atMatch = claim.match(/^(.+?)\s+at\s+…/i);
  const atMatch = /^(.+?)\s+at\s+([A-Za-z]\w*)\s*=\s*([^=\s,]+)\s*=\s*(.+)$/i.exec(claim);
```

- [ ] **Step 4: exact-value.ts + numerical-methods.ts**

```ts
// exact-value.ts:41 — was: const fracMatch = value.match(/^(-?\d+)\s*\/\s*(-?\d+)$/);
const fracMatch = /^(-?\d+)\s*\/\s*(-?\d+)$/.exec(value);

// numerical-methods.ts:265 — was: const resultMatch = lastLine.match(/(?:Root|Result)[:\s]*(.+)/);
const resultMatch = /(?:Root|Result)[:\s]*(.+)/.exec(lastLine);
```

#### B2 — nine single-site modernizations

- [ ] **Step 5: sequence-utils.ts — includes**

```ts
// was: if (terms.some((t) => t === 0)) return null;
if (terms.includes(0)) return null;
```

- [ ] **Step 6: solve.ts — nullish assignment**

```ts
// was: if (primary === null) primary = { giacExpr, verification, note: undefined };
primary ??= { giacExpr, verification, note: undefined };
```

- [ ] **Step 7: plot/evaluator.ts — for-of**

```ts
// was:
// for (let i = 0; i < allPoints.length; i++) {
//   const pt = allPoints[i];
for (const pt of allPoints) {
```

(Delete the `const pt = allPoints[i];` line; the loop body is unchanged.)

- [ ] **Step 8: quick-calc-service.ts — readonly**

```ts
// was: private math: MathJsInstance;
private readonly math: MathJsInstance;
```

- [ ] **Step 9: TypeError at two type-check throws**

```ts
// src/cli/render.ts:70 — was: throw new Error(`verify returned no verdict: ${json.slice(0, 200)}`);
throw new TypeError(`verify returned no verdict: ${json.slice(0, 200)}`);

// src/server/giac/wasm-wrapper.ts:123 — was: throw new Error(\n  'caseval function not found in Giac WASM module.\n' + …
throw new TypeError(
  'caseval function not found in Giac WASM module.\n' +
    'Build flags: -s EXPORTED_FUNCTIONS=[\'_caseval\'] -s EXPORTED_RUNTIME_METHODS=["cwrap"]'
);
```

(Both throws follow a `typeof`/shape check; nearby catches use `err instanceof Error ? err.message : …`, which still matches a TypeError.)

- [ ] **Step 10: optional chaining (2 sites)**

```ts
// geometry3d/vec.ts:14 — was: if (!list || list.length !== n || list.some((x) => !Number.isFinite(x))) {
if (list?.length !== n || list.some((x) => !Number.isFinite(x))) {

// hypothesis-testing.ts:123 — was: if (!sample2 || sample2.length !== sample1.length)
if (sample2?.length !== sample1.length)
```

(Both: when the operand is undefined, `x?.length !== n` is `undefined !== n` → true, same verdict as the `!x ||` guard, and short-circuits before `.some`/the comparison.)

#### B3 — claim stringification guard

- [ ] **Step 11: verify/index.ts:389**

```ts
// was: const claim = rewriteCombinatorics(unicodeToAscii(String(args.claim ?? '')));
const claim = rewriteCombinatorics(unicodeToAscii(typeof args.claim === 'string' ? args.claim : ''));
```

#### C — test assertions

- [ ] **Step 12: two toHaveLength conversions**

```ts
// test/bench-math-levels.test.ts:53 — was: expect(rowsPerConfig.length).toBe(1);
expect(rowsPerConfig).toHaveLength(1);

// test/http-app.test.ts:171 — was: expect(b.json.result.tools.length).toBe(a.json.result.tools.length);
expect(b.json.result.tools).toHaveLength(a.json.result.tools.length);
```

(Line 170's `toBeGreaterThan(0)` stays — Sonar flagged only the equality form.)

- [ ] **Step 13: All gates**

Run: `npm run typecheck && npm run lint && npm test`
Expected: typecheck exit 0; `Found 0 warnings and 0 errors`; all tests pass.

Run: `npm run test:integration`
Expected: exit 0, all pass (run once, at the end).

- [ ] **Step 14: Commit**

```bash
git add src/ test/
git commit -m "refactor: modernize match/some/for/optional-chain and error types

Replace str.match(re) with re.exec(str) at the 14 non-global sites, a
value-existence some() with includes(0), a null-guard assignment with
??=, an index for-loop with for-of, and the QuickCalcService math field
gains readonly. Two type-check throws become TypeError (catches match
via instanceof Error). Two redundant guards become optional chains with
identical truth tables. The verify claim normalization now requires a
string instead of stringifying objects to '[object Object]', and two
test assertions use toHaveLength."
```
