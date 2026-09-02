# SonarQube Batch 2 — quick wins (regex forms, singles, test hygiene)

Date: 2026-09-02
Branch: `fix/sonar-batch2` (from `main` c799ac0)
Rules: S6353, S5869, S7780, S7770, S6606, S2933, S6582, S7786, S6557,
S7763, S7737, S7718, S1199, S5906, S5914, S8782, and one of two S6551 sites.

## Problem

The 2026-09-02 scan shows 238 findings, all in this repo. Of those, ~50 are
mechanical quick wins; the rest (S3776, S7778, S5976, S3358, S4624, S8786,
S5843, S1874, S7785, S7755) stay in the backlog. This batch closes the
quick wins.

## Design (groups from the approved presentation)

**G1 — character classes (S6353 ×9, S5869 ×3, overlapping sites).**
`[^A-Za-z_0-9]` → `\W` and `[A-Za-z0-9_]` → `\w` (ASCII-identical).
Under `/i`, `[A-Za-z0-9_]` → `\w` and `[A-Za-z]\w*` keeps its letter-first
semantics by reducing to `[a-z]\w*` — never `\w+`. Sites: calculus.ts:251,308,
compute/silent-failure.ts:30, self-verify.ts:289,310,312, verify/index.ts:330.

**G2 — String.raw on template regex/LaTeX (S7780 ×15, manual — the oxlint
guard only sees plain literals).** `new RegExp(\`\\b…\`)` →
`new RegExp(String.raw\`\b…\`)` (13 sites: extractors.ts:528,
ode-system.ts:299, ode-system-shape.ts:428,436, output-cleanup.ts:169,
self-verify.ts:478,485,490,492,495,496,506,515) and the two LaTeX templates
`` `${sign}\\frac{…}` `` → `` String.raw`${sign}\frac{…}` `` (exact-arithmetic.ts:37,
exact-value.ts:78). The regex SOURCE produced at runtime must stay
byte-identical — verified by a probe that instantiates each pattern old and
new and compares `.source`.

**G3 — singles.** S7770 calculus.ts:367 `.then((r) => String(r))` →
`.then(String)`; S6606 mathjs-tasks.ts:463 `if (firstError === undefined)`
assignment → `??=`; S2933 giac/cache.ts:46 `private cache` →
`private readonly cache`; S6582 host.ts:128,132 `!p || p.phase !== 'queued'`
→ `p?.phase !== 'queued'`; S7786 output-cleanup.ts:204 parse-guard Error →
TypeError; S6557 arg-parsing.ts:197 both `s[0] === '('`/`'['` comparisons →
`startsWith`; S7763 evaluator.ts:22 re-export via `export type {…} from`;
S7737 hypothesis-testing.ts:86 object-literal default parameter → module
constant; S7718 ode-system.ts:438,534 `catch (failure)` shadows an outer
`failure` — rename the catch parameter to `err`; S1199 extractors.ts:992,994
redundant nested blocks — remove after confirming the inner bindings are not
needed outside.

**G4 — tests.** S5914 cas-session-lock.test.ts:50 `expect(true).toBe(true)`
→ a real assertion: after the double release, a third acquire resolves and
hands back a release function (double-release must not wedge the mutex).
S5906 ×3 (handler-seam.ts:884, input-bounds.ts:782,783) → length/equality
assertions per Sonar's suggestions. S8782 advanced-solve.test.ts:25,29 →
move the hooks above the test cases they serve.

**G5 — deliberate non-fix.** S6551 at mathjs-tasks.ts:403 is a false
positive: `String(raw)` on mathjs values (Unit/Matrix/Complex all implement
`toString`) is correct and Sonar cannot know that. The OTHER S6551 site
(hypothesis-testing.ts:545, `String(mu0)` inside an error message) is real:
`JSON.stringify(mu0)` — an object input renders readably instead of
'[object Object]'.

## Commits

1. `refactor: concise character classes and String.raw template regexes` —
   G1+G2 with the byte-identity probe.
2. `refactor: single-site modernizations (starts-with, ??=, readonly, …)` — G3
   including the mu0 `JSON.stringify` message improvement; any test pinning
   the old message is updated in the same commit.
3. `test: replace vacuous and generic assertions, order hooks` — G4.

## Verification

Five gates per commit batch; the G2 regex-source byte-identity probe; then
review-pro with correctness first and the mutation tests reviewer last and
alone. ReDoS posture must not change: G1/G2 alter source text byte-identically
or trivially (class notation), which the correctness reviewer confirms on the
S8786-flagged patterns.
