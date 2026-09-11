import { describe, it, expect } from 'vitest';
import { geometryHandler } from '../src/server/tools/geometry.js';

function allText(r: { content: { text: string }[] }): string {
  return r.content.map((c) => c.text).join('\n');
}

// Goldens verified against the handler before the Math.hypot conversion; the
// values must not move by more than the renderer's 10th decimal when they do.
describe('geometry — 2D distances and magnitudes', () => {
  it('distance of a 3-4-5 pair is exactly 5', async () => {
    const r = await geometryHandler({ operation: 'distance', points: [[0, 0], [3, 4]] });
    expect(r.isError).toBe(false);
    expect(allText(r)).toContain('Result: 5');
    expect(allText(r)).toContain('The answer is 5');
  });

  it('distance renders √2 to the renderer precision', async () => {
    const r = await geometryHandler({ operation: 'distance', points: [[0, 0], [1, 1]] });
    expect(allText(r)).toContain('Result: 1.4142135624');
  });

  it('perimeter of the unit square is 4', async () => {
    const r = await geometryHandler({
      operation: 'perimeter_polygon',
      points: [[0, 0], [1, 0], [1, 1], [0, 1]],
    });
    expect(allText(r)).toContain('Result: 4');
  });

  it('perimeter of a 3-4-5 triangle is 12', async () => {
    const r = await geometryHandler({
      operation: 'perimeter_polygon',
      points: [[0, 0], [3, 0], [3, 4]],
    });
    expect(allText(r)).toContain('Result: 12');
  });

  it('point-to-line distance is |3+4|/5 = 1.4', async () => {
    const r = await geometryHandler({
      operation: 'point_line_distance',
      points: [[1, 1]],
      line1: [3, 4, 0],
    });
    expect(allText(r)).toContain('Result: 1.4');
  });

  it('angle between identical lines is 0°, perpendicular lines 90°', async () => {
    const same = await geometryHandler({
      operation: 'angle_between_lines',
      line1: [1, 0, 0],
      line2: [1, 0, 5],
    });
    expect(allText(same)).toContain('Result: 0°');
    const perp = await geometryHandler({
      operation: 'angle_between_lines',
      line1: [0, 1, 0],
      line2: [1, 0, 0],
    });
    expect(allText(perp)).toContain('Result: 90°');
  });

  it('distance stays finite at 1e154 coordinates (hypot is overflow-safe)', async () => {
    // The sqrt(x²+y²) form answered Infinity here; Math.hypot computes the
    // correct 1.4142135623730953e+154. Shape-matched: formatNumber's 10th
    // decimal rounding may move the last digits of the mantissa. The whole
    // response must be Infinity-free — including the √-derivation note,
    // which switches to the hypot form when the squared sum overflows.
    const r = await geometryHandler({
      operation: 'distance',
      points: [[0, 0], [1e154, 1e154]],
    });
    expect(allText(r)).toMatch(/Result: 1\.41421\d*e\+154/);
    expect(allText(r)).not.toContain('Infinity');
    expect(allText(r)).toMatch(/d = hypot\(/);
  });

  it('refuses the slope of a vertical line rather than answering Infinity', async () => {
    // The guard is ordinary input, not an edge case — deleting it ships
    // "Result: Infinity" at isError:false (found unpinned by mutation).
    const r = await geometryHandler({ operation: 'slope', points: [[1, 2], [1, 5]] });
    expect(r.isError).toBe(true);
    expect(allText(r)).toMatch(/undefined/i);
  });

  it('clamps cos rounding so near-parallel lines answer 0°, not NaN°', async () => {
    // cos computes to 1.0000000000000002 for these coefficients; without
    // the clamp acos(NaN)s and ships "Result: NaN°" as a success.
    const r = await geometryHandler({
      operation: 'angle_between_lines',
      line1: [3, 5, 0],
      line2: [33, 55, 1],
    });
    expect(r.isError).toBe(false);
    expect(allText(r)).toContain('Result: 0°');
  });

  // Three refusals of unrecognized point shapes, one parameterized test. Each
  // row keeps its own input channel — two through the extractor, one direct
  // to the handler — because that difference is part of what the row pins.
  // Array rows with %s, not object rows with $name: chai truncates object
  // display at 40 characters, which cut these titles to their first two
  // thirds in every reporter and broke `vitest -t` on the title tails.
  it.each([
    [
      'a single paren point keeps its arity error, not pair guidance',
      // distance((0,-2)) parses to ONE point; the error must name the shortage,
      // because the caller did write a pair (a review remedy: the single-part
      // path used to miss the paren spelling and misdirect to pair guidance).
      {
        args: async () => ({
          ...(await import('../src/server/tools/compute/extractors.js')).extractGeometry(
            'distance((0,-2))'
          ).args,
        }),
        message: 'requires at least 2 points',
      },
    ],
    [
      'refuses a non-pair mixed into recognized pairs, not silently dropping it',
      // Pins the all-or-nothing loop in parsePointList: a skip-instead-of-refuse
      // mutant answers Result: 5 here with `foo` discarded, isError:false.
      {
        args: async () => ({
          ...(await import('../src/server/tools/compute/extractors.js')).extractGeometry(
            'distance((0,0), foo, (3,4))'
          ).args,
        }),
        message: 'points must be (x, y) pairs',
      },
    ],
    [
      'refuses triples masquerading as points rather than discarding the surplus',
      // Pins isPair's arity in the accept direction: a mutant accepting length
      // 2-or-3 answers Result: 4.2426406871 with the z silently discarded.
      {
        args: async () => ({ operation: 'distance' as const, points: [[1, 2, 3], [4, 5, 6]] }),
        message: 'points must be (x, y) pairs',
      },
    ],
  ])('%s', async (_name, { args, message }) => {
    const r = await geometryHandler(await args());
    expect(r.isError).toBe(true);
    expect(allText(r)).toContain(message);
  });

  // The line rows pin each clause separately: deleting only the line1 or
  // only the line2 check used to leave the other firing, reviving (NaN, NaN).
  it.each([
    ['paren first', 'line_intersection((1,1,0), [1,0,0])'],
    ['paren second', 'line_intersection([1,0,0], (1,1,-2))'],
  ])('refuses one bad line among two (%s)', async (_name, problem) => {
    const { extractGeometry } = await import('../src/server/tools/compute/extractors.js');
    const r = await geometryHandler({ ...extractGeometry(problem).args });
    expect(r.isError).toBe(true);
    expect(allText(r)).toContain('lines [a, b, c] triples');
  });

  it('refuses paren line triples end-to-end through the extractor', async () => {
    // The extractor-side companion to the handler row: the paren triple must
    // arrive as a refused shape through compute's own routing, not as
    // characters destructured into (NaN, NaN).
    const { extractGeometry } = await import('../src/server/tools/compute/extractors.js');
    const r = await geometryHandler({ ...extractGeometry('line_intersection((1,1,0), (1,-1,2))').args });
    expect(r.isError).toBe(true);
    expect(allText(r)).toContain('lines [a, b, c] triples');
  });

  it('refuses line arguments that are not [a, b, c] triples instead of answering (NaN, NaN)', async () => {
    // The same unrecognized-shape class as points: a paren triple arrived as
    // a string, destructured into characters, and line_intersection answered
    // (NaN, NaN) at isError:false (found in the fallback round's review).
    const r = await geometryHandler({
      operation: 'line_intersection',
      line1: '(1,1,0)',
      line2: '(1,-1,2)',
    } as unknown as Record<string, unknown>);
    expect(r.isError).toBe(true);
    expect(allText(r)).toContain('lines [a, b, c] triples');
  });

  it('refuses points that are not (x, y) pairs instead of answering NaN', async () => {
    // The extractor's fallback used to pass unrecognized argument shapes
    // through as strings, and destructuring a string answered NaN at
    // isError:false (the class the paren-tuple recognition closed one way
    // and this guard closes the other).
    const r = await geometryHandler({
      operation: 'distance',
      points: ['(0,0)', 'foo'] as unknown as [number, number][],
    });
    expect(r.isError).toBe(true);
    expect(allText(r)).toContain('points must be (x, y) pairs');
  });

  it('converts a malformed-tuple throw into an error response, not a rejection', async () => {
    // Destructuring null throws inside the per-op function; the handler's
    // catch must keep resolving to formatErrorResponse.
    const r = await geometryHandler({ operation: 'distance', points: [[0, 0], null] });
    expect(r.isError).toBe(true);
  });
});
