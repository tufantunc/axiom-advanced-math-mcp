# Sonar Batch 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the ~50 quick-win Sonar findings: concise character classes, String.raw template regexes, single-site modernizations, and test-hygiene fixes.

**Architecture:** Three commits matching the spec's groups. The only safety-critical invariant is G2's: every converted template must produce byte-identical RegExp source / string value — proven by a probe that builds each pattern old-form and new-form and compares.

**Tech Stack:** TypeScript, vitest (real Giac engine for touched suites).

**Spec:** `docs/superpowers/specs/2026-09-02-sonar-batch2-design.md`

## Global Constraints

- Work only in `/Users/tufantunc/Desktop/Projects/Personal/axiom-advanced-math-mcp/.claude/worktrees/fix-sonar-batch2`, branch `fix/sonar-batch2`.
- G1 letter-class rule: `[A-Za-z0-9_]` → `\w` and `[^A-Za-z_0-9]` → `\W` are safe; under `/i`, `[A-Za-z]` reduces to `[a-z]` — NEVER to `\w` where letter-first semantics matter (verify/index.ts:330 keeps `([a-z]\w*` + `/i`).
- G2 rule: only the template wrapper changes — `\\b` becomes String.raw`\b` etc.; interpolations stay; flags strings stay; the probe proves `.source` equality for every `new RegExp` site and string equality for the two LaTeX templates.
- Gates per commit: lint 0, typecheck, unit suite; integration once at the end. Do not push.
- S7718 rename: use `error` unless that shadows a binding in the same function scope (check each site); then `error_`.
- Do NOT touch: S6551 mathjs-tasks.ts:403 (false positive, mathjs types implement toString).

---

### Task 1 (Commit 1): G1 character classes + G2 String.raw templates

**Files:** calculus.ts, compute/silent-failure.ts, self-verify.ts, verify/index.ts, compute/extractors.ts, ode-system.ts, ode-system-shape.ts, output-cleanup.ts, exact-arithmetic.ts, exact-value.ts.

- [ ] **Step 1 — G1 edits (7 lines):**

```ts
// calculus.ts:251 and :308 (identical regex, two lines)
/(^|[^A-Za-z_0-9])infinity([^A-Za-z_0-9]|$)/  ->  /(^|\W)infinity(\W|$)/
// compute/silent-failure.ts:30
/(^|[^A-Za-z_0-9])Inf([^A-Za-z_0-9]|$)/  ->  /(^|\W)Inf(\W|$)/
// self-verify.ts:289
/[A-Za-z0-9_]/.test(...)  ->  /\w/.test(...)
// self-verify.ts:310
/^and(?![A-Za-z0-9_])/i  ->  /^and(?!\w)/i
// self-verify.ts:312
/^(?:and|or)(?![A-Za-z0-9_])/i  ->  /^(?:and|or)(?!\w)/i
// verify/index.ts:330 — letter-first is load-bearing; only the duplicate halves go
/^(.+?)\s+at\s+([A-Za-z]\w*)\s*=.../i  ->  /^(.+?)\s+at\s+([a-z]\w*)\s*=.../i
```

- [ ] **Step 2 — G2 edits (13 RegExp templates + 2 LaTeX templates):** wrap each template in `String.raw` and halve the backslashes, e.g.

```ts
// extractors.ts:528
new RegExp(`\\b${escaped}\\b`)  ->  new RegExp(String.raw`\b${escaped}\b`)
// ode-system-shape.ts:428
new RegExp(`\\b(${functions.join('|')})\\s*\\(\\s*${variable}\\s*\\)`, 'g')
  ->  new RegExp(String.raw`\b(${functions.join('|')})\s*\(\s*${variable}\s*\)`, 'g')
// ode-system-shape.ts:436 — same form, no flags
// ode-system.ts:299
new RegExp(`\\b(tan|cotan|tanh)\\s*\\([^)]*\\b${variable}\\b`)
  ->  new RegExp(String.raw`\b(tan|cotan|tanh)\s*\([^)]*\b${variable}\b`)
// output-cleanup.ts:169
new RegExp(`^(.*?)([+-]?(?:${GIAC_NUMBER}\\*?)?)i$`)
  ->  new RegExp(String.raw`^(.*?)([+-]?(?:${GIAC_NUMBER}\*?)?)i$`)
// self-verify.ts:478,485,490,492,495,496 — the six chain templates, same form;
//   492 keeps (?!['\s]*\() as (?!['\s]*\()  i.e. String.raw`\b${fn}('+)(?!['\s]*\()`
// self-verify.ts:506,515
new RegExp(`\\b${fn}\\b`)  ->  new RegExp(String.raw`\b${fn}\b`)
// exact-arithmetic.ts:37
`${sign}\\frac{${absNum}}{${den}}`  ->  String.raw`${sign}\frac{${absNum}}{${den}}`
// exact-value.ts:78
`${num < 0 ? '-' : ''}\\frac{${Math.abs(num)}}{${den}}`
  ->  String.raw`${num < 0 ? '-' : ''}\frac{${Math.abs(num)}}{${den}}`
```

