import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  resolveHeapMb,
  DEFAULT_HEAP_MB,
  MIN_HEAP_MB,
  MATHJS_MIN_HEAP_MB,
  MAX_HEAP_MB,
} from '../src/server/js-compute/heap-config.js';
import { createJsComputeHost } from '../src/server/js-compute/index.js';
import { captureStderr } from './helpers/stderr.js';
import { codeOf } from './helpers/js-compute.js';

/**
 * The child's heap ceiling: parsed, clamped, and never loosened.
 *
 * `--max-old-space-size` takes a whole number of MB and Node refuses anything
 * else outright, so a value that merely looked numeric used to reach the fork
 * intact and kill the child before any task ran. The call was requeued, died
 * twice more, and was abandoned in ~50ms as `worker_failed` — "The worker died
 * or misbehaved. Not the caller's fault" (errors.ts), pointing the operator away
 * from the env value that caused it.
 *
 * Three bounds, each pinned below against the measurement it came from. All were
 * taken on this repo's worker through the host that forks it, and all move with
 * load at the edge, which is why each constant sits above its boundary:
 *
 *   - MIN_HEAP_MB (16). 6MB cannot boot the child; 8MB booted in one run and
 *     failed in another; 10MB up is reliable.
 *   - MATHJS_MIN_HEAP_MB (48). The mathjs import is the expensive part of
 *     startup — worker.ts prices it at ~50MB — and below this the child boots
 *     and runs the integer tasks but cannot complete it. 44MB dies, 46MB runs,
 *     43MB is the flaky edge. NOT a floor: 32MB is a legitimately tight ceiling
 *     for integer-only work, and two OOM rows elsewhere in the suite depend on
 *     it being honoured. It gates the mathjs tasks only.
 *   - MAX_HEAP_MB (1048576). A policy ceiling, not a hardware one: V8 honours
 *     far larger values (2TB measured) until ~1.76e13 MB, where the MB->byte
 *     multiply wraps a size_t and a huge request silently becomes a ~191MB heap.
 *
 * Direction is the invariant. SECURITY.md documents this variable as a
 * containment bound, so a correction must never yield a ceiling LOOSER than what
 * the operator wrote. Every legible quantity is therefore clamped into
 * [MIN, MAX], never replaced; only input with no quantity in it falls back to
 * the default.
 */
