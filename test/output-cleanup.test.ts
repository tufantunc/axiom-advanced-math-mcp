import { describe, it, expect } from 'vitest';
import { splitTopLevel, stripQuotes, stripOrderTerm } from '../src/server/tools/output-cleanup.js';

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
});
