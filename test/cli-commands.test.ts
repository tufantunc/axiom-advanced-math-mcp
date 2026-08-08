import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../src/cli/commands.js';
import { giacEngine } from '../src/server/giac/index.js';

let out: string[] = [];
let err: string[] = [];
let workdir: string;

beforeAll(async () => {
  await giacEngine.initialize();
  workdir = mkdtempSync(join(tmpdir(), 'axiom-cmd-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  out = [];
  err = [];
});

/** Captures what the command writes, so we assert on stdout/stderr separately. */
function capture(): void {
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    err.push(a.map(String).join(' '));
  });
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
});

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});
