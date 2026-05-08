import { describe, it, expect } from 'vitest';
import { buildConfig } from '../benchmark/config.js';

describe('buildConfig — tokens-8k feature flag', () => {
  it('returns maxTokens=4096 by default', () => {
    process.argv = ['tsx', 'index.ts', '--quick'];
    const c = buildConfig();
    expect(c.maxTokens).toBe(4096);
  });

  it('returns maxTokens=8192 when tokens-8k is in features', () => {
    process.argv = ['tsx', 'index.ts', '--quick', '--features=tokens-8k'];
    const c = buildConfig();
    expect(c.maxTokens).toBe(8192);
  });

  it('handles tokens-8k combined with other features', () => {
    process.argv = ['tsx', 'index.ts', '--quick', '--features=v2,tokens-8k,output-hygiene'];
    const c = buildConfig();
    expect(c.maxTokens).toBe(8192);
    expect(c.features).toEqual(['v2', 'tokens-8k', 'output-hygiene']);
  });

  it('does NOT bump tokens for other features', () => {
    process.argv = ['tsx', 'index.ts', '--quick', '--features=v2'];
    const c = buildConfig();
    expect(c.maxTokens).toBe(4096);
  });
});
