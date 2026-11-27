import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { giacEngine } from '../src/server/giac/index.js';
import {
  GIAC_ENGINE_SHA256,
  GIAC_RESERVED_NAMES,
} from '../src/server/tools/giac-reserved-names.js';

/**
 * The generated list equationNameError (ode-cost-bounds.ts) refuses from. It is
 * only as good as its match to the engine it was read from, so the engine's
 * hash is pinned here, and test/giac-reserved-names-current.test.ts reruns the
 * generator against the built engine and compares.
 */
describe('the CAS’s reserved names', () => {
  it('were read from the engine this repository ships', () => {
    const shipped = createHash('sha256')
      .update(readFileSync('src/server/giac/giac.wasm.js', 'utf8'))
      .digest('hex');
    expect(
      shipped,
      'giac.wasm.js changed: npm run build && node scripts/generate-giac-reserved-names.mjs'
    ).toBe(GIAC_ENGINE_SHA256);
  });

  // Every name that held or killed the worker in an equation on main, and the
  // loop keywords, which the lexer matches as patterns and leaves no string of.
  it.each([
    'ifactor',
    'nextprime',
    'ithprime',
    'isprime',
    'factor',
    'seq',
    'sum',
    'product',
    'eval',
    'apply',
    'for',
    'while',
    'repeat',
    'do',
    'od',
    'restart',
    'epsilon',
    '_seqgen',
  ])('reserves %s', (name) => {
    expect(GIAC_RESERVED_NAMES.has(name)).toBe(true);
  });

  // What callers name their parameters and functions — the cost the bound
  // would carry if any were listed.
  it.each([
    'x',
    'y',
    'z',
    't',
    'u',
    'v',
    'k',
    'r',
    'a',
    'b',
    'c',
    'f',
    'g',
    'h',
    'p',
    'q',
    'C',
    'D',
    'E',
    'I',
    'K',
    'L',
    'M',
    'N',
    'P',
    'R',
    'V',
    'alpha',
    'beta',
    'gamma',
    'lambda',
    'mu',
    'omega',
    'sigma',
    'tau',
    'theta',
  ])('leaves %s free', (name) => {
    expect(GIAC_RESERVED_NAMES.has(name)).toBe(false);
  });

  // The classification itself, asked of the engine the tests run on: a
  // reserved name is not a plain symbol to it, and a free one is.
  it('agrees with the engine on what is a plain symbol', async () => {
    const asTerm = (name: string) => giacEngine.evaluate(`[type(2*${name}+1),lname(2*${name}+1)]`);
    await expect(asTerm('lambda')).resolves.toBe('[expression,[lambda]]');
    await expect(asTerm('D')).resolves.toBe('[expression,[D]]');
    await expect(asTerm('od')).resolves.toBe('[identifier,[undef]]');
    await expect(giacEngine.evaluate('type(ifactor)')).resolves.toBe('func');
    await expect(giacEngine.evaluate('type(epsilon)')).resolves.toBe('real');
  });
});
