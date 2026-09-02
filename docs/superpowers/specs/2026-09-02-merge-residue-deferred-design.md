# Merge residue + deferred review items (A + B)

Date: 2026-09-02
Branch: `fix/merge-residue-and-deferred` (from `main` b583aff)
Sonar rules: S7780 ×3, S6353 ×1, S3863 ×2, S2310 ×1, S7755 ×8; plus two
deferred review findings.

## Problem

1. **Merge residue.** The ode-conditions merges rewrote lines our batch-2
   String.raw/class concision had touched, restoring three escaped templates
   (`ode-system-shape.ts:436`, `self-verify.ts:498,505`), one verbose class
   (`self-verify.ts:296`), a duplicated `output-cleanup.js` import
   (`self-verify.ts:3-4`), and an in-loop index reassignment
   (`self-verify.ts:424`, S2310) in the newly split conjunction logic.
2. **floatToFraction certifies approximations as exact** (correctness-review
   finding): a convergent of ANY double can land within the 1e-9 acceptance
   window — `sin(pi/5)` answers `Result: 4456/7581` while `sin(pi/7)` and
   `√2/2` correctly get their symbolic forms. Theory cannot fix this (every
   double has a best rational); only the original expression can, and the
   Giac branch — which knows it — is preempted by the fraction today.
3. **Conjunction-boundary unpinned** (tests-review finding): the ODE
   spellings table never covers `and` followed by a word character
   (`and_1`), so a future edit could make the verifier treat an identifier
   as the join keyword with no test failing.
4. **S7755 `.at()` ×8**, deferred since the S7773 round because `Array#at`
   types as `T | undefined` where the bracket form types as `T`.

## Design

**B1 — trust boundary for fractions.** In `tryExactResult`, a
`floatToFraction` result is returned directly only when its denominator is
≤ 1000 (every intentional fraction probed — 2/3, 3/10, 22/7, 355/113,
0.1+0.2 → 3/10 — is far below; the fast path keeps its no-engine-call
latency). A denominator above 1000 is not trusted from the double alone:
execution falls through to the Giac branch, which either yields an
acceptable exact form (symbolic truth for `sin(pi/5)`; the real
`1/2500000000` for intentional huge fractions — already pinned) or nothing
— and nothing means no fraction claim, the honest decimal on the Result
line.

**B2 — one table row:** `["y'=y and_1*y(0)=1", <decline>]` in
verify-ode-solution's spellings table, asserting the verifier does not
treat `and_1` as a join (exact decline shape read from the table's
conventions at implementation).

**B3 — per-site `.at()` conversions**, honest typing only:
- `mathjs-tasks.ts:501`: invert the guard — read `current.at(-1)` first and
  gate the jump logic on `prev !== undefined`.
- `tasks.ts:93`: `row[row.length - 1]` is the DP boundary value `row[k]` —
  name the index instead of computing it from the length.
- The remaining six (`extractors.ts:1168`, `hypothesis-testing.ts:626`,
  `numerical-methods.ts:389`, `probability-calc.ts:531,537`,
  `sequence-utils.ts:105`): convert with the site's existing emptiness
  knowledge — undefined-guards where a guard already exists, an explicit
  `?? NaN`-style fallback where the old code already produced NaN/undefined
  on empty. No masking of a value the old code would have used; a site that
  cannot be converted honestly is left in place with its rationale in the
  commit message rather than forced.

**A** — the three String.raw templates (byte-identity probe again, same as
batch 2), the `\w` class, the merged import, and S2310's for-loop rewritten
as an explicit-index `while` with identical traversal.

## Commits

1. `refactor: re-apply the regex-form and import hygiene the ode merges rewrote`
   — A items incl. S2310.
2. `fix: refuse fraction claims a double cannot justify` — B1 + its pins and
   B2's table row.
3. `refactor: honest .at() typing at the last-element reads` — B3.

## Verification

Five gates per commit; the S7780 byte-identity probe; then review-pro with
correctness first and the mutation tests reviewer last and alone.
