// test/multivariable-integrals.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { integralHandler } from '../src/server/tools/multivariable/integrals.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join('\n');

describe('multivariable integrals', () => {
  it('double integral of x*y over [0,1]x[0,2] is 1', async () => {
    const r = await integralHandler({
      operation: 'multiple_integral',
      expression: 'x*y',
      bounds: [
        { variable: 'x', lower: '0', upper: '1' },
        { variable: 'y', lower: '0', upper: '2' },
      ],
    });
    expect(r.isError).toBe(false);
    expect(text(r)).toContain('1');
  });

  it('triple integral of 1 over unit cube is 1', async () => {
    const r = await integralHandler({
      operation: 'multiple_integral',
      expression: '1',
      bounds: [
        { variable: 'x', lower: '0', upper: '1' },
        { variable: 'y', lower: '0', upper: '1' },
        { variable: 'z', lower: '0', upper: '1' },
      ],
    });
    expect(r.isError).toBe(false);
    expect(text(r)).toContain('1');
  });

  it('evaluates a raw nested-int expression', async () => {
    const r = await integralHandler({
      operation: 'multiple_integral',
      raw: 'int(int(x*y,x,0,1),y,0,2)',
    });
    expect(r.isError).toBe(false);
    expect(text(r)).toContain('1');
  });

  it('errors when neither bounds nor raw provided', async () => {
    const r = await integralHandler({ operation: 'multiple_integral', expression: 'x*y' });
    expect(r.isError).toBe(true);
  });
});
