# Geometry point fallback: parse paren tuples, refuse the rest

## The defect (recorded by the extractors round's tests review)

`parsePointList('(0,0), (3,4)')` returns null (JSON parse fails; splitArgs
yields two parts), so extractGeometry's fallback hands the raw coerced
arguments — the STRINGS `'(0,0)'` and `'(3,4)'` — to geometryHandler as
`points`. The handler destructures a string into characters, and
`distance((0,0),(3,4))` ships `Result: NaN`, `midpoint` ships `(NaN, 1.5)`,
both at isError:false; `slope` errors but as "Vertical line". The `?? parsed`
fallback itself is legitimate — it serves the `distance([0,0], [3,4])`
spelling, which coerceValue parses to real arrays — the bug is unrecognized
shapes passing silently.

## Fix (two layers)

1. **Feature:** `parsePointList` recognizes paren tuples — if every
   splitArgs part matches `^\(\s*num\s*,\s*num\s*\)$`, return the pairs.
   The natural spelling `distance((0,0), (3,4))` works. Only geometry feeds
   parsePointList.
2. **Guard:** `geometryHandler` refuses `points` whose elements are not
   `[number, number]` pairs — every remaining unrecognized shape
   (`distance((0,0), foo)`, bare numbers) becomes a clean error instead of
   a NaN answer.

## Pins

- CAPABILITIES rows: `distance((0,0), (3,4))` → 5, `midpoint((0,0), (3,4))`
  → (1.5, 2), `slope((0,0), (3,4))` → 4/3 (end-to-end through compute).
- Refusal row: `distance((0,0), foo)` → isError with the pair guidance.
- Existing bracket-spelling rows must stay green (equivalence: byte-identical
  for every previously-working input).

## Verification

Old-vs-new harness over the geometry extractor+handler matrix: bracket and
named spellings byte-identical; paren spellings intentionally change (NaN →
value); unrecognized shapes intentionally change (NaN → refusal). Five
gates; review-pro correctness → tests-mutation.
