# S3776 — decompose the mathjs_sample task (cognitive complexity 34)

## Finding

SonarQube S3776 on `src/server/js-compute/mathjs-tasks.ts:439`: the
`mathjs_sample` task body has cognitive complexity 34 (threshold 15). The body
is a three-stage pipeline in one function: pass one samples the grid (null
marking non-finite/throwing points, bookkeeping yMin/yMax/sampled/firstError),
the range normalization measures the RAW span then pads (defaults ±10 when
nothing sampled, ±1 for a flat span, 5% padding with finiteOr overflow
fallback), and pass two splits continuous segments at nulls and jumps over
half the raw span.

Two load-bearing comments migrate with their code: the padding-before-raw-span
bug note (`1/x` was drawn straight through its pole) and the half-span jump
heuristic note (`exp` moves 10% of span, `x^2` 2%).

## Design

Extract three module-level helpers before `MATHJS_TASKS`; the task becomes a
linear composition:

- `sampleGrid(compiled, a)` → `SampledGrid { allPoints, yMin, yMax, sampled,
  firstError }` (pass one; `firstError ??=` keeps only the first error,
  `sampled++` only on finite numbers).
- `normalizedYRange(yMin, yMax, sampled)` → `{ yMin, yMax, rawRange }` (the
  RAW-span measurement and the three padding branches).
- `splitSegments(allPoints, rawRange)` → `PlotSegment[]` (pass two).

The task body: compile → sampleGrid → normalizedYRange → splitSegments →
`capped(JSON.stringify(result))`. The result object's construction order
(segments, yMin, yMax, sampled, then firstError conditionally) is preserved so
the JSON byte-stream is unchanged. `MATHJS_TASKS`, its `as const satisfies
TaskModule`, and all exports are untouched.

`compiled` is typed structurally (`{ evaluate: (scope: Record<string, number>)
=> unknown }`) so the helper does not depend on a mathjs type export.

## Verification

- The task is pure mathjs (no Giac, no worker round-trip needed): the
  equivalence harness imports the old module (`git show 6d6da40:…`, import
  paths rewritten) and the new one side by side and byte-compares
  `MATHJS_TASKS.mathjs_sample` JSON output over a matrix covering: `1/x` over
  [-1,1] (pole split), `tan(x)` (multiple splits), `exp(x)` over [-10,10]
  (steep but continuous — must NOT split), the constant `5` (flat → ±1
  padding), an all-NaN expression (sampled=0 → ±10 default), an undefined
  function (firstError), `floor(x)` (integer jumps), `x^2`, and `numPoints:1`
  (degenerate step division).
- Five gates; review-pro correctness → tests-mutation (sequential).
