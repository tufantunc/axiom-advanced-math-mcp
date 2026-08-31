import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { toLatex } from '../src/server/tools/giac-eval.js';

/**
 * The bound on what `toLatex` hands back to the engine, pinned at its value.
 *
 * `latex(...)` traps fatally on a large argument — measured on this engine, a
 * 9,504-character argument renders and 9,600 leaves "Giac worker exited (code
 * 1)" — and the `catch` inside toLatex turns that into a quiet `undefined`, so
 * the caller who triggered it sees a normal answer while the worker is gone.
 * Only the "guard removed entirely" case was covered before, which left the
 * constant free to move anywhere through the fatal region.
 */
beforeAll(async () => {
  await giacEngine.initialize();
}, 120_000);

describe('toLatex size bound', () => {
  it('renders a result at the limit', async () => {
    const atLimit = `${'1'.repeat(5998)}+x`;
    expect(atLimit).toHaveLength(6000);
    await expect(toLatex(atLimit)).resolves.toBeTypeOf('string');
  });

  it('declines one character over, rather than sending it', async () => {
    const overLimit = `${'1'.repeat(5999)}+x`;
    expect(overLimit).toHaveLength(6001);
    await expect(toLatex(overLimit)).resolves.toBeUndefined();
    // and the worker is still alive, which is the point of declining
    await expect(giacEngine.evaluate('integrate(x^2,x)')).resolves.toContain('x^3');
  });

  it.each([
    // Depth is a SECOND trap axis, independent of length, and treating length as
    // the only one made this worse before it made it better: `latex()` renders a
    // depth-132 argument at 1,057 characters and fatally traps at depth 140 with
    // 1,121 — about a fifth of the length cap. Raising the length cap opened a
    // band this shape walks straight through.
    [100, 'rendered'],
    [132, 'declined'],
    [140, 'declined'],
  ])('handles a depth-%i argument by %s, without a dead worker', async (depth, verdict) => {
    const nested = `${'sqrt(1+'.repeat(depth)}x${')'.repeat(depth)}`;
    expect(nested.length).toBeLessThan(6_000);
    const rendered = await toLatex(nested);
    expect(rendered === undefined ? 'declined' : 'rendered').toBe(verdict);
    await expect(giacEngine.evaluate('diff(x^3,x)')).resolves.toContain('3*x^2');
  });

  it('measures nesting, not the number of parentheses', async () => {
    // 120 calls side by side are depth ONE. Counting opens without subtracting
    // closes would call this depth 120 and decline LaTeX for an ordinary long
    // expression that renders fine.
    const flat = Array.from({ length: 120 }, (_, i) => `sin(${i + 1}*x)`).join('+');
    expect(flat.length).toBeLessThan(6_000);
    await expect(toLatex(flat)).resolves.toBeTypeOf('string');
  });

  it('still renders a deeply nested LIST, which does not trap', async () => {
    // The depth bound counts call parentheses, not every delimiter. Counting `[`
    // too looked like the cautious reading and was simply wrong: this renders
    // with the worker untouched at a depth that kills the engine when it is
    // nested function application instead.
    const nested = `${'['.repeat(200)}1${']'.repeat(200)}`;
    await expect(toLatex(nested)).resolves.toBeTypeOf('string');
    await expect(giacEngine.evaluate('diff(x^3,x)')).resolves.toContain('3*x^2');
  });

  it('declines a deep result the engine itself produced', async () => {
    // Not only a hand-built argument: 41 characters of input produce a 1,505-char
    // depth-150 result that clears the length cap and killed the worker, with
    // toLatex swallowing it as a quiet `undefined` — so the caller saw a normal
    // answer while a concurrent caller's request died.
    const deep = (await giacEngine.evaluate('g:=x;for(k:=0;k<150;k++){g:=sqrt(1+g);};g')).trim();
    expect(deep.length).toBeLessThan(6_000);
    await expect(toLatex(deep)).resolves.toBeUndefined();
    await expect(giacEngine.evaluate('diff(x^3,x)')).resolves.toContain('3*x^2');
  });

  it('still renders LaTeX for ordinary work this path also serves', async () => {
    // The cap is on the SHARED latex path, not the ODE one that motivated it.
    // At 4,000 it silently cost `expand((x+1)^140)` — 5,041 characters — the
    // LaTeX main rendered for it, with no warning and no note.
    const polynomial = await giacEngine.evaluate('expand((x+1)^140)');
    expect(polynomial.trim().length).toBeGreaterThan(5_000);
    await expect(toLatex(polynomial.trim())).resolves.toBeTypeOf('string');
  });
});