describe('a heap ceiling keeps its intent or is clamped, never loosened', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** The resolved ceiling for an env value, with whatever it wrote to stderr. */
  const fromEnv = (raw: string | undefined): { value: number; lines: string[] } => {
    vi.stubEnv('AXIOM_JS_COMPUTE_HEAP_MB', raw);
    return captureStderr(() => resolveHeapMb(undefined));
  };

  it.each([
    ['a plain number', '64', 64],
    ['a unit that agrees with the variable', '64MB', 64],
    ['lowercase and spaced', '128 mb', 128],
    ['gigabytes', '2GB', 2048],
    ['hex, which Number always accepted', '0x40', 64],
    ['exponent form, which Number always accepted', '64e0', 64],
    ['surrounding whitespace', '  96  ', 96],
  ])('keeps %s', (_what, raw, expected) => {
    expect(fromEnv(raw).value).toBe(expected);
  });

  it.each([
    ['a fraction, floored to whole MB', '64.5', 64],
    ['below the boot floor', '4', MIN_HEAP_MB],
    ['a fraction below the boot floor', '1.5', MIN_HEAP_MB],
    ['above the ceiling', String(MAX_HEAP_MB + 1), MAX_HEAP_MB],
    ['a bytes-for-MB mistake', '2147483648', MAX_HEAP_MB],
    ['a size_t-wrapping value', '17592186044415', MAX_HEAP_MB],
    ['a value too large to spell without an exponent', '1e21', MAX_HEAP_MB],
  ])('clamps %s', (_what, raw, expected) => {
    // Every one of these is clamped, not replaced: the result is never looser
    // than what was written. `4` -> 16 is the single forced exception, and 16 is
    // the tightest ceiling the child can actually boot under.
    expect(fromEnv(raw).value).toBe(expected);
  });

  it.each([
    ['zero', '0'],
    ['a negative ceiling', '-8'],
    ['a value with no number in it', 'lots'],
    ['a unit this server does not know', '64 furlongs'],
  ])('falls back for %s, which carries no usable quantity', (_what, raw) => {
    expect(fromEnv(raw).value).toBe(DEFAULT_HEAP_MB);
  });

  it('takes the default silently when unset or blank', () => {
    // `.env` files and compose produce a set-but-empty var constantly.
    expect(fromEnv(undefined)).toEqual({ value: DEFAULT_HEAP_MB, lines: [] });
    expect(fromEnv('')).toEqual({ value: DEFAULT_HEAP_MB, lines: [] });
    expect(fromEnv('   ')).toEqual({ value: DEFAULT_HEAP_MB, lines: [] });
  });

  it('says nothing about a ceiling it takes unchanged', () => {
    expect(fromEnv(String(MATHJS_MIN_HEAP_MB)).lines).toEqual([]);
  });

  it('names the variable, the rejected value and the ceiling in force', () => {
    const { lines } = fromEnv('1.5');
    expect(lines.join('\n')).toContain('AXIOM_JS_COMPUTE_HEAP_MB');
    expect(lines.join('\n')).toContain('1.5');
    expect(lines.join('\n')).toContain(`${MIN_HEAP_MB}MB`);
  });

  it('says a value above the ceiling was capped, not that it was unusable', () => {
    // V8 honours 2TB; calling it "not a usable heap size" would be false. What
    // is true is that this server caps it.
    const { lines } = fromEnv('2000000');
    expect(lines.join('\n')).toContain(String(MAX_HEAP_MB));
    expect(lines.join('\n')).not.toMatch(/not a usable/);
  });

  describe('the option path', () => {
    it('is resolved by the same rules as the environment', () => {
      expect(captureStderr(() => resolveHeapMb(64.5)).value).toBe(64);
      expect(captureStderr(() => resolveHeapMb(4)).value).toBe(MIN_HEAP_MB);
    });

    it('names the option rather than the variable', () => {
      const { lines } = captureStderr(() => resolveHeapMb(64.5));
      expect(lines.join('\n')).toMatch(/heapMb option.*64\.5/);
      expect(lines.join('\n')).toContain('64MB');
    });

    it('treats null as absent, so the environment still applies', () => {
      // `opts.heapMb ?? ...` used to do this; an `=== undefined` test alone
      // would send a null straight to the fallback and discard a tighter env.
      vi.stubEnv('AXIOM_JS_COMPUTE_HEAP_MB', '32');
      expect(captureStderr(() => resolveHeapMb(null)).value).toBe(32);
    });
  });
});

describe('the resolved ceiling is what the child actually gets', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** OOMs at 16MB in ~0.5s; succeeds from 26MB up. */
  const OOMS_UNDER_24MB = { n: 3000 };

  it('hands an accepted option through unchanged', async () => {
    // The discriminating control: a resolver that quietly substituted the
    // default would resolve here instead of dying.
    const { value: host } = captureStderr(() =>
      createJsComputeHost({ heapMb: MIN_HEAP_MB, timeoutMs: 60_000 })
    );
    try {
      await expect(codeOf(host.run('bell_number', OOMS_UNDER_24MB))).resolves.toBe('out_of_memory');
    } finally {
      await host.dispose();
    }
  }, 120_000);

  it('hands an accepted environment value through unchanged', async () => {
    vi.stubEnv('AXIOM_JS_COMPUTE_HEAP_MB', String(MIN_HEAP_MB));
    const { value: host } = captureStderr(() => createJsComputeHost({ timeoutMs: 60_000 }));
    try {
      await expect(codeOf(host.run('bell_number', OOMS_UNDER_24MB))).resolves.toBe('out_of_memory');
    } finally {
      await host.dispose();
    }
  }, 120_000);

  it('computes under a fractional value instead of abandoning the call', async () => {
    // The reported defect, end to end: this used to fail in ~50ms as
    // `worker_failed` after three dead forks.
    vi.stubEnv('AXIOM_JS_COMPUTE_HEAP_MB', '1.5');
    const { value: host } = captureStderr(() => createJsComputeHost({ timeoutMs: 30_000 }));
    try {
      await expect(host.run('bell_number', { n: 5 })).resolves.toBe('52');
    } finally {
      await host.dispose();
    }
  }, 60_000);
});

