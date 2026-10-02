import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { computeHandler } from '../src/server/tools/compute/index.js';
import { allText } from './helpers/all-text.js';
import { resultLine } from './helpers/result-line.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

// The direction argument of a one-sided limit. Every spelling but `+` used to
// become -1, so `limit(1/x, x, 0, 1)` — Giac's own spelling of "from the
// right" — answered -infinity, and so did `right`, `2` and a two-sided `0`, all
// as successes. Through the real engine: the answer is the mathematics.
describe('limit direction', () => {
  it.each([
    // From the right: the tool's `+`, and Giac's own `1`.
    ['limit(1/x, x, 0, +)', '+infinity'],
    ['limit(1/x, x, 0, 1)', '+infinity'],
    ['limit(1/x, x, 0, +1)', '+infinity'],
    ['limit(1/x, x, 0,  1 )', '+infinity'],
    ['limit(abs(x)/x, x, 0, 1)', '1'],
    // From the left.
    ['limit(1/x, x, 0, -)', '-infinity'],
    ['limit(1/x, x, 0, -1)', '-infinity'],
    ['limit(abs(x)/x, x, 0, -)', '-1'],
    // Both sides — Giac's `0` — is the limit with no direction at all.
    ['limit(1/x, x, 0, 0)', 'infinity'],
    ['limit(sin(x)/x, x, 0, 0)', '1'],
  ])('%s is %s', async (problem, expected) => {
    const r = await computeHandler({ problem });
    expect(r.isError, allText(r)).toBe(false);
    expect(allText(r)).toMatch(resultLine(expected));
  });

  // Anything else names no side, so it is refused rather than read as one.
  it.each([
    ['limit(1/x, x, 0, right)', 'right'],
    ['limit(1/x, x, 0, 2)', '2'],
    ['limit(1/x, x, 0, "+")', '"+"'],
    ['limit(1/x, x, 0, constructor)', 'constructor'],
  ])('%s is refused, naming %s', async (problem, direction) => {
    const r = await computeHandler({ problem });
    const text = allText(r);
    expect(r.isError, text).toBe(true);
    expect(text).toContain(
      `unknown limit direction \`${direction}\` — use + (from the right), - (from the left), ` +
        'or leave it out for both sides'
    );
  });

  // Quoted as other refusals in this handler are, to its first 60 characters.
  it('quotes a long direction to its first 60 characters', async () => {
    const r = await computeHandler({ problem: `limit(1/x, x, 0, ${'a'.repeat(100)})` });
    const text = allText(r);
    expect(r.isError, text).toBe(true);
    expect(text).toContain(`limit direction \`${'a'.repeat(60)}\``);
  });
});
