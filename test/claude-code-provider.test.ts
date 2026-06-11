import { describe, it, expect } from 'vitest';
import { buildCliArgs, buildMcpConfig, ClaudeCodeProvider } from '../benchmark/providers/claude-code.js';

describe('claude-code provider: CLI arg construction', () => {
  it('baseline args: isolation flags present, no --mcp-config', () => {
    const args = buildCliArgs({ model: 'claude-sonnet-4-6', maxTurns: 8 });
    expect(args).toContain('--setting-sources');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('project');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(args).toContain('--verbose');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-4-6');
    expect(args[args.indexOf('--max-turns') + 1]).toBe('8');
    expect(args).not.toContain('--mcp-config');
  });

  it('tool-condition args add --mcp-config with the given path', () => {
    const args = buildCliArgs({ model: 'claude-sonnet-4-6', maxTurns: 8, mcpConfigPath: '/tmp/x.json' });
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/tmp/x.json');
  });

  it('passes a system prompt via --append-system-prompt when provided', () => {
    const args = buildCliArgs({ model: 'claude-sonnet-4-6', maxTurns: 8, appendSystemPrompt: 'SYS' });
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('SYS');
  });

  it('omits --append-system-prompt when not provided', () => {
    const args = buildCliArgs({ model: 'claude-sonnet-4-6', maxTurns: 8 });
    expect(args).not.toContain('--append-system-prompt');
  });
});

describe('claude-code provider: MCP config generation', () => {
  it('resolves relative paths in mcpServerCmd to absolute (CLI runs in a temp cwd)', () => {
    const cfg = buildMcpConfig(['tsx', '../src/cli.ts'], '/repo/benchmark');
    const axiom = cfg.mcpServers.axiom;
    expect(axiom.command).toBe('/repo/benchmark/node_modules/.bin/tsx');
    expect(axiom.args).toEqual(['/repo/src/cli.ts']);
  });

  it('keeps absolute commands and non-path args as-is', () => {
    const cfg = buildMcpConfig(['/usr/local/bin/node', 'dist/cli.js', '--flag'], '/repo/benchmark');
    expect(cfg.mcpServers.axiom.command).toBe('/usr/local/bin/node');
    expect(cfg.mcpServers.axiom.args).toEqual(['/repo/benchmark/dist/cli.js', '--flag']);
  });
});

const SMOKE = process.env.CLAUDE_CODE_SMOKE === '1';

describe.skipIf(!SMOKE)('claude-code provider: live smoke (CLAUDE_CODE_SMOKE=1)', () => {
  // Vitest runs from the repo root, so the MCP server entry resolves from there.
  const mcpCmd = ['tsx', 'src/cli.ts'];

  it('baseline answers a trivial problem', async () => {
    const p = new ClaudeCodeProvider('claude-haiku-4-5', mcpCmd);
    const r = await p.runBaseline('What is 2+2? Reply with just the number.', 4096);
    expect(r.text).toContain('4');
    expect(r.outputTokens).toBeGreaterThan(0);
  }, 300000);

  it('tool condition reaches the Axiom MCP server', async () => {
    const p = new ClaudeCodeProvider('claude-haiku-4-5', mcpCmd);
    const r = await p.runWithTools(
      'Use the axiom compute tool to find the derivative of x^3 with respect to x. Put the final answer in \\boxed{}.',
      [],
      async () => { throw new Error('unused'); },
      4096,
      8
    );
    expect(r.toolCalls.some((tc) => tc.name.startsWith('mcp__axiom__'))).toBe(true);
    expect(r.text).toContain('3');
  }, 300000);
});
