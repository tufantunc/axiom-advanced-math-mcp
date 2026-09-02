# A+B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-apply the regex-form hygiene the ode merges rewrote, put a trust boundary on fraction claims, pin the conjunction boundary, and convert the eight last-element reads to honest `.at()` typing.

**Architecture:** Three commits per the spec. Byte-identity probe for the three String.raw sites; behavioral probes before pinning B1 outcomes.

**Spec:** `docs/superpowers/specs/2026-09-02-merge-residue-deferred-design.md`

## Global Constraints

- Work only in `/Users/tufantunc/Desktop/Projects/Personal/axiom-advanced-math-mcp/.claude/worktrees/fix-batch2b`, branch `fix/merge-residue-and-deferred`.
- String.raw conversions must pass the same runtime byte-identity probe as batch 2 (old vs new `.source`).
- B1 constant: `TRUSTED_FRACTION_DENOMINATOR = 1000`, defined once in exact-arithmetic.ts with the rationale comment.
- B3: no `!` non-null assertions (lint warns); no fallback that masks a value the old code used.
- Gates per commit: format:check, lint 0, typecheck, unit; integration once at the end. Do not push.

---

### Task 1 (C1): merge residue + S2310

- [ ] Convert `ode-system-shape.ts:436` and `self-verify.ts:498,505` templates to `String.raw` (locate by the escaped `\\b`/`\\s` spellings; run the probe on all three).
- [ ] `self-verify.ts:296` `[A-Za-z0-9_]` → `\w`; merge lines 3-4 into one `output-cleanup.js` import.
- [ ] `self-verify.ts:415-428`: rewrite the split loop as `let i = 0; while (i < t.length) { ... }` where consuming a conjunction sets `i = start` directly and the default branch does `i++` — identical traversal, no in-loop assignment to the loop variable.
- [ ] Gates + commit `refactor: re-apply the regex-form and import hygiene the ode merges rewrote`.

### Task 2 (C2): fraction trust boundary + conjunction pin

- [ ] exact-arithmetic.ts: `const TRUSTED_FRACTION_DENOMINATOR = 1000;` (comment: intentional fractions live far below; above it the double alone cannot justify a fraction claim — probe: sin(pi/5) vs 22/7 vs 355/113); gate the fraction return on `den <= TRUSTED_FRACTION_DENOMINATOR`, else fall through to Giac.
- [ ] Probe outcomes, then pin in quick-calc.test.ts (same describe as the earlier fraction pins): `sin(pi/5)` no longer `4456/7581` — assert the Giac symbolic (probe first) and `not.toContain('4456/7581')`; keep-pins `22/7`, `355/113`, `2/3` unchanged fast-path; `sin(pi/7)` still symbolic.
- [ ] verify-ode-solution.test.ts spellings table: add `["y'=y and_1*y(0)=1", <decline shape>]` — read neighboring decline rows for the exact assertion convention first; verify the current engine actually declines (probe) before pinning.
- [ ] Gates + commit `fix: refuse fraction claims a double cannot justify`.

### Task 3 (C3): honest .at() at eight sites

Per-site, reading context first; the two designed conversions:
- mathjs-tasks.ts:501 — guard inversion around `current.at(-1)`.
- tasks.ts:93 — `[row[row.length - 1]]` → `[row[k]]`.
The other six: convert where an existing guard or an honest fallback (one
that preserves today's empty-input behavior) makes it clean; leave any site
that would need a mask, with rationale in the commit message.
- [ ] Read each site's enclosing function; apply or document.
- [ ] Full gates incl. integration + commit `refactor: honest .at() typing at the last-element reads`.

### Task 4: review-pro (sequential)

Correctness (read-only; byte-identity + trust-boundary semantics + S2310 traversal equivalence), then the mutation tests reviewer alone (fraction boundary mutations, .at() reverts, conjunction-row removal).
