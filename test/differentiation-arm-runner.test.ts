import { describe, it, expect } from 'vitest';
import { armCliArgs } from '../benchmark/differentiation/arm-runner.js';
import { ARMS } from '../benchmark/differentiation/arms.js';

const opts = { model: 'claude-sonnet-4-6', maxTurns: 8, axiomMcpPath: '/tmp/axiom.json' };

describe('armCliArgs', () => {
  it('axiom arm: attaches axiom mcp config + restricts tools to mcp__axiom', () => {
    const arm = ARMS.find((a) => a.name === 'axiom')!;
    const args = armCliArgs('PROMPT', arm, opts);
    expect(args[0]).toBe('-p');
    expect(args[1]).toBe('PROMPT');
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/tmp/axiom.json');
    expect(args[args.indexOf('--tools') + 1]).toBe('mcp__axiom');
  });

  it('code-exec arm: no mcp config, restricts tools to Bash', () => {
    const arm = ARMS.find((a) => a.name === 'code-exec')!;
    const args = armCliArgs('P', arm, opts);
    expect(args).not.toContain('--mcp-config');
    expect(args[args.indexOf('--tools') + 1]).toBe('Bash');
  });

  it('pure-model arm: no mcp config, restricts tools to mcp__none', () => {
    const arm = ARMS.find((a) => a.name === 'pure-model')!;
    const args = armCliArgs('P', arm, opts);
    expect(args).not.toContain('--mcp-config');
    expect(args[args.indexOf('--tools') + 1]).toBe('mcp__none');
  });
});
