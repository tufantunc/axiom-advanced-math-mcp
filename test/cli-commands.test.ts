import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { runCommand } from '../src/cli/commands.js';
import { giacEngine } from '../src/server/giac/index.js';
import { MAX_EXPRESSION_LENGTH } from '../src/server/tools/limits.js';

let out: string[] = [];
let err: string[] = [];
let stdoutRaw: string[] = [];
let workdir: string;

beforeAll(async () => {
  await giacEngine.initialize();
  workdir = mkdtempSync(join(tmpdir(), 'axiom-cmd-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  out = [];
  err = [];
  stdoutRaw = [];
});

/**
 * Captures what the command writes, so we assert on stdout/stderr separately.
 *
 * `plot` without `-o` writes the SVG straight to `process.stdout.write`
 * rather than `console.log`, so this spies on both — `out`/`err` for the
 * console-based paths, `stdoutRaw` for the raw-stdout one.
 */
function capture(): void {
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    err.push(a.map(String).join(' '));
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdoutRaw.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
}

/**
 * Swaps `process.stdin` for a stub stream, returning a restore function.
 *
 * `process.stdin` is a configurable own property, so this can safely
 * `defineProperty` over it for the duration of one test.
 */
function stubStdin(stream: { isTTY?: boolean } & NodeJS.ReadableStream): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'stdin')!;
  Object.defineProperty(process, 'stdin', { value: stream, configurable: true });
  return () => Object.defineProperty(process, 'stdin', original);
}

/** Overrides `process.stdout.isTTY` for the duration of one test. */
function withStdoutTTY(isTTY: boolean): () => void {
  const original = process.stdout.isTTY;
  Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true });
  return () => Object.defineProperty(process.stdout, 'isTTY', { value: original, configurable: true });
}

describe('runCommand — compute', () => {
  it('prints the value and exits 0 in quiet mode', async () => {
    capture();
    const code = await runCommand({ kind: 'compute', expression: 'solve(x^2-4=0,x)', output: 'quiet' });
    expect(code).toBe(0);
    expect(out.join('\n').trim()).toBe('{-2, 2}');
  }, 30_000);

  it('exits 1 on a bad expression and writes nothing to stdout', async () => {
    capture();
    const code = await runCommand({ kind: 'compute', expression: 'integrate(', output: 'text' });
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err.length).toBeGreaterThan(0);
  }, 30_000);
});

describe('runCommand — verify', () => {
  it('exits 0 for a true claim', async () => {
    capture();
    const code = await runCommand({ kind: 'verify', claim: 'sin(x)^2+cos(x)^2 = 1', output: 'quiet' });
    expect(code).toBe(0);
    expect(out.join('').trim()).toBe('true');
  }, 30_000);

  it('exits 2 for a false claim', async () => {
    capture();
    const code = await runCommand({ kind: 'verify', claim: 'sin(x)^2+cos(x)^2 = 2', output: 'quiet' });
    expect(code).toBe(2);
    expect(out.join('').trim()).toBe('false');
  }, 30_000);

  it('text mode still reports the verdict through the exit code', async () => {
    capture();
    const code = await runCommand({ kind: 'verify', claim: 'sin(x)^2+cos(x)^2 = 2', output: 'text' });
    expect(code).toBe(2);
    expect(out.join('\n')).toContain('Verified: FALSE');
  }, 30_000);
});

describe('runCommand — plot', () => {
  it('writes the file and prints its path in quiet mode', async () => {
    capture();
    const target = join(workdir, 'p.svg');
    const code = await runCommand({ kind: 'plot', expression: 'sin(x)', out: target, output: 'quiet' });
    expect(code).toBe(0);
    expect(out.join('').trim()).toBe(target);
    expect(readFileSync(target, 'utf8').startsWith('<svg')).toBe(true);
  }, 30_000);

  it('refuses to write the SVG to a terminal when there is no -o', async () => {
    capture();
    const restore = withStdoutTTY(true);
    try {
      await expect(
        runCommand({ kind: 'plot', expression: 'sin(x)', output: 'text' })
      ).rejects.toThrow(/refusing to write SVG to a terminal/);
    } finally {
      restore();
    }
    expect(out).toEqual([]);
    expect(stdoutRaw).toEqual([]);
  }, 30_000);

  it('writes the SVG to stdout (not console.log) when stdout is not a TTY', async () => {
    capture();
    const restore = withStdoutTTY(false);
    try {
      const code = await runCommand({ kind: 'plot', expression: 'sin(x)', output: 'text' });
      expect(code).toBe(0);
    } finally {
      restore();
    }
    // The SVG goes to the raw stdout spy, never through console.log.
    expect(out).toEqual([]);
    expect(stdoutRaw.join('').startsWith('<svg')).toBe(true);
  }, 30_000);

  it('--json succeeds without -o even when stdout is a TTY, since it prints metadata not SVG', async () => {
    capture();
    const restore = withStdoutTTY(true);
    try {
      const code = await runCommand({ kind: 'plot', expression: 'sin(x)', output: 'json' });
      expect(code).toBe(0);
    } finally {
      restore();
    }
    expect(stdoutRaw).toEqual([]);
    const meta = JSON.parse(out.join('\n'));
    expect(meta.ok).toBe(true);
    expect(meta.path).toBeNull();
    expect(meta.expression).toBe('sin(x)');
  }, 30_000);
});

describe('runCommand — stdin input', () => {
  it('refuses to hang when stdin is a TTY and no positional is given', async () => {
    const fakeStdin = Object.assign(new Readable({ read() {} }), { isTTY: true });
    const restore = stubStdin(fakeStdin);
    try {
      await expect(
        runCommand({ kind: 'compute', output: 'quiet' })
      ).rejects.toThrow(/no expression given — pass it as an argument or pipe it on stdin/);
    } finally {
      restore();
      fakeStdin.destroy();
    }
  }, 30_000);

  it('reads the expression from piped stdin when no positional is given', async () => {
    capture();
    const fakeStdin = Object.assign(Readable.from(['2+2']), { isTTY: false });
    const restore = stubStdin(fakeStdin);
    try {
      const code = await runCommand({ kind: 'compute', output: 'quiet' });
      expect(code).toBe(0);
      expect(out.join('').trim()).toBe('4');
    } finally {
      restore();
    }
  }, 30_000);
});

describe('resolveInput — input length cap (shared by compute, verify and plot)', () => {
  it('rejects an over-limit expression before evaluating it, writing nothing to stdout', async () => {
    capture();
    const tooLong = '1+'.repeat(MAX_EXPRESSION_LENGTH); // well past the 8192-char cap
    await expect(
      runCommand({ kind: 'compute', expression: tooLong, output: 'quiet' })
    ).rejects.toThrow(new RegExp(`${MAX_EXPRESSION_LENGTH}-character limit`));
    expect(out).toEqual([]);
  }, 30_000);
});

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});
