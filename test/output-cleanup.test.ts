import { describe, it, expect } from 'vitest';
import {
  splitTopLevel,
  stripQuotes,
  stripOrderTerm,
  listToSet,
  stripDisplayMode,
  parseComplexTerm,
  parseComplexList,
} from '../src/server/tools/output-cleanup.js';

describe('splitTopLevel', () => {
  it('splits at top-level separator only', () => {
    expect(splitTopLevel('a,b,c', ',')).toEqual(['a', 'b', 'c']);
  });
  it('ignores separators nested in brackets/parens/braces', () => {
    expect(splitTopLevel('[2,1],[3,4]', ',')).toEqual(['[2,1]', '[3,4]']);
    expect(splitTopLevel('f(a,b),c', ',')).toEqual(['f(a,b)', 'c']);
  });
  it('returns single element when no separator', () => {
    expect(splitTopLevel('abc', ',')).toEqual(['abc']);
  });
});

describe('stripQuotes', () => {
  it('removes a matched pair of surrounding double-quotes', () => {
    expect(stripQuotes('"hello"')).toBe('hello');
  });
  it('leaves quote-free strings untouched', () => {
    expect(stripQuotes('hello')).toBe('hello');
  });
  it('does not strip a single leading or trailing quote', () => {
    expect(stripQuotes('"hello')).toBe('"hello');
    expect(stripQuotes('hello"')).toBe('hello"');
  });
});

describe('stripOrderTerm', () => {
  it('drops the trailing order_size term at center 0', () => {
    expect(stripOrderTerm('1+x+1/2*x^2+1/6*x^3+1/24*x^4+x^5*order_size(x)')).toBe(
      '1+x+1/2*x^2+1/6*x^3+1/24*x^4'
    );
  });
  it('drops the trailing order_size term at a non-zero center', () => {
    expect(stripOrderTerm('x-1-1/2*(x-1)^2+1/3*(x-1)^3+(x-1)^4*order_size(x-1)')).toBe(
      'x-1-1/2*(x-1)^2+1/3*(x-1)^3'
    );
  });
  it('leaves order-free expressions unchanged', () => {
    expect(stripOrderTerm('x^3/3')).toBe('x^3/3');
    expect(stripOrderTerm('(x-2)*(x+2)')).toBe('(x-2)*(x+2)');
  });
  it('returns input unchanged when order_size has no preceding additive term', () => {
    expect(stripOrderTerm('order_size(x)')).toBe('order_size(x)');
    expect(stripOrderTerm('x*order_size(x)')).toBe('x*order_size(x)');
  });
});

describe('listToSet', () => {
  it('converts a two-root list to a set', () => {
    expect(listToSet('list[-2,2]')).toBe('{-2, 2}');
  });
  it('returns a single root bare (not a set)', () => {
    expect(listToSet('list[3]')).toBe('3');
  });
  it('converts a system solution to a tuple', () => {
    expect(listToSet('list[[2,1]]')).toBe('(2, 1)');
  });
  it('converts complex roots to a set', () => {
    expect(listToSet('list[i,-i]')).toBe('{i, -i}');
  });
  it('maps an empty result to the empty set', () => {
    expect(listToSet('[]')).toBe('{}');
  });
  it('wraps multiple tuples in a set', () => {
    expect(listToSet('list[[2,1],[3,4]]')).toBe('{(2, 1), (3, 4)}');
  });
  it('returns the raw string when not a list', () => {
    expect(listToSet('x^2+1')).toBe('x^2+1');
  });
});

describe('stripDisplayMode', () => {
  // Tested on literals, not through a CAS call: the bundled Giac returns
  // \frac for simple fractions, so a live-path test cannot supply this
  // function's input and would assert an empty set.
  it('rewrites \\dfrac to \\frac', () => {
    expect(stripDisplayMode('\\dfrac{2}{17}')).toBe('\\frac{2}{17}');
  });

  it('removes \\displaystyle and \\textstyle along with trailing space', () => {
    expect(stripDisplayMode('\\displaystyle x^2')).toBe('x^2');
    expect(stripDisplayMode('\\textstyle   y')).toBe('y');
  });

  it('handles several wrappers in one string', () => {
    expect(stripDisplayMode('\\displaystyle \\dfrac{1}{2}+\\dfrac{1}{3}')).toBe(
      '\\frac{1}{2}+\\frac{1}{3}'
    );
  });

  it('leaves already-normalized LaTeX untouched', () => {
    expect(stripDisplayMode('\\frac{2}{17}')).toBe('\\frac{2}{17}');
  });

  it('does not touch \\dfracsomething (word-boundary anchored)', () => {
    expect(stripDisplayMode('\\dfracx')).toBe('\\dfracx');
  });
});

describe('parseComplexTerm', () => {
  // Literal-level, because this is where the bug hid: the parser was private to
  // fourier-transform.ts and reachable only through a live Giac call, so its
  // edge cases were whatever that one call happened to emit. Giac writes a unit
  // coefficient as a bare `i`, and every asserted fixture happened to use the
  // explicit `2.0*i` form instead.
  const values: [string, number, number][] = [
    ['10.0', 10, 0],
    ['-2.0', -2, 0],
    ['0', 0, 0],
    ['-2.0+2.0*i', -2, 2],
    ['-2.0-2.0*i', -2, -2],
    ['2.0*i', 0, 2],
    ['-2.0*i', 0, -2],
    ['i', 0, 1],
    ['-i', 0, -1],
    ['+i', 0, 1],
    ['2.0-i', 2, -1],
    ['3+i', 3, 1],
    ['-3-i', -3, -1],
    ['1e-3+2e4*i', 1e-3, 2e4],
    ['.5-.5*i', 0.5, -0.5],
  ];
  it.each(values)('%s -> %f %+fi', (term, re, im) => {
    expect(parseComplexTerm(term)).toEqual({ re, im });
  });

  it('parses the exponent form Giac emits for a near-zero real part', () => {
    const r = parseComplexTerm('6.12323399574e-17-i');
    expect(r.im).toBe(-1);
    expect(r.re).toBeCloseTo(0, 15);
  });

  it('throws rather than inventing a number', () => {
    // giacEngine.evaluate RESOLVES with "GIAC_ERROR: ..." instead of rejecting,
    // and that string contains an `i` (in "Invalid"). Defaulting to zero turned
    // a CAS error into a confident fabricated bin.
    for (const bad of [
      'GIAC_ERROR: Error: Invalid dimension',
      'undef',
      'inf',
      '1/2+i',
      'sqrt(2)*i',
      '',
    ]) {
      expect(() => parseComplexTerm(bad), bad).toThrow();
    }
  });
});

describe('parseComplexList', () => {
  it('returns one entry per element, not one per pair', () => {
    // Reading the list with parseFloat and pairing the results as (re, im)
    // halved the bin count and truncated each `a+b*i` at the `+`.
    expect(parseComplexList('[10.0,-2.0+2.0*i,-2.0,-2.0-2.0*i]')).toEqual([
      { re: 10, im: 0 },
      { re: -2, im: 2 },
      { re: -2, im: 0 },
      { re: -2, im: -2 },
    ]);
  });

  it('handles an empty list', () => {
    expect(parseComplexList('[]')).toEqual([]);
  });

  it('rejects anything that is not a Giac list', () => {
    expect(() => parseComplexList('GIAC_ERROR: Error: Invalid dimension')).toThrow();
  });
});
