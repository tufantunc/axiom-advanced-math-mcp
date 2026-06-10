import { describe, it, expect } from 'vitest';
import { verifyHandler } from '../src/server/tools/verify/index.js';

function text(res: { content: { text: string }[] }): string {
  return res.content.map((c) => c.text).join('\n');
}

describe('verify: taylor/series order_size handling', () => {
  it('verifies a true taylor claim symbolically', async () => {
    const res = await verifyHandler({
      claim: 'taylor(exp(x), x=0, 4) = 1 + x + x^2/2 + x^3/6 + x^4/24',
      method: 'symbolic',
    });
    const t = text(res);
    expect(t).toContain('Verified: TRUE');
    expect(t).toContain('Confidence: high');
  }, 30000);

  it('still rejects a WRONG taylor claim (broken coefficient)', async () => {
    const res = await verifyHandler({
      claim: 'taylor(exp(x), x=0, 4) = 1 + x + x^2/2 + x^3/3 + x^4/24',
      method: 'symbolic',
    });
    expect(text(res)).toContain('Verified: FALSE');
  }, 30000);

  it('verifies a true taylor claim with method "both" (numeric path survives)', async () => {
    const res = await verifyHandler({
      claim: 'taylor(sin(x), x=0, 5) = x - 1/6*x^3 + 1/120*x^5',
      method: 'both',
    });
    expect(text(res)).toContain('Verified: TRUE');
  }, 30000);

  it('does not disturb plain identity verification', async () => {
    const res = await verifyHandler({
      claim: 'sin(x)^2 + cos(x)^2 = 1',
      method: 'symbolic',
    });
    expect(text(res)).toContain('Verified: TRUE');
  }, 30000);
});

describe('verify: "EXPR at x=a = b" claims', () => {
  it('verifies a true point-evaluation claim', async () => {
    const res = await verifyHandler({
      claim: 'diff(exp(x), x, 4) at x=0 = 1',
      method: 'both',
    });
    expect(text(res)).toContain('Verified: TRUE');
  }, 30000);

  it('rejects a false point-evaluation claim', async () => {
    const res = await verifyHandler({
      claim: 'diff(exp(x), x, 4) at x=0 = 2',
      method: 'both',
    });
    expect(text(res)).toContain('Verified: FALSE');
  }, 30000);
});
