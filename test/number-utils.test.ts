import { describe, it, expect, vi, afterEach } from 'vitest';
import { analyzeNumberCore } from '../src/server/tools/number-utils.js';
import { giacEngine } from '../src/server/giac/index.js';

describe('analyzeNumberCore', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports every section, in order, for a perfect number', async () => {
    // One toEqual pins line order and each section's content — the S3776
    // refactor extracted five sections and, before this row, only the
    // factorize->divisorLines data flow was pinned anywhere (mutation review
    // found 7/8 wiring mutations survived the suite).
    expect(await analyzeNumberCore(28)).toEqual([
      'Number: 28',
      'Prime: No',
      'Prime factorization: 2^2 × 7',
      'Divisor count: 6',
      'Divisors: 1, 2, 4, 7, 14, 28',
      'Divisor sum: 56',
      'Perfect number: Yes',
      'Euler totient φ(28): 12',
      'Perfect square: No',
      'Perfect cube: No',
      'Triangular: Yes (T7)',
      'Fibonacci: No',
    ]);
  });

  it('answers NaN with the degenerate branches, never the engine path', async () => {
    // Characterization, not endorsement: NaN reaching the core at all is a
    // pre-existing compute-extractor defect (parseInt with no NaN check),
    // tracked for a separate round. What this row pins is that the section
    // gates stay NEGATED, not inverted — `absN <= 1` sends NaN down the
    // engine path (NaN fails both sides of every comparison), which
    // fabricated "Divisor count: 1" lines and leaked GIAC_ERROR as the
    // totient value.
    const lines = await analyzeNumberCore(NaN);
    expect(lines).toEqual([
      'Number: NaN',
      'Prime: No',
      'Prime factorization: NaN',
      'Perfect square: No',
      'Perfect cube: No',
      'Triangular: No',
      'Fibonacci: No',
    ]);
    expect(lines.join('\n')).not.toMatch(/GIAC_ERROR/);
  });

  it('falls back to trial division and omits the totient when the engine fails', async () => {
    vi.spyOn(giacEngine, 'evaluate').mockRejectedValue(new Error('engine unavailable'));
    const lines = await analyzeNumberCore(97);
    // 97 is prime: the trial-division fallback must still say Yes.
    expect(lines).toContain('Prime: Yes');
    expect(lines).toContain('Prime factorization: (could not compute)');
    // The old empty catch is load-bearing: a failed totient adds NO line.
    expect(lines.join('\n')).not.toContain('Euler totient');
  });

  it('suppresses the divisor listing past 30 divisors but keeps count and sum', async () => {
    const lines = await analyzeNumberCore(720720);
    expect(lines).toContain('Divisor count: 240');
    expect(lines).toContain('Divisor sum: 3249792');
    expect(lines.join('\n')).not.toContain('Divisors:');
  });
});

describe('handlers refuse non-finite numbers before analyzeNumberCore', () => {
  // The extractors run parseInt on caller text with no NaN check; before the
  // guards, these shipped analyzeNumberCore's degenerate report (and
  // ifactor's raw GIAC_ERROR) at isError:false. The pins drive the handlers,
  // which is where the refusal now lives.
  it('number_theory analyze refuses NaN (isprime(x), euler(n), analyze(foo))', async () => {
    const { numberTheoryHandler } = await import('../src/server/tools/number-theory.js');
    for (const number of [Number.NaN]) {
      const r = await numberTheoryHandler({ operation: 'analyze', number });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain('finite integer');
    }
  });

  it('number_theory prime_factorize refuses NaN (ifactor(foo))', async () => {
    const { numberTheoryHandler } = await import('../src/server/tools/number-theory.js');
    const r = await numberTheoryHandler({ operation: 'prime_factorize', number: Number.NaN });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('finite integer');
  });

  it('number_properties refuses NaN (number_properties(foo))', async () => {
    const { numberPropertiesHandler } = await import('../src/server/tools/number-properties.js');
    const r = await numberPropertiesHandler({ number: Number.NaN });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('finite integer');
  });

  it('a throwing analyzeNumberCore resolves to an error envelope, not a rejection', async () => {
    // Pins the 'return await' discipline in number-theory's dispatch: a bare
    // 'return analyzeNumber(n)' lets the rejection escape the handler's catch.
    const { numberTheoryHandler } = await import('../src/server/tools/number-theory.js');
    const utils = await import('../src/server/tools/number-utils.js');
    const spy = vi.spyOn(utils, 'analyzeNumberCore').mockRejectedValue(new Error('engine down'));
    try {
      const r = await numberTheoryHandler({ operation: 'analyze', number: 97 });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain('engine down');
    } finally {
      spy.mockRestore();
    }
  });
});
