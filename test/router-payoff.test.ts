import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { computeHandler } from '../src/server/tools/compute/index.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

const text = (r: { content: { text: string }[] }): string =>
  r.content.map((c) => c.text).join('\n');

/**
 * End-to-end assertions for the solve_equation precedence fix.
 *
 * test/router.test.ts pins the routing decisions. These pin the answers, which
 * is the actual payoff — a routing test cannot see that the destination handler
 * still produces garbage, so a green routing suite could read as "fixed" while
 * the user-visible result was unchanged.
 */
describe('router precedence — user-visible payoff', () => {
  it('solves `verb(...) = value` instead of discarding the right-hand side', async () => {
    // Previously `diff` matched the solve rule's verb exclusion list, so this
    // went to calculus, which extracted only the derivative and answered
    // `3*x^2` — the derivative, for a question that asked where it equals 5.
    const r = await computeHandler({ problem: 'diff(x^3, x) = 5' });
    expect(r.isError).toBe(false);
    // 3x^2 = 5  =>  x = ±sqrt(5/3) = ±sqrt(15)/3
    expect(text(r)).toContain('√15');
    expect(text(r)).toContain('Verified: ✓');
  });

  it('solves a definite-integral equation too', async () => {
    // Second representative of the same deleted-verb class.
    const r = await computeHandler({ problem: 'int(x^2, x) = 9' });
    expect(r.isError).toBe(false);
    expect(text(r)).toMatch(/Result:\s*\{?3\}?/);
  });

  it('a named argument yields the same answer as the plain form', async () => {
    for (const [named, plain] of [
      ['gradient(f = x*y, [x,y])', 'gradient(x*y, [x,y])'],
      ['critical_points(f = x^2+y^2, [x,y])', 'critical_points(x^2+y^2, [x,y])'],
    ]) {
      const a = await computeHandler({ problem: named });
      const b = await computeHandler({ problem: plain });
      expect(text(a), named).toBe(text(b));
    }
    // And the answer is the right one, not merely a matching pair.
    expect(text(await computeHandler({ problem: 'gradient(f = x*y, [x,y])' }))).toContain('[y,x]');
  });

  it('reports unbalanced brackets instead of answering a typo', async () => {
    // Depth analysis is meaningless on unbalanced input, so it routes to the
    // handler that validates. Without that fallback `f(x=1` reached raw Giac
    // and returned `Result: f` with isError false.
    for (const problem of ['f(x=1', 'f(x=1]']) {
      const r = await computeHandler({ problem });
      expect(r.isError, problem).toBe(true);
      expect(text(r), problem).toMatch(/unclosed|Unmatched/);
    }
  });

  it('still solves an equation wrapped in redundant brackets', async () => {
    // The whole equation sits at depth 1, so the wrapper has to come off before
    // the depth test or these fall through to quick_calc and fail in mathjs.
    for (const problem of ['(x^2-4=0)', '[x^2-4=0]']) {
      const r = await computeHandler({ problem });
      expect(r.isError, problem).toBe(false);
      expect(text(r), problem).toContain('-2');
    }
  });
});
