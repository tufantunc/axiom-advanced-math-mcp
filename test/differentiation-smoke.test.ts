import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { ARMS } from '../benchmark/differentiation/arms.js';
import { runArm } from '../benchmark/differentiation/arm-runner.js';
import { buildMcpConfig } from '../benchmark/providers/claude-code.js';

const SMOKE = process.env.CLAUDE_CODE_SMOKE === '1';

describe.skipIf(!SMOKE)('differentiation live smoke (CLAUDE_CODE_SMOKE=1)', () => {
  const workdir = mkdtempSync(path.join(tmpdir(), 'axiom-diff-smoke-'));
  const nm = path.join(process.cwd(), 'node_modules');
  if (existsSync(nm)) {
    try { symlinkSync(nm, path.join(workdir, 'node_modules')); } catch { /* */ }
  }
  const axiomCfg = path.join(workdir, 'axiom.json');
  writeFileSync(axiomCfg, JSON.stringify(buildMcpConfig(['tsx', 'src/cli.ts'], process.cwd())));
  const opts = { model: 'claude-haiku-4-5', maxTurns: 8, axiomMcpPath: axiomCfg, cwd: workdir };

  it('axiom arm is restricted to the axiom MCP (never calls Bash)', async () => {
    // NOTE: Claude Code `-p` starts the model's first turn before the MCP
    // connection completes, so on solvable problems the model may answer
    // without calling mcp__axiom__ (client-side MCP-timing artifact; built-in
    // Bash is turn-1 available but MCP tools are not). What we CAN assert is
    // that the --tools restriction holds: the arm never falls back to Bash.
    const arm = ARMS.find((a) => a.name === 'axiom')!;
    const r = await runArm('Compute the indefinite integral of x^2*ln(x) dx. End with \\boxed{...}.', arm, opts);
    expect(r.ok).toBe(true);
    expect(r.toolCalls.some((t) => t.name === 'Bash')).toBe(false);
  }, 300000);

  it('pure-model arm makes no tool calls', async () => {
    const arm = ARMS.find((a) => a.name === 'pure-model')!;
    const r = await runArm('What is the derivative of x^3? End with \\boxed{...}.', arm, opts);
    expect(r.toolCalls.length).toBe(0);
  }, 300000);
});
