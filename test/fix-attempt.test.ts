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

  it('emits JSON-only envelope (no boxed trailer) for verify result', async () => {
    const r = await verifyHandler({ claim: '1 + 1 = 2', method: 'symbolic' });
    expect(r.isError).toBe(false);
    const text = r.content[0].text;
    // verify is meta-information; must NOT emit a boxed trailer that
    // would hijack the model's last-boxed-wins extraction.
    expect(text).not.toMatch(/\\boxed\{/);
    const json = JSON.parse(text);
    expect(['TRUE', 'FALSE']).toContain(json.answer);
    expect(['high', 'medium', 'low']).toContain(json.confidence);
    expect(json).not.toHaveProperty('answer_boxed');
  });

  it('attaches fix_attempt on identity failure', async () => {
    const r = await verifyHandler({ claim: 'sin(x) = 2', method: 'symbolic' });
    const json = JSON.parse(r.content[0].text);  // text is now pure JSON
    // sin(x) = 2 has no real solution; this MUST verify FALSE.
    expect(json.answer).toBe('FALSE');
    expect(json.fix_attempt).toBeDefined();
    expect(json.fix_attempt.next_call.tool).toBe('compute');
  });

  it('passes checks_performed via steps and explanation field', async () => {
    const r = await verifyHandler({ claim: '1 + 1 = 2', method: 'symbolic' });
    const json = JSON.parse(r.content[0].text);
    expect(Array.isArray(json.steps)).toBe(true);
    expect(json.steps.length).toBeGreaterThan(0);
    expect(typeof json.explanation).toBe('string');
    expect(json.explanation.length).toBeGreaterThan(0);
    // raw should NOT carry explanation anymore.
    expect(json).not.toHaveProperty('raw');
  });

  it('emits low confidence when identity verification fails', async () => {
    // sin(x) = 2 has no real solution; symbolic check should return false.
    const r = await verifyHandler({ claim: 'sin(x) = 2', method: 'symbolic' });
    const json = JSON.parse(r.content[0].text);
    expect(json.answer).toBe('FALSE');
    expect(json.confidence).toBe('low');
  });
});
