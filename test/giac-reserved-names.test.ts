import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { giacEngine } from '../src/server/giac/index.js';
import { MAX_CALCULUS_ORDER } from '../src/server/tools/calculus.js';
import {
  GIAC_ENGINE_SHA256,
  GIAC_FREE_GLYPHS,
  GIAC_RESERVED_NAMES,
} from '../src/server/tools/giac-reserved-names.js';
import { MAX_REPEATED_ORDER } from '../src/server/tools/ode-name-bounds.js';

/**
 * The generated list equationNameError (ode-name-bounds.ts) refuses from. It is
 * only as good as its match to the engine it was read from, so the engine's
 * hash is pinned here, and test/giac-reserved-names-current.test.ts reruns the
 * generator against the built engine and compares.
 */
describe('the CAS’s reserved names', () => {
  it('were read from the engine this repository ships', () => {
    const shipped = createHash('sha256')
      // Line endings normalised as the generator normalises them, so a
      // Windows checkout hashes the same engine.
      .update(readFileSync('src/server/giac/giac.wasm.js', 'utf8').replaceAll('\r\n', '\n'))
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

  // A non-ASCII letter is admitted only when the engine reads it as a plain
  // symbol: Σ is `sum` and Δ an operator to it, so neither is listed.
  it('lists the free glyphs the engine reads as symbols, and not Σ or Δ', () => {
    for (const glyph of 'λωθαβμ') expect(GIAC_FREE_GLYPHS.has(glyph), glyph).toBe(true);
    for (const glyph of 'ΣΔ∑∫∂→∘') expect(GIAC_FREE_GLYPHS.has(glyph), glyph).toBe(false);
  });

  // The `x$n` order ceiling restates calculus.ts's, which the text-only
  // module cannot import; this keeps the two from drifting.
  it('caps the x$n order at the calculus order ceiling', () => {
    expect(MAX_REPEATED_ORDER).toBe(MAX_CALCULUS_ORDER);
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
    // The glyphs the list leaves out are commands to the engine.
    await expect(giacEngine.evaluate('∑(k,k,1,10)')).resolves.toBe('55');
    await expect(giacEngine.evaluate('Σ(k,k,1,10)')).resolves.toBe('55');
    await expect(giacEngine.evaluate('∂(x^2,x)')).resolves.toBe('2*x');
  });
});
