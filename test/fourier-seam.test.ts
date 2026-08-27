import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { route } from '../src/server/tools/compute/router.js';
import { computeHandler } from '../src/server/tools/compute/index.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

const text = (r: { content: { text: string }[] }): string =>
  r.content.map((c) => c.text).join('\n');

/**
 * The extractor -> handler seam for `fourier`.
 *
 * test/fourier-transform.test.ts calls fourierTransformHandler directly with
 * `{ mode: 'fft', data: [...] }` and has always passed, while the extractor
 * emitted `{ mode: 'forward', signal: [[...]] }` — a different field name, a
 * different mode vocabulary, and one array level too many. Nothing tested the
 * join, so every fourier request through `compute` crashed on `data.length`,
 * `fft([1,2,3,4])` included. These tests own that join.
 */
describe('fourier: extractor speaks the handler contract', () => {
  it('emits the field names and mode values the handler reads', () => {
    expect(route('fft([1,2,3,4])').args).toEqual({ mode: 'fft', data: [1, 2, 3, 4] });
    expect(route('ifft([1,0,1,0])').args).toEqual({ mode: 'ifft', data: [1, 0, 1, 0] });
  });

  it('accepts the unbracketed argument form too', () => {
    expect(route('fourier(1,0,1,0)').args).toEqual({ mode: 'fft', data: [1, 0, 1, 0] });
  });

  it('does not nest the sample list an extra level', () => {
    // JSON.parse('[' + '[1,2,3,4]' + ']') gives [[1,2,3,4]], which the handler
    // would join into "1,2,3,4" only by accident and mis-count n.
    const data = (route('fft([1,2,3,4])').args as { data: number[] }).data;
    expect(Array.isArray(data[0])).toBe(false);
  });
});

describe('fourier: end-to-end through compute', () => {
  it('computes a DFT with the textbook values', async () => {
    // fft([1,2,3,4]) = [10, -2+2i, -2, -2-2i]
    const r = await computeHandler({ problem: 'fft([1,2,3,4])' });
    expect(r.isError).toBe(false);
    const out = text(r);
    expect(out).toContain('n = 4 samples');
    expect(out).toMatch(/\[0\].*10\.000000\s*\+0\.000000i/);
    expect(out).toMatch(/\[1\].*-2\.000000\s*\+2\.000000i/);
    expect(out).toMatch(/\[2\].*-2\.000000\s*\+0\.000000i/);
    expect(out).toMatch(/\[3\].*-2\.000000\s*-2\.000000i/);
  });

  it('reports exactly n bins', async () => {
    // Asserting membership of [0]..[3] could not see over-counting, and the
    // "n = 4 samples" line is built from data.length, not from the parsed bin
    // count, so it reads 4 however many bins came back.
    const out = text(await computeHandler({ problem: 'fft([1,2,3,4])' }));
    // Complex-value lines only — the magnitude spectrum repeats the `[k] f=`
    // prefix, so a looser pattern counts every bin twice.
    expect(out.match(/\[\d+\] f=\S+\s+-?\d+\.\d+\s+[+-]\d+\.\d+i/g)).toHaveLength(4);
  });

  it('keeps the sign on a bare-i coefficient', async () => {
    // Giac writes a unit coefficient as `i`, e.g.
    // fft([0,0.5,0,-0.5]) -> [0.0,6.12323399574e-17-i,0.0,-6.12323399574e-17+i].
    // A parser that requires digits before `i` cannot see the `-` and reports
    // +1i for both bins — a sign-flipped spectrum with no error.
    const out = text(await computeHandler({ problem: 'fft([0,0.5,0,-0.5])' }));
    expect(out).toMatch(/\[1\].*-1\.000000i/);
    expect(out).toMatch(/\[3\].*\+1\.000000i/);
  });

  it('keeps both parts when the imaginary unit is bare', async () => {
    // fft([2,1,0,0]) -> [3.0, 2.0-i, 1.0, 2.0+i]. The old parser lost the real
    // part too, reporting 0.000000 +1.000000i.
    const out = text(await computeHandler({ problem: 'fft([2,1,0,0])' }));
    expect(out).toMatch(/\[1\].*2\.000000\s*-1\.000000i/);
  });

  it('preserves conjugate symmetry for a real-valued signal', async () => {
    // X[N-k] = conj(X[k]). Cheaper and stronger than any single literal: a
    // sign flip or a duplicated bin breaks it.
    const out = text(await computeHandler({ problem: 'fft([0,1,0,0])' }));
    const bins = [...out.matchAll(/\[(\d+)\] f=\S+\s+(-?\d+\.\d+)\s+([+-]\d+\.\d+)i/g)].map(
      (m) => ({ re: Number(m[2]), im: Number(m[3]) })
    );
    expect(bins).toHaveLength(4);
    expect(bins[1].re).toBeCloseTo(bins[3].re, 6);
    expect(bins[1].im).toBeCloseTo(-bins[3].im, 6);
  });

  it('renders an inverse transform, with the sign in front of the magnitude', async () => {
    // The ifft branch was end-to-end dead before this fix, and printed
    // "+ -0.50000000i" the first time it ran.
    const out = text(await computeHandler({ problem: 'ifft([1,2,3,4])' }));
    expect(out).toContain('n = 4 samples');
    expect(out).toMatch(/\[1\]\s+-0\.50000000 - 0\.50000000i/);
    expect(out).toMatch(/\[3\]\s+-0\.50000000 \+ 0\.50000000i/);
  });

  it('refuses a single sample instead of parsing the CAS error as a bin', async () => {
    // Giac answers fft([1]) with "GIAC_ERROR: Invalid dimension", which
    // contains an `i` — the old parser turned it into 0.000000 +1.000000i and
    // reported isError false.
    const r = await computeHandler({ problem: 'fft([5])' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('at least 2 numeric samples');
    expect(text(r)).not.toContain('GIAC_ERROR');
  });

  it('explains itself instead of crashing on symbolic input', async () => {
    // Giac has no symbolic Fourier transform — fourier(sin(t),t,s) comes back
    // unevaluated — so this must be a clear message, not `undefined.length`.
    const r = await computeHandler({ problem: 'fourier(sin(t), t)' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('numeric samples');
    expect(text(r)).not.toContain('Cannot read properties');
  });
});