describe('a heap too small for the mathjs tasks refuses them by name', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('warns at construction, naming the tools and the ceiling they need', () => {
    const { lines } = captureStderr(() =>
      createJsComputeHost({ heapMb: MATHJS_MIN_HEAP_MB - 1, timeoutMs: 60_000 })
    );
    expect(lines.join('\n')).toMatch(/quick_calc|plot/);
    expect(lines.join('\n')).toContain(String(MATHJS_MIN_HEAP_MB));
  });

  it('refuses a mathjs task with the cause, not as a worker fault', async () => {
    // Without the gate this forked three children, each of which died inside the
    // lazy mathjs import BEFORE its `start` ack — so `recycleAndRedispatch` had
    // no culprit to blame, the accurate out_of_memory was discarded, and the
    // caller got `worker_failed`: "not the caller's fault", which is exactly the
    // unactionable code this whole change exists to stop producing.
    const { value: host } = captureStderr(() =>
      createJsComputeHost({ heapMb: 32, timeoutMs: 60_000 })
    );
    try {
      const run = host.run('mathjs_evaluate', { expression: '2+2' });
      await expect(codeOf(run)).resolves.toBe('heap_too_small');
      await expect(run).rejects.toThrow(/AXIOM_JS_COMPUTE_HEAP_MB/);
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it('still runs the integer tasks at that ceiling, which is why it is not a floor', async () => {
    // 32MB is honoured, not raised: input-bounds.test.ts and
    // js-compute-error-codes.test.ts both drive OOM rows at exactly this value.
    const { value: host } = captureStderr(() =>
      createJsComputeHost({ heapMb: 32, timeoutMs: 60_000 })
    );
    try {
      await expect(host.run('bell_number', { n: 5 })).resolves.toBe('52');
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it('lets the mathjs tasks through at the threshold', async () => {
    // The other half of the bracket: the gate must not refuse a ceiling that
    // works. Measured, mathjs succeeds from 46MB up.
    const { value: host } = captureStderr(() =>
      createJsComputeHost({ heapMb: MATHJS_MIN_HEAP_MB, timeoutMs: 60_000 })
    );
    try {
      await expect(host.run('mathjs_evaluate', { expression: '2+2' })).resolves.toContain('"4"');
    } finally {
      await host.dispose();
    }
  }, 120_000);
});

describe('the bounds are stated once', () => {
  it('the CLI help quotes the constants rather than restating them', async () => {
    // The four numbers reach README, SECURITY.md and `--help`. The first two
    // cannot interpolate; this one can, and it is the surface an operator reads
    // without leaving the terminal — so it is pinned to the source of truth.
    // Round 1 of review found `--help` had been left behind by a bound change
    // exactly once already.
    const { USAGE } = await import('../src/cli/parse.js');
    expect(USAGE).toContain(`${MIN_HEAP_MB}-${MAX_HEAP_MB}`);
    expect(USAGE).toContain(`default ${DEFAULT_HEAP_MB}`);
    expect(USAGE).toContain(`${MATHJS_MIN_HEAP_MB}MB`);
  });
});
