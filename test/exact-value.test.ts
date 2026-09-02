import { describe, it, expect } from 'vitest';
import { exactValueHandler } from '../src/server/tools/exact-value.js';

function allText(r: { content: { text: string }[] }): string {
  return r.content.map((c) => c.text).join('\n');
}

describe('exactValueHandler — to_exact', () => {
  it('finds the exact form of a terminating decimal', async () => {
    const r = await exactValueHandler({ operation: 'to_exact', value: '0.5' });
    expect(r.isError).toBe(false);
    const text = allText(r);
    expect(text).toContain('Result: 1/2');
    expect(text).toContain('Decimal: 0.5');
    expect(text).toContain('The answer is 1/2 (≈ 0.5)');
  });

  it('reports when no simpler exact form exists', async () => {
    const r = await exactValueHandler({ operation: 'to_exact', value: '3.141592653589793' });
    expect(r.isError).toBe(false);
    const text = allText(r);
    expect(text).toContain('No simpler exact form found');
    expect(text).toContain('Result: 3.141592653589793');
  });

  it('rejects a non-numeric value', async () => {
    const r = await exactValueHandler({ operation: 'to_exact', value: 'abc' });
    expect(r.isError).toBe(true);
    expect(allText(r)).toContain('"abc" is not a valid number');
  });

  it('does not accept a reformatted float echo as an exact form', async () => {
    // Giac answers '2e-09' for '2e-9' — the same value, re-exponented. That
    // is not an improvement, so the honest answer is the no-simpler-form note.
    const r = await exactValueHandler({ operation: 'to_exact', value: '2e-9' });
    expect(r.isError).toBe(false);
    const text = allText(r);
    expect(text).toContain('No simpler exact form found');
    expect(text).toContain('Result: 2e-9');
    expect(text).not.toContain('2e-09');
  });

  it('does not report a tiny non-zero value as exactly 0', async () => {
    // The integer snap used to answer "Result: 0, Decimal: 4e-10"; with the
    // snap refused, no bounded fraction or Giac form improves the literal,
    // so the honest answer is the no-simpler-form fallback.
    const r = await exactValueHandler({ operation: 'to_exact', value: '4e-10' });
    expect(r.isError).toBe(false);
    const text = allText(r);
    expect(text).toContain('No simpler exact form found');
    expect(text).toContain('Result: 4e-10');
    expect(text).not.toMatch(/^Result: 0$/m);
  });

  it('to_exact of exact zero does not claim irrationality', async () => {
    // Pins the `|| numericResult === 0` allowance in the snap condition from
    // the observable surface: without it, 0 falls through to Giac (which
    // declines the echo) and this note appears for the integer zero.
    const r = await exactValueHandler({ operation: 'to_exact', value: '0' });
    expect(r.isError).toBe(false);
    const text = allText(r);
    expect(text).toMatch(/^Result: 0$/m);
    expect(text).not.toContain('No simpler exact form');
  });
});

describe('exactValueHandler — to_decimal', () => {
  it('evaluates a fraction to its decimal form', async () => {
    const r = await exactValueHandler({ operation: 'to_decimal', value: '1/4' });
    expect(r.isError).toBe(false);
    expect(allText(r)).toContain('Result: 0.25');
    expect(allText(r)).toContain('Expression: 1/4');
  });

  it('returns the full double-precision decimal when precision is not asked for', async () => {
    const r = await exactValueHandler({ operation: 'to_decimal', value: 'sqrt(2)' });
    expect(r.isError).toBe(false);
    expect(allText(r)).toContain('Result: 1.4142135623730951');
  });

  it('renders to the requested precision when the caller asks for it', async () => {
    const r = await exactValueHandler({ operation: 'to_decimal', value: 'sqrt(2)', precision: 6 });
    expect(r.isError).toBe(false);
    // Whole-line anchor: a bare toContain('Result: 1.41421') is satisfied by
    // the full double's prefix, so it cannot catch the regression alone.
    expect(allText(r)).toMatch(/^Result: 1\.41421$/m);
    expect(allText(r)).not.toContain('1.4142135623730951');
  });

  it('renders exponent form under precision as the worker produced it', async () => {
    // 1e21 itself would not distinguish old from new: String(1e21) is also
    // '1e+21'. A mantissa that precision must truncate does.
    const r = await exactValueHandler({
      operation: 'to_decimal',
      value: '1.23456789e21',
      precision: 3,
    });
    expect(r.isError).toBe(false);
    expect(allText(r)).toMatch(/^Result: 1\.23e\+21$/m);
    expect(allText(r)).not.toContain('1.23456789e+21');
  });

  it('still flags an infinite result when precision is requested', async () => {
    const r = await exactValueHandler({ operation: 'to_decimal', value: '1e308*10', precision: 5 });
    expect(r.isError).toBe(false);
    expect(allText(r)).toContain('Result: Infinity');
    expect(allText(r)).toMatch(/result is infinite/);
  });

  it('applies precision to a unit result without dropping the unit', async () => {
    const r = await exactValueHandler({ operation: 'to_decimal', value: '10/3 m', precision: 4 });
    expect(r.isError).toBe(false);
    expect(allText(r)).toMatch(/^Result: 3\.333 m$/m);
    expect(allText(r)).not.toContain('3.3333333333333335');
  });

  it('keeps the unit on the rendered result', async () => {
    // The numeric re-derivation this replaces once dropped units:
    // `to_decimal("1/2 m")` answered "0.5".
    const r = await exactValueHandler({ operation: 'to_decimal', value: '1/2 m' });
    expect(r.isError).toBe(false);
    expect(allText(r)).toContain('Result: 0.5 m');
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