- [ ] **Step 3 — byte-identity probe:** a throwaway script (deleted after) that constructs each of the 15 patterns in BOTH forms with representative interpolation values (`fn='y'`, `v='x'`, `variable='x'`, `functions=['f','g']`, `escaped='x'`, `GIAC_NUMBER` literal from the module, `sign='-'`, `absNum=1`, `den=2`, `num=-1`) and asserts `old.source === new.source` (RegExp) or string equality (LaTeX). All 15 must match.

- [ ] **Step 4 — gates + commit:**

```bash
npm run lint 2>&1 | grep Found && npm run typecheck && npm test 2>&1 | grep -E "Test Files|Tests "
git add src/ && git commit -m "refactor: concise character classes and String.raw template regexes"
```

---

### Task 2 (Commit 2): G3 singles + mu0 message

**Files:** calculus.ts, js-compute/mathjs-tasks.ts, giac/cache.ts, js-compute/host.ts, output-cleanup.ts, compute/arg-parsing.ts, plot/evaluator.ts, hypothesis-testing.ts, ode-system.ts, compute/extractors.ts (+ any test pinning the mu0 message).

- [ ] **Step 1 — the ten modernizations (each verified in place):**

```ts
// calculus.ts:367
.then((r) => String(r))  ->  .then(String)
// mathjs-tasks.ts:463
if (firstError === undefined) { firstError = e instanceof Error ? e.message : String(e); }
  ->  firstError ??= e instanceof Error ? e.message : String(e);
// giac/cache.ts:46
private cache = new Map<string, CacheEntry>();  ->  private readonly cache = ...
// host.ts:128 and :132 pattern (read the exact lines; same shape as before)
if (!p || p.phase !== 'queued') return;  ->  if (p?.phase !== 'queued') return;
// output-cleanup.ts:204
throw new Error(`unparseable complex term: ${term}`);  ->  throw new TypeError(...)
// arg-parsing.ts:197 — both comparisons
(s[0] === '(' || s[0] === '[')  ->  (s.startsWith('(') || s.startsWith('['))
// evaluator.ts:22 — re-export from origin; keep local imports that are used
export type { PlotPoint, PlotSegment };
  ->  export type { PlotPoint, PlotSegment } from '../../js-compute/index.js';
      (drop those two names from the local import if not otherwise used)
// hypothesis-testing.ts:86 — hoist the default
const DEFAULT_ONE_SAMPLE_REPORT = { name: 'One-sample t-test', parameter: 'μ' } as const;
report: {...} = DEFAULT_ONE_SAMPLE_REPORT
// ode-system.ts:438,534 — rename catch param `failure` -> `error` (check for a
// same-scope `error` binding first; use `error_` only if shadowed)
// extractors.ts:992,994 — delete the redundant block braces around
// `const parsed = callArgs.positional;` and the inner if-block; de-indent;
// confirm `parsed` is not referenced past the block's end
```

- [ ] **Step 2 — mu0 message (hypothesis-testing.ts:545):**

```ts
return `mu0 must be a finite number, got ${String(mu0)}`;
  ->  return `mu0 must be a finite number, got ${JSON.stringify(mu0)}`;
```
Grep tests for the old message; update any pin (numbers stringify identically: `3` -> `3`).

- [ ] **Step 3 — gates + commit** (same as Task 1; message: `refactor: single-site modernizations across the tool layer`).

---

### Task 3 (Commit 3): G4 test hygiene

**Files:** test/cas-session-lock.test.ts, test/handler-seam.test.ts, test/input-bounds.test.ts, test/advanced-solve.test.ts.

- [ ] **Step 1 — S5914, the vacuous assertion (cas-session-lock.test.ts:44-51):**

```ts
  it('is not wedged by a double release', async () => {
    const m = createMutex();
    const release = await m.acquire();
    release();
    release();
    // A second holder must still be able to take it exactly once.
    const second = await m.acquire();
    second();
    expect(true).toBe(true);
  });
```

becomes:

```ts
  it('is not wedged by a double release', async () => {
    const m = createMutex();
    const release = await m.acquire();
    release();
    release();
    // A second and third holder must still be able to take it — the double
    // release must not have wedged the mutex or handed it out twice.
    const second = await m.acquire();
    expect(typeof second).toBe('function');
    second();
    const third = await m.acquire();
    expect(typeof third).toBe('function');
    third();
  });
```

- [ ] **Step 2 — S5906 ×3:** read the three assertions (handler-seam.test.ts:884, input-bounds.test.ts:782,783) and replace with the length/equality form Sonar suggests (e.g. `expect(t.match(/result is infinite/g)).toHaveLength(n)` — pin the ACTUAL count from the fixture, not `>0`).

- [ ] **Step 3 — S8782 ×2:** move the two hooks in advanced-solve.test.ts (lines ~25,29) above the first test case in their scope.

- [ ] **Step 4 — full gates incl. integration + commit** (`test: replace vacuous and generic assertions, order hooks`).

---

### Task 4: review-pro (sequential)

Correctness reviewer first (read-only, confirms the byte-identity invariant and the S7718/S1199 scoping), then the mutation tests reviewer ALONE last (mutation matrix over G1/G2 regex equivalence and the S5914 pin).
