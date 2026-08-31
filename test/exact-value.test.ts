import { describe, it, expect } from 'vitest';
import { exactValueHandler } from '../src/server/tools/exact-value.js';

function allText(r: { content: { text: string }[] }): string {
  return r.content.map((c) => c.text).join('\n');
}

describe('exactValueHandler — to_exact', () => {
  it('rejects a non-numeric value', async () => {
    const r = await exactValueHandler({ operation: 'to_exact', value: 'abc' });
    expect(r.isError).toBe(true);
    expect(allText(r)).toContain('"abc" is not a valid number');
  });
});

describe('exactValueHandler — to_decimal', () => {
  it('evaluates a fraction to its decimal form', async () => {
    const r = await exactValueHandler({ operation: 'to_decimal', value: '1/4' });
    expect(r.isError).toBe(false);
    expect(allText(r)).toContain('Result: 0.25');
    expect(allText(r)).toContain('Expression: 1/4');
  });

  it('evaluates an irrational to the requested precision', async () => {
    const r = await exactValueHandler({ operation: 'to_decimal', value: 'sqrt(2)', precision: 6 });
    expect(r.isError).toBe(false);
    expect(allText(r)).toContain('Result: 1.41421');
  });
});

describe('exactValueHandler — simplify_fraction', () => {
  it('reduces a negative fraction and reports the GCD', async () => {
    const r = await exactValueHandler({ operation: 'simplify_fraction', value: '-3/9' });
    expect(r.isError).toBe(false);
    const text = allText(r);
    expect(text).toContain('Result: -1/3');
    expect(text).toContain('GCD = 3');
    expect(text).toContain('Simplified: -3/9 = -1/3');
  });

  it('collapses a fraction with denominator 1', async () => {
    const r = await exactValueHandler({ operation: 'simplify_fraction', value: '8/2' });
    expect(r.isError).toBe(false);
    const text = allText(r);
    expect(text).toContain('Result: 4');
    expect(text).toContain('Simplified: 8/2 = 4');
  });

  it('rejects a zero denominator', async () => {
    const r = await exactValueHandler({ operation: 'simplify_fraction', value: '1/0' });
    expect(r.isError).toBe(true);
    expect(allText(r)).toContain('Denominator cannot be zero');
  });

  it('rejects a non-fraction value', async () => {
    const r = await exactValueHandler({ operation: 'simplify_fraction', value: '3.5' });
    expect(r.isError).toBe(true);
    expect(allText(r)).toContain('not a valid fraction');
  });
});

describe('exactValueHandler — dispatch', () => {
  it('rejects an unknown operation', async () => {
    const r = await exactValueHandler({ operation: 'to_hex', value: '255' });
    expect(r.isError).toBe(true);
    expect(allText(r)).toContain('Unknown operation: to_hex');
  });
});
