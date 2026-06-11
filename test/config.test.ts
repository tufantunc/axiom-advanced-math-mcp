import { describe, it, expect, beforeEach } from 'vitest';
import { buildConfig } from '../benchmark/config.js';

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

describe('buildConfig — claude-code provider flag', () => {
  it('--claude-code selects the provider with the sonnet default model', () => {
    process.argv = ['tsx', 'index.ts', '--cas', '--quick', '--claude-code'];
    const c = buildConfig();
    expect(c.provider).toBe('claude-code');
    expect(c.model).toBe('claude-sonnet-4-6');
  });

  it('--model overrides the default', () => {
    process.argv = ['tsx', 'index.ts', '--cas', '--quick', '--claude-code', '--model', 'claude-haiku-4-5'];
    const c = buildConfig();
    expect(c.provider).toBe('claude-code');
    expect(c.model).toBe('claude-haiku-4-5');
  });
});
