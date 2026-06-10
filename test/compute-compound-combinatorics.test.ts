import { describe, it, expect } from 'vitest';
import { route } from '../src/server/tools/compute/router.js';
import { computeHandler } from '../src/server/tools/compute/index.js';
import { verifyHandler } from '../src/server/tools/verify/index.js';

function text(res: { content: { text: string }[] }): string {
  return res.content.map((c) => c.text).join('\n');
}

describe('router: compound combinatorics expressions', () => {
  it('does NOT hijack a compound expression into the combinatorics handler', () => {
    expect(route('C(4,2) * (5/6)^2 * (1/6)^2').handler).not.toBe('combinatorics');
    expect(route('combinations(4, 2) * (5/6)^2 * (1/6)^2').handler).not.toBe('combinatorics');
    expect(route('C(3,2) + C(4,2)').handler).not.toBe('combinatorics');
  });

  it('bare calls still go to the combinatorics handler (regression guard)', () => {
    expect(route('C(4,2)').handler).toBe('combinatorics');
    expect(route('P(5, 2)').handler).toBe('combinatorics');
    expect(route('combinations(4, 2)').handler).toBe('combinatorics');
    expect(route('comb(10, 3)').handler).toBe('combinatorics');
  });

  it('keyword phrasings still go to the combinatorics handler (regression guard)', () => {
    expect(route('5 choose 2').handler).toBe('combinatorics');
    expect(route('stirling(5, 2)').handler).toBe('combinatorics');
    expect(route('catalan(4)').handler).toBe('combinatorics');
  });
});

describe('compute: compound combinatorics evaluate correctly end-to-end', () => {
  it('evaluates C(4,2) * (5/6)^2 * (1/6)^2 to 25/216', async () => {
    const res = await computeHandler({ problem: 'C(4,2) * (5/6)^2 * (1/6)^2' });
    expect(text(res)).toContain('25/216');
  }, 30000);

  it('evaluates a sum of binomial coefficients', async () => {
    const res = await computeHandler({ problem: 'C(3,2) + C(4,2)' });
    expect(text(res)).toContain('9');
  }, 30000);
});

describe('verify: claims containing C(n,k) notation', () => {
  it('verifies a true compound combinatorics identity', async () => {
    const res = await verifyHandler({
      claim: 'C(4,2) * (5/6)^2 * (1/6)^2 = 25/216',
      method: 'symbolic',
    });
    expect(text(res)).toContain('Verified: TRUE');
  }, 30000);

  it('still rejects a false combinatorics identity', async () => {
    const res = await verifyHandler({
      claim: 'C(4,2) * (5/6)^2 * (1/6)^2 = 1/216',
      method: 'symbolic',
    });
    expect(text(res)).toContain('Verified: FALSE');
  }, 30000);
});
