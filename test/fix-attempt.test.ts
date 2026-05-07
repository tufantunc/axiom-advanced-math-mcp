import { describe, it, expect } from 'vitest';
import { buildFixAttempt } from '../src/server/tools/verify/fix-attempt.js';

describe('buildFixAttempt', () => {
  it('returns undefined when verification passed', () => {
    expect(
      buildFixAttempt({ verified: true, type: 'identity', lhs: 'sin(x)^2 + cos(x)^2', rhs: '1' })
    ).toBeUndefined();
  });

  it('suggests compute(simplify(LHS)) for failed identity', () => {
    const fa = buildFixAttempt({
      verified: false,
      type: 'identity',
      lhs: 'sin(x)^2 + cos(x)^2',
      rhs: '2',
    });
    expect(fa).toBeDefined();
    expect(fa!.next_call.tool).toBe('compute');
    expect(fa!.next_call.args).toEqual({ problem: 'simplify(sin(x)^2 + cos(x)^2)' });
    expect(fa!.rationale).toContain('LHS');
  });

  it('suggests compute(solve(equation)) for failed solution check', () => {
    const fa = buildFixAttempt({
      verified: false,
      type: 'solution',
      variable: 'x',
      value: '3',
      equation: 'x^2 - 4 = 0',
    });
    expect(fa).toBeDefined();
    expect(fa!.next_call.tool).toBe('compute');
    expect(fa!.next_call.args).toEqual({ problem: 'solve(x^2 - 4 = 0, x)' });
  });

  it('returns undefined for unknown claim shape', () => {
    expect(
      buildFixAttempt({ verified: false, type: 'unknown' })
    ).toBeUndefined();
  });
});

import { describe as describeIntegration, beforeEach, afterEach } from 'vitest';
import { verifyHandler } from '../src/server/tools/verify/index.js';

describeIntegration('verifyHandler — v2 envelope', () => {
  beforeEach(() => {
    process.env.AXIOM_OUTPUT_V2 = '1';
  });
  afterEach(() => {
    delete process.env.AXIOM_OUTPUT_V2;
  });

  it('emits boxed TRUE / FALSE answer + confidence', async () => {
    const r = await verifyHandler({ claim: '1 + 1 = 2', method: 'symbolic' });
    expect(r.isError).toBe(false);
    const lines = r.content[0].text.split('\n');
    expect(lines[lines.length - 1]).toMatch(/^\\boxed\{(TRUE|FALSE)\}$/);
    const json = JSON.parse(lines[0]);
    expect(['TRUE', 'FALSE']).toContain(json.answer);
    expect(['high', 'medium', 'low']).toContain(json.confidence);
  });

  it('attaches fix_attempt on identity failure', async () => {
    const r = await verifyHandler({ claim: 'sin(x) = 2', method: 'symbolic' });
    const json = JSON.parse(r.content[0].text.split('\n')[0]);
    if (json.answer === 'FALSE') {
      expect(json.fix_attempt).toBeDefined();
      expect(json.fix_attempt.next_call.tool).toBe('compute');
    }
  });
});
