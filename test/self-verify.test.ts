import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import {
  verifySolveSet,
  verifySystem,
  verifyFactor,
  verifyIntegrate,
} from '../src/server/tools/self-verify.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

describe('verifySolveSet', () => {
  it('verifies correct real roots', async () => {
    const v = await verifySolveSet('x^2-4', 'x', ['-2', '2']);
    expect(v.verified).toBe(true);
    expect(v.method).toBe('substitution');
    expect(v.detail).toContain('2/2');
  });
  it('verifies complex roots', async () => {
    expect((await verifySolveSet('x^2+1', 'x', ['i', '-i'])).verified).toBe(true);
  });
  it('rejects a wrong root', async () => {
    expect((await verifySolveSet('x^2-4', 'x', ['-2', '3'])).verified).toBe(false);
  });
  it('treats an empty solution set as unverified', async () => {
    const v = await verifySolveSet('x^2+1', 'x', []);
    expect(v.verified).toBe(false);
  });
  it('handles an equation written with =', async () => {
    expect((await verifySolveSet('x^2=4', 'x', ['-2', '2'])).verified).toBe(true);
  });
});

describe('verifySystem', () => {
  it('verifies a correct tuple', async () => {
    expect((await verifySystem(['x+y=3', 'x-y=1'], ['x', 'y'], ['2', '1'])).verified).toBe(true);
  });
  it('rejects a tuple/variable count mismatch', async () => {
    expect((await verifySystem(['x+y=3'], ['x', 'y'], ['2'])).verified).toBe(false);
  });
});

describe('verifyFactor', () => {
  it('verifies a correct factorization', async () => {
    const v = await verifyFactor('x^2-4', '(x-2)*(x+2)');
    expect(v.verified).toBe(true);
    expect(v.method).toBe('expand');
  });
  it('rejects a wrong factorization', async () => {
    expect((await verifyFactor('x^2-4', '(x-2)*(x+3)')).verified).toBe(false);
  });
});

describe('verifyIntegrate', () => {
  it('verifies a correct antiderivative', async () => {
    const v = await verifyIntegrate('2*x', 'x', 'x^2');
    expect(v.verified).toBe(true);
    expect(v.method).toBe('differentiation');
  });
  it('rejects a wrong antiderivative', async () => {
    expect((await verifyIntegrate('2*x', 'x', 'x^3')).verified).toBe(false);
  });
});
