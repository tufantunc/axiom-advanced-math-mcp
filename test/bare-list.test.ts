import { describe, it, expect } from 'vitest';
import { bareCommaList } from '../benchmark/graders/bare-list.js';

describe('bareCommaList', () => {
  it('parses simple atomic list', () => {
    expect(bareCommaList('i,-i')).toEqual(['i', '-i']);
    expect(bareCommaList('1,-1,2,-2')).toEqual(['1', '-1', '2', '-2']);
  });

  it('handles function-call atoms', () => {
    expect(bareCommaList('sqrt(2),-sqrt(2)')).toEqual(['sqrt(2)', '-sqrt(2)']);
    expect(bareCommaList('exp(1),exp(-1)')).toEqual(['exp(1)', 'exp(-1)']);
  });

  it('rejects when contains =', () => {
    expect(bareCommaList('x = 5, y = 6')).toBeNull();
  });

  it('rejects when contains comparison ops', () => {
    expect(bareCommaList('x>1, y<2')).toBeNull();
    expect(bareCommaList('x>=1, y<=2')).toBeNull();
  });

  it('rejects single member', () => {
    expect(bareCommaList('x')).toBeNull();
    expect(bareCommaList('sqrt(2)')).toBeNull();
  });

  it('rejects when top-level + suggests one expression', () => {
    expect(bareCommaList('a*x+b*y,c')).toBeNull();
  });

  it('does not split inside parens', () => {
    // f(a,b),g(c,d) is a 2-element list; commas inside parens should be ignored.
    expect(bareCommaList('f(a,b),g(c,d)')).toEqual(['f(a,b)', 'g(c,d)']);
  });

  it('strips whitespace around members', () => {
    expect(bareCommaList('i, -i')).toEqual(['i', '-i']);
    expect(bareCommaList('  i ,  -i  ')).toEqual(['i', '-i']);
  });

  it('returns null for empty string', () => {
    expect(bareCommaList('')).toBeNull();
  });

  it('returns null for empty members like "1,,2"', () => {
    expect(bareCommaList('1,,2')).toBeNull();
  });
});
