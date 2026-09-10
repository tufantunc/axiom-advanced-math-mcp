# CI failure class 2 — make the resource-bound tests deterministic

Date: 2026-09-04
Branch: `fix/ci-resource-tests` (from `main` de72ac4)

## Problem

Four tests fail on CI runners (observed across node 20/22/24 ubuntu and
node 22 windows; all pass locally). All four are the same defect class:
they pin thresholds that race machine speed. Measured: the CI runner is
3-6x slower than the dev machine (element-count pre-check 349ms local vs
2080ms CI).

| Test | Race | Local | CI |
|---|---|---|---|
| handler-seam ODE reply-size row 2 ((x+1)^1000*(x+2)^1000) | Giac normal() expansion vs the 10s eval budget | expansion finishes, reply-size refusal fires | budget exceeded first, "could not be analysed in the time the CAS allows" |
| input-bounds stirling_first(20000,48) must ANSWER | BigInt DP vs the 10s default budget | 2824ms | >10s on slower legs |
| input-bounds OOM containment (heap 32MB vs timeout 30s) | BigInt value growth vs wall clock | heap dies at 8117ms | 3-4x slower, timeout wins |
| input-bounds element-count pre-check < 1500ms | wall-clock pin | 349ms | 2080ms |

## Design

The contract every test pins is containment: the server survives, the
next call works. Which bound fires first is machine speed — so the fixes
make the pinned bound the deterministic winner, or accept both winners
where both are legitimate refusals.

1. handler-seam: the it.each keeps row 1 ((x+1)^1000 → 677,259 chars —
   passes on CI) with its exact message pin. Row 2 becomes its own test
   accepting EITHER refusal — the reply-size message or the time-budget
   message — with a comment explaining the race; both leave the worker
   intact, and the worker/victim assertions stay unconditional.
2. stirling_first: shrink 20000 → 12000 (local 970ms, CI ~3-4s against
   the 10s budget = 2.5x headroom). The class contract is unchanged:
   n²·k ≈ 6.9×10⁹ sits above every retired ceiling. New pinned prefix
   66011291014257532782019614647237 (probed from the real worker).
3. OOM containment: timeoutMs 30_000 → 90_000, vitest timeout 40_000 →
   120_000. heapMb stays 32 — the memory axis stays what fires; total
   work to fill a heap of B bytes is independent of k (memory per row
   ~k·i·c, iterations to fill ~B/(k·c), product ~B/c), so CI fills it
   in ~3-4x the local 8.1s, well inside 90s.
4. Element-count pre-check: 1500ms → 10_000ms. Building the string the
   pre-check refuses would take 30s+ or heap death; 10s still separates
   pre-check from build by an order of magnitude.

Deliberately not done: loosening production defaults (the test-local
timeoutMs parameters are the test's own; AXIOM_EVAL_TIMEOUT_MS and the
host defaults are untouched) and CI skips (they blind the contract).

## Verification

Five gates; each of the four tests mutation-checked (corrupt its
assertion's subject — drop the pre-check, restore the old timeout,
narrow the refusal matcher — and confirm it goes red); review-pro with
the correctness reviewer first and the mutation tests reviewer last.
