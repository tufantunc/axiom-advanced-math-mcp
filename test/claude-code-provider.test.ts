import { describe, it, expect } from 'vitest';
import { buildCliArgs, buildMcpConfig } from '../benchmark/providers/claude-code.js';

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
