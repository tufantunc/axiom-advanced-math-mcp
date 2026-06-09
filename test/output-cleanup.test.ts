import { describe, it, expect } from 'vitest';
import { splitTopLevel, stripQuotes } from '../src/server/tools/output-cleanup.js';

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
