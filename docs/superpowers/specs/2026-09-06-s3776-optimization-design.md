# S3776 — decompose optimizationHandler (multivariable/optimization.ts, 52) + S4323 rider

Date: 2026-09-06
Branch: `fix/s3776-optimization` (from `main` 6ffe87a)

## Problem

`optimizationHandler` (src/server/tools/multivariable/optimization.ts:61)
scores 52 against Sonar's threshold of 15: one function owns shared
argument validation and four operation blocks (tangent_plane,
directional_derivative, critical_points, lagrange), the third nesting a
six-branch classification chain. A new S4323 finding (cli/parse.ts:49)
flags the `'compute' | 'verify' | 'plot'` union repeated three times.

## Design

Pure code motion into naturally-bounded units (the parse.ts template):

1. `optimizationHandler` keeps the shared preamble (operation/
   expression/variables extraction + validation) and dispatches; the
   unknown-operation error stays in the dispatcher.
2. `tangentPlane`, `directionalDerivative`, `criticalPoints`, `lagrange` —
   each block moves verbatim (Giac call order, error messages, note
   lines byte-identical) into its own function taking (expression,
   variables, args) as needed.
3. critical_points' classification chain extracts to
   `classifyCriticalPoint(dNum, fxxNum): string` — the Number.isFinite
   guards and kind strings unchanged.
4. S4323 rider: `export type Subcommand = 'compute' | 'verify' | 'plot'`
   in cli/parse.ts; used at HelpCommand.topic (line 49), topicUsage
   (line 160), and the FLAG_OWNER satisfies clause (line 270).

## Verification

An old-vs-new equivalence harness: the base-commit handler is loaded as
a separate module and both handlers run the real Giac engine over a
curated input matrix (the 13 test inputs, the error paths, unknown
operation) comparing full outputs (isError, every content line)
byte-for-byte. The 13-test suite, the five gates, then review-pro with
the correctness reviewer first (independent harness re-run) and the
mutation tests reviewer last. One commit.
