import { describe, it, expect, afterEach, vi } from 'vitest';
import { msEnv, evalTimeoutMs, parseQuantity } from '../src/server/env-bounds.js';
import { createWorkerHost } from '../src/server/giac/worker-host.js';
import { captureStderr } from './helpers/stderr.js';

/**
 * Millisecond bounds read from the environment, validated in one place.
 *
 * `AXIOM_EVAL_TIMEOUT_MS` was read at three sites and checked at one. `??` does
 * not treat a set-but-empty var as absent, so `''` gave 0 and `'10s'` gave NaN,
 * and Node clamps both to a 1ms timer: measured, `AXIOM_EVAL_TIMEOUT_MS=10s`
 * made `evaluate('1+1')` reject with "Giac evaluation timed out" in ~118ms, so
 * every compute and verify call failed and blamed the caller's expression for an
 * operator typo. The NaN also propagated into
 * `Math.max(evalTimeoutMs() * 3, 30_000)`, where `Date.now() > NaN` is always
 * false — silently deleting the integration budget SECURITY.md relies on.
 *
 * Two rules, shared with the heap ceiling in js-compute/heap-config.ts:
 *
 *   - a legible quantity keeps its intent. `250ms` is 250, `2s` is 2000 — NOT
 *     the 10s default, which would be 40x looser than what the operator wrote.
 *     Answering a tightening typo with a looser bound is the one wrong direction.
 *   - what Node cannot represent is clamped, not passed through: below 1ms and
 *     above 2^31-1 both become a 1ms timer, which fails every call.
 */
describe('a millisecond bound keeps its intent or is clamped, never loosened', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // A fresh variable name per read: the warning is deduped per NAME, so reusing
  // one name would silence every row after the first and make them prove nothing.
  let seq = 0;
  const read = (raw: string | undefined): { value: number; lines: string[] } => {
    const name = `AXIOM_TEST_MS_${++seq}`;
    vi.stubEnv(name, raw);
    return captureStderr(() => msEnv(name, 10_000));
  };

  it.each([
    ['a plain number', '5000', 5000],
    ['an explicit ms unit', '250ms', 250],
    ['seconds, in a variable named MS', '2s', 2000],
    ['the unit the original typo used', '10s', 10_000],
    ['surrounding whitespace', '  750  ', 750],
    ['a fractional value, floored to the timer resolution', '250.7', 250],
  ])('keeps %s', (_what, raw, expected) => {
    expect(read(raw).value).toBe(expected);
  });

  it.each([
    ['below the 1ms timer resolution', '0.5', 1],
    ['past the 2^31-1 point where Node wraps to 1ms', '2147483648', 2_147_483_647],
  ])('clamps %s', (_what, raw, expected) => {
    // Both of these previously became a 1ms timer and failed every call: the
    // first because setTimeout floors, the second because Node wraps. Clamping
    // is never looser than the request.
    expect(read(raw).value).toBe(expected);
  });

  it.each([
    ['zero, which is not a budget', '0'],
    ['a negative budget', '-1'],
    ['a value with no number in it', 'soon'],
    ['a bare unit', 'ms'],
  ])('falls back for %s, which carries no usable quantity', (_what, raw) => {
    expect(read(raw).value).toBe(10_000);
  });

  it('takes the default silently when unset or blank', () => {
    // `.env` files and compose produce a set-but-empty var constantly; that is
    // not a misconfiguration and must not warn.
    expect(read(undefined)).toEqual({ value: 10_000, lines: [] });
    expect(read('')).toEqual({ value: 10_000, lines: [] });
    expect(read('   ')).toEqual({ value: 10_000, lines: [] });
  });

  it('says nothing about a value it takes unchanged', () => {
    expect(read('5000').lines).toEqual([]);
  });

  it('names the variable, the rejected value and the bound in force', () => {
    const { lines } = read('soon');
    expect(lines.join('\n')).toContain('AXIOM_TEST_MS_');
    expect(lines.join('\n')).toContain('soon');
    expect(lines.join('\n')).toContain('10000');
  });

  it('warns once per variable, not once per process', async () => {
    // `msEnv` is called per numerical routine via integrationBudgetMs, so
    // warning per read would put one line per integration into the log. But the
    // dedup is per NAME: a second misconfigured variable must not be silenced by
    // the first. A fresh module gives each assertion a clean slate without
    // exporting a reset seam into production code.
    vi.resetModules();
    const fresh = await import('../src/server/env-bounds.js');
    vi.stubEnv('AXIOM_TEST_A', 'soon');
    vi.stubEnv('AXIOM_TEST_B', 'later');
    expect(captureStderr(() => fresh.msEnv('AXIOM_TEST_A', 10)).lines).toHaveLength(1);
    expect(captureStderr(() => fresh.msEnv('AXIOM_TEST_A', 10)).lines).toEqual([]);
    expect(captureStderr(() => fresh.msEnv('AXIOM_TEST_B', 10)).lines).toHaveLength(1);
  });
});

describe('parseQuantity reads a number with an optional unit', () => {
  const MB = { m: 1, mb: 1, mib: 1, g: 1024, gb: 1024, gib: 1024 };

  it.each([
    ['64', 64],
    ['64MB', 64],
    ['64 mb', 64],
    ['2GB', 2048],
    ['0x40', 64],
    ['64e0', 64],
    ['1.5', 1.5],
  ])('reads %s as %d', (raw, expected) => {
    expect(parseQuantity(raw, MB)).toBe(expected);
  });

  it.each([['abc'], ['mb'], ['64 furlongs'], ['']])('refuses %s', (raw) => {
    expect(parseQuantity(raw, MB)).toBeUndefined();
  });
});

describe('AXIOM_EVAL_TIMEOUT_MS reaches the CAS worker validated', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps the CAS worker usable under a unit-suffix typo', async () => {
    // The end-to-end repro. Before the fix this rejected with "Giac evaluation
    // timed out" in ~118ms, because NaN reached setTimeout.
    vi.stubEnv('AXIOM_EVAL_TIMEOUT_MS', '10s');
    const { value: host } = captureStderr(() => createWorkerHost());
    try {
      await expect(host.evaluate('1+1')).resolves.toContain('2');
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it('honours the seconds the operator meant, rather than the default', () => {
    vi.stubEnv('AXIOM_EVAL_TIMEOUT_MS', '2s');
    expect(captureStderr(() => evalTimeoutMs()).value).toBe(2000);
  });
});
