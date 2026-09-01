# Giac echo/float acceptance — exact forms are symbolic or integral

Date: 2026-08-31
Branch: `fix/hypot-quickcalc-parity` (follows the snap fix, 9dce442; merged
up to main 1963348 at ea17ac4)

## Problem

`tryExactResult`'s Giac branch accepts any non-error output that merely
differs, as a string, from the numeric result. Three bad classes pass
(probe-verified on the merged state):

- **Reformatted float echo** — `to_exact('2e-9')` → `Result: 2e-09`: the same
  value, re-exponented, presented as an improvement.
- **Coarse Giac float as exact** — `sin(1.5)` → `Result: 0.997494986604`
  (Giac's ~12 significant digits) while the true double
  `0.9974949866040544` is relegated to the Decimal line; `sech(23.4)` →
  `1.37574872543e-10` likewise.
- **Unevaluated expression echo** — `Result: std([1e-05,2e-05])`,
  `Result: nthRoot(1.2345678e-05,3)`: Giac declined to evaluate, and the
  caller's input came back wearing the exact badge.

A float is not an exact form. The fix is a policy, not a tolerance hunt:

| Giac output (trimmed) | Decision | Probed examples |
|---|---|---|
| bare integer (`/^[+-]?\d+$/`) | accept | `0` (sin(pi)), `2432902008176640000` (20!) |
| bare non-integer float | reject | `0.997494986604`, `2e-09`, `1.37574872543e-10` |
| symbolic without a float literal | accept | `√3/2`, `√2`, `ln(2)`, `1/exp(30)`, `1/2500000000` |
| symbolic carrying a float literal | reject | `std([1e-05,2e-05])`, `nthRoot(1.2345678e-05,3)` |

Float-literal test: `/\d\.\d|\d[eE][+-]?\d/` — a digit-dot-digit or a
digit-exponent-digit run. `exp(30)`, `ln(2)`, `e^2` contain no such run
(`1/exp(30)`: the `e` is followed by `/`, not a digit), so legitimate symbolic
forms survive. Bare-number test:
`/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/`.

All twelve probed cases classify correctly under this policy, including the
keepers the earlier fixes rely on: `sin(pi)` → `0` (the snap-fix outcome now
Giac-verified), the degree golden `√3/2`, and `1/2500000000`.

## Behavior changes

Rejected outputs make `tryExactResult` return `null`, so `quick_calc` shows
the honest worker double on the Result line and `to_exact` answers its
"No simpler exact form found" note:

- `quick_calc('sin(1.5)')`: `Result: 0.997494986604` → `Result: 0.9974949866040544`
- `quick_calc('sech(23.4)')`: the snap-round test that pinned Giac's
  `1.37574872543e-10` flips to the fallback double `1.375748725426922e-10`
  (still asserting "not 0" — the tiny-value guarantee is unchanged)
- `to_exact('2e-9')`: fake `2e-09` exact → the no-simpler-form note

## Scope

One production site: the acceptance condition in `tryExactResult`
(`src/server/tools/exact-arithmetic.ts`). Tests: the sech pin update, a new
describe pinning the policy (seam-level `tryExactResult` cases for all four
rows of the table plus surface cases through `quickCalcHandler` and
`exactValueHandler`). One commit; then review-pro with the mutation-testing
tests reviewer run SEQUENTIALLY after the other reviewers (the previous
round's concurrent mutation runs bled into each other's views).

## Edge cases

- Trailing whitespace: classify on `giacResult.trim()`; the stored `exact`
  string is unchanged from today.
- The existing `!== String(numericResult)` / `!== toFixed(15)` guards stay —
  they catch exact-string echoes the policy alone wouldn't (e.g. an integer
  echo of an integer input).
- NaN/∞ outputs were already rejected upstream (`undef`, Error prefix).
