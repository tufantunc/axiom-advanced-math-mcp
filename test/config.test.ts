import { describe, it, expect, beforeEach } from 'vitest';
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

describe('buildConfig — self-consistency feature flag', () => {
  beforeEach(() => {
    delete process.env.AXIOM_SC_N;
    delete process.env.AXIOM_SC_TEMP;
  });

  it('selfConsistency is null by default', () => {
    process.argv = ['tsx', 'index.ts', '--quick'];
    const c = buildConfig();
    expect(c.selfConsistency).toBeNull();
  });

  it('returns N=3 temperature=0.7 when --features=self-consistency', () => {
    process.argv = ['tsx', 'index.ts', '--quick', '--features=self-consistency'];
    const c = buildConfig();
    expect(c.selfConsistency).toEqual({ N: 3, temperature: 0.7 });
  });

  it('AXIOM_SC_N env var overrides N', () => {
    process.argv = ['tsx', 'index.ts', '--quick', '--features=self-consistency'];
    process.env.AXIOM_SC_N = '5';
    const c = buildConfig();
    expect(c.selfConsistency).toEqual({ N: 5, temperature: 0.7 });
  });

  it('AXIOM_SC_TEMP env var overrides temperature', () => {
    process.argv = ['tsx', 'index.ts', '--quick', '--features=self-consistency'];
    process.env.AXIOM_SC_TEMP = '0.5';
    const c = buildConfig();
    expect(c.selfConsistency).toEqual({ N: 3, temperature: 0.5 });
  });

  it('env vars are ignored when flag is not present', () => {
    process.argv = ['tsx', 'index.ts', '--quick'];
    process.env.AXIOM_SC_N = '5';
    process.env.AXIOM_SC_TEMP = '0.5';
    const c = buildConfig();
    expect(c.selfConsistency).toBeNull();
  });
});
