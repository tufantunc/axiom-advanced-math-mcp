import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERSION } from '../src/version.js';

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the built CLI with the given args, optionally piping stdin. */
async function cli(args: string[], stdin?: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['dist/cli.js', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

let workdir: string;

beforeAll(() => {
  if (!existsSync('dist/cli.js')) {
    throw new Error('dist/cli.js missing — run `npm run build` before the integration suite');
  }
  workdir = mkdtempSync(join(tmpdir(), 'axiom-cli-'));
});

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('CLI — the MCP server still starts with no arguments', () => {
  // THE critical test: adding CLI mode must not break any existing MCP client
  // config, all of which invoke the bin with no arguments.
  it('completes an MCP initialize handshake over stdio', async () => {
    const child = spawn('node', ['dist/cli.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));

    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'cli-contract', version: '1.0.0' },
        },
      }) + '\n'
    );

    try {
      const response = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no MCP response within 20s')), 20_000);
        child.stdout.on('data', () => {
          const line = out.split('\n').find((l) => l.includes('"result"'));
          if (line) {
            clearTimeout(timer);
            resolve(line);
          }
        });
      });

      const parsed = JSON.parse(response);
      expect(parsed.result.serverInfo.name).toBe('axiom-advanced-math-mcp');
    } finally {
      child.kill('SIGKILL');
    }
  }, 30_000);
});

describe('CLI — compute', () => {
  it('computes and exits 0', async () => {
    const r = await cli(['compute', 'integrate(sin(x)^3,x)']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('-cos(x)+cos(x)^3/3');
  }, 30_000);

  it('-q prints exactly the value and nothing else', async () => {
    const r = await cli(['compute', '-q', 'solve(x^2-4=0,x)']);
    expect(r.code).toBe(0);
    // The contract a skill builds on: one line, no decoration.
    expect(r.stdout.trim()).toBe('{-2, 2}');
  }, 30_000);

  it('--json emits a parseable envelope', async () => {
    const r = await cli(['compute', '--json', 'solve(x^2-4=0,x)']);
    expect(r.code).toBe(0);
    const envelope = JSON.parse(r.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.display).toBe('{-2, 2}');
  }, 30_000);

  it('reads the expression from stdin', async () => {
    const r = await cli(['compute', '-q'], 'diff(x^3,x)\n');
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('3*x^2');
  }, 30_000);

  it('exits 1 on a bad expression and keeps stdout clean', async () => {
    const r = await cli(['compute', 'integrate(']);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).not.toBe('');
  }, 30_000);

  it('-- lets an expression that starts with a minus sign through', async () => {
    const r = await cli(['compute', '-q', '--', '-2+2']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('0');
  }, 30_000);
});

describe('CLI — verify', () => {
  it('exits 0 for a true claim', async () => {
    const r = await cli(['verify', 'sin(x)^2+cos(x)^2 = 1']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Verified: TRUE');
  }, 30_000);

  it('exits 2 for a false claim', async () => {
    const r = await cli(['verify', 'sin(x)^2+cos(x)^2 = 2']);
    expect(r.code).toBe(2);
  }, 30_000);

  it('--json exposes the verified field', async () => {
    const r = await cli(['verify', '--json', 'sin(x)^2+cos(x)^2 = 1']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).verified).toBe(true);
  }, 30_000);

  it('-q prints just the boolean', async () => {
    const r = await cli(['verify', '-q', 'sin(x)^2+cos(x)^2 = 2']);
    expect(r.code).toBe(2);
    expect(r.stdout.trim()).toBe('false');
  }, 30_000);
});

describe('CLI — plot', () => {
  it('writes an SVG file', async () => {
    const target = join(workdir, 'wave.svg');
    const r = await cli(['plot', 'sin(x)', '-o', target]);
    expect(r.code).toBe(0);
    expect(readFileSync(target, 'utf8').startsWith('<svg')).toBe(true);
  }, 30_000);

  it('-q prints the path it wrote', async () => {
    const target = join(workdir, 'quiet.svg');
    const r = await cli(['plot', 'sin(x)', '-o', target, '-q']);
    expect(r.stdout.trim()).toBe(target);
  }, 30_000);

  it('--json describes the file', async () => {
    const target = join(workdir, 'meta.svg');
    const r = await cli(['plot', 'sin(x)', '-o', target, '--json']);
    const meta = JSON.parse(r.stdout);
    expect(meta.ok).toBe(true);
    expect(meta.path).toBe(target);
    expect(meta.x_range).toEqual([-10, 10]);
  }, 30_000);

  it('writes the SVG to stdout when stdout is not a TTY and no -o is given', async () => {
    const r = await cli(['plot', 'sin(x)']);
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith('<svg')).toBe(true);
  }, 30_000);

  it('--json without -o succeeds and emits parseable metadata with a null path', async () => {
    const r = await cli(['plot', 'sin(x)', '--json']);
    expect(r.code).toBe(0);
    const meta = JSON.parse(r.stdout);
    expect(meta.ok).toBe(true);
    expect(meta.path).toBeNull();
  }, 30_000);
});

describe('CLI — meta', () => {
  it('--version matches the package version', async () => {
    const r = await cli(['--version']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(VERSION);
  });

  it('--help exits 0 and writes usage to stdout', async () => {
    const r = await cli(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('axiom-mcp compute');
  });

  it('compute --help exits 0 and documents only compute\'s own flags', async () => {
    const r = await cli(['compute', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('axiom-mcp compute');
    expect(r.stdout).toContain('--domain');
    expect(r.stdout).toContain('--precision');
    expect(r.stdout).not.toContain('--method');
    expect(r.stdout).not.toContain('--variable');
    expect(r.stdout).not.toContain('--x-min');
  });

  it('verify --help exits 0 and documents only verify\'s own flags', async () => {
    const r = await cli(['verify', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('axiom-mcp verify');
    expect(r.stdout).toContain('--method');
    expect(r.stdout).not.toContain('--domain');
    expect(r.stdout).not.toContain('--precision');
    expect(r.stdout).not.toContain('--variable');
  });

  it('plot --help exits 0 and documents only plot\'s own flags', async () => {
    const r = await cli(['plot', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('axiom-mcp plot');
    expect(r.stdout).toContain('--variable');
    expect(r.stdout).toContain('--x-min');
    expect(r.stdout).not.toContain('--domain');
    expect(r.stdout).not.toContain('--method');
  });

  it('rejects an unknown subcommand with usage on stderr, not stdout', async () => {
    const r = await cli(['frobnicate']);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('unknown command');
  });

  it('rejects conflicting output modes', async () => {
    const r = await cli(['compute', '2+2', '--json', '-q']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('mutually exclusive');
  });
});
