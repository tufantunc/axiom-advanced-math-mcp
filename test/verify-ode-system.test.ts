import { describe, it, expect } from 'vitest';
import { verifyOdeSystem } from '../src/server/tools/self-verify.js';

/**
 * The verifier's decision table, driven with a stub engine.
 *
 * Its three outcomes are not two: verified, refuted, and UNDECIDED. The last
 * one matters most — it is what stops "I could not check this" from being
 * reported as "this answer is wrong", which refused correct answers twice
 * while this was being written.
 */
const engine = (replies: Record<string, string>) => (expr: string) => {
  // One call, always `normal(...)`. The residual/scale branches this used to
  // carry were leftovers from a numeric verifier that no longer exists, and a
  // stub modelling more of the contract than the code has is how the size-cap
  // test below ended up asserting nothing.
  expect(expr.startsWith('normal(')).toBe(true);
  return Promise.resolve(replies.exact ?? '[1,1]');
};

const M = '[[0,1],[-1,0]]';

describe('verifyOdeSystem', () => {
  it('verifies when the exact residual is zero', async () => {
    const out = await verifyOdeSystem(M, '', 'x', '[[a,b]]', engine({ exact: '[0,0]' }));
    expect(out).toMatchObject({ verified: true });
  });

  it.each([
    // Never refutes. A nonzero exact residual is not evidence the answer is
    // wrong — a float matrix produces one for a perfectly correct answer — so
    // the only honest outcomes are "proven" and "no verdict".
    ['[1,1]'],
    ['[3.19e-12*c_0,0]'],
    ['[k*sin(x),0]'],
  ])('gives no verdict rather than refuting when the exact residual is %s', async (exact) => {
    const out = await verifyOdeSystem(M, '', 'x', '[[a,b]]', engine({ exact }));
    expect(out).toBeUndefined();
  });

  it.each([
    // A residual that is not a number is undecided, not wrong. Reached whenever
    // something symbolic survives; the guard is the reason a system with a
    // symbolic coefficient is not refused when the exact branch cannot settle it.
    ['k*sin(x)'],
    ['undef'],
    [''],
  ])('returns no verdict when the residual is %s, rather than refuting', async (residual) => {
    const out = await verifyOdeSystem(M, '', 'x', '[[a,b]]', engine({ exact: `[${residual},0]` }));
    expect(out).toBeUndefined();
  });

  it('returns no verdict when the engine throws', async () => {
    const out = await verifyOdeSystem(M, '', 'x', '[[a,b]]', () =>
      Promise.reject(new Error('trap'))
    );
    expect(out).toBeUndefined();
  });

  it.each([
    // Not a solution vector at all: another guard's business. Reporting these as
    // unverified would say the wrong thing about them — and the engine is not
    // asked, which is the observable difference. Without the check these still
    // produce no verdict, but only because the malformed expression they build
    // makes the engine fail; the call is a pointless round-trip on the worker
    // every caller shares.
    ['[]'],
    ['[poly1[0,0]]'],
    ['undef'],
    [''],
  ])('returns no verdict for %s without asking the engine', async (result) => {
    let calls = 0;
    const counting = (expr: string) => {
      calls += 1;
      return engine({})(expr);
    };
    await expect(verifyOdeSystem(M, '', 'x', result, counting)).resolves.toBeUndefined();
    expect(calls).toBe(0);
  });

  it('does not send an oversized answer back to the engine', async () => {
    // The previous version asserted nothing: the default stub reply is not
    // all-zero, so the result was undefined with or without the cap, and the cap
    // could be deleted outright with the suite green. What the cap actually does
    // is not make the call.
    let calls = 0;
    const counting = (expr: string) => {
      calls += 1;
      return engine({ exact: '[0,0]' })(expr);
    };
    const huge = `[[${'x+'.repeat(3000)}1,0]]`;
    await expect(verifyOdeSystem(M, '', 'x', huge, counting)).resolves.toBeUndefined();
    expect(calls).toBe(0);

    // Just under it, the same shape IS checked and does reach a verdict.
    const small = `[[${'x+'.repeat(100)}1,0]]`;
    await expect(verifyOdeSystem(M, '', 'x', small, counting)).resolves.toMatchObject({
      verified: true,
    });
    expect(calls).toBe(1);
  });

  it.each([
    // The condition text is built by this project, so a malformed one cannot
    // arrive through the handler — but "I could not read it" must still mean no
    // verdict rather than a mark, since the mark now claims the conditions hold.
    ['Y(0)=1,0'],
    ['not a condition'],
    ['Y(0)='],
  ])('gives no verdict when the condition %s cannot be read', async (condition) => {
    const out = await verifyOdeSystem(M, '', 'x', '[[a,b]]', engine({ exact: '[0,0]' }), condition);
    expect(out).toBeUndefined();
  });

  it('withholds the mark when the answer misses the conditions', async () => {
    // An answer can satisfy Y' = A*Y + b exactly and still solve a DIFFERENT
    // initial-value problem.
    const replies = (expr: string) => Promise.resolve(expr.includes('subst(') ? '[7,0]' : '[0,0]');
    await expect(
      verifyOdeSystem(M, '', 'x', '[[a,b]]', replies, 'Y(0)=[1,0]')
    ).resolves.toBeUndefined();
  });

  it('checks against the forcing term, not only the matrix', async () => {
    // `Y' = A*Y + b`: dropping the `+ b` half leaves every inhomogeneous system
    // unverified, and a wrong b would certify against the wrong system.
    let seen = '';
    const capture = (expr: string) => {
      seen = expr;
      return engine({ exact: '[0,0]' })(expr);
    };
    await verifyOdeSystem(M, '[1,0]', 'x', '[[a,b]]', capture);
    expect(seen).toContain('+([1,0])');
  });

  it('gives no verdict for a reply that opens like a vector but does not close', async () => {
    // Only the startsWith half was pinned; slicing this would chop a real
    // character and send the result to the engine.
    let calls = 0;
    const counting = (expr: string) => {
      calls += 1;
      return engine({})(expr);
    };
    await expect(verifyOdeSystem(M, '', 'x', '[[a,b]', counting)).resolves.toBeUndefined();
    expect(calls).toBe(0);
  });
});
