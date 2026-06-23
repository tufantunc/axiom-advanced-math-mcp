import { describe, it, expect } from 'vitest';
import { ARMS } from '../benchmark/differentiation/arms.js';

describe('differentiation arms', () => {
  it('defines exactly the three arms with distinct names', () => {
    expect(ARMS.map((a) => a.name).sort()).toEqual(['axiom', 'code-exec', 'pure-model']);
  });

  it('each arm has a non-empty allowlist and a declared mcp backend', () => {
    for (const arm of ARMS) {
      expect(Array.isArray(arm.allowedTools)).toBe(true);
      expect(arm.allowedTools.length).toBeGreaterThan(0);
      expect(['none', 'axiom']).toContain(arm.mcp);
    }
  });

  it('only the axiom arm attaches an MCP backend', () => {
    expect(ARMS.find((a) => a.name === 'axiom')!.mcp).toBe('axiom');
    expect(ARMS.find((a) => a.name === 'code-exec')!.mcp).toBe('none');
    expect(ARMS.find((a) => a.name === 'pure-model')!.mcp).toBe('none');
  });
});
