# Extractors S3776 (:937, :1117) + the NaN reaches-analyzeNumberCore defect

## Scope decision

The four extractors S3776 findings included :326/:409 — both inside
`extractOde`. Another session's unmerged branch (`fix/ode-condition-cost-bound`)
modifies extractors.ts's ODE region, so the ODE arms are DESCOPED to keep this
tour conflict-free. This tour: extractGeometry (:937), extractLinearRegression
(:1117), the NaN behavior fix, and the number-theory bare-return escape.

## S3776 decompositions

- `extractGeometry` (:937) → `applyPositionalGeometryArgs(args, operation,
  callArgs, inner)` — the per-operation positional branching (radius /
  base+height / line pairs / point_line_distance's two line spellings /
  point lists), each branch's comment migrating.
- `extractLinearRegression` (:1117) → `extractRegressionSeries(named,
  positional, parts)` returning `{x, y} | null` — the three-form cascade
  (named lists → point pairs → two positional lists) with its comments.

## The NaN defect (root cause)

`extractNumberTheory` (four parseInt sites) and `extractNumberProperties`
(:1191) pass `Number.parseInt(inner, 10)` through with no NaN check, so
`analyze(foo)`, `isprime(x)`, `euler(n)`, `ifactor(foo)`,
`number_properties(foo)` reach `analyzeNumberCore(NaN)` and ship its garbage
(`Prime factorization: NaN`, and worse through prime_analysis) at
isError:false. Fix at the CONSUMPTION point (catches every NaN source, no
extractor contract change): both handlers refuse non-finite numbers with an
explicit error before dispatch. The number-utils characterization pin (direct
analyzeNumberCore(NaN) call) stays valid — the guard sits above it.

## The bare-return escape

`number-theory.ts` dispatches with `return primeFactorize(n)` and
`return analyzeNumber(n)` — bare promise returns through try/catch, so a
rejection escapes the handler's catch (the optimization.ts/S4123 class).
Both become `return await`, pinned by a spy test asserting the error
envelope (not a rejection) when analyzeNumberCore throws.

## Verification

- Equivalence harness (real Giac, computeHandler end-to-end): geometry
  matrix (every operation through the extractor incl. named/positional/
  JSON forms, the two point_line_distance line spellings, base+height pair)
  and linear_regression matrix (four input forms, degree/model variants) —
  byte-identical except the INTENDED NaN refusals.
- New pins: the five NaN spellings refused end-to-end; the await-discipline
  spy row.
- Five gates; review-pro correctness → tests-mutation.
