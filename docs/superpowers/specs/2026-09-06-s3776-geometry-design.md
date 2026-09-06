# S3776 — decompose geometryHandler (45) and planeHandler (19)

Date: 2026-09-06
Branch: `fix/s3776-geometry` (from `main` ff7ba16)

## Problem

geometry.ts:3 scores 45 and geometry3d/planes.ts:4 scores 19 against
Sonar's threshold of 15: single handlers owning switch-per-operation
bodies whose guards nest (area_triangle's base+height/points dual
branching, slope's vertical check, line_line_distance's parallel /
parallel-inner branching).

## Design

The proven template (parse.ts, optimization.ts): shared preamble + a
`return await` dispatch stay in the handler; each case body moves
verbatim into its own function. geometry.ts yields eleven operation
functions, planes.ts five. formatNumber and the hypot/overflow comment
move with their statements. The dispatches are written `return await`
from the start — the optimization.ts review proved a bare return lets
a rejection escape the handler's catch.

## Verification

Both handlers are pure JS (no engine): an old-vs-new harness compares
byte-identical outputs over a curated matrix covering every operation's
happy, guard and error paths, unknown operations, and malformed-input
destructuring throws. Existing suites (geometry.test.ts incl. the 1e154
overflow pin, geometry3d-planes.test.ts, handler-seam rows), five
gates, then review-pro — correctness first (independent harness),
mutation tests last.
