import { describe, it, expect, beforeAll } from 'vitest';
import { gradeV2Async } from '../benchmark/graders/grader-v2.js';
import { getDefaultGiacBridge } from '../benchmark/graders/giac-bridge.js';
import { grade } from '../benchmark/graders/grader.js';

let giacEval: (expr: string) => Promise<string | null>;
beforeAll(async () => {
  const bridge = await getDefaultGiacBridge();
  giacEval = (expr) => bridge.evaluate(expr);
}, 60000);

describe('symbolic equivalence — recovered cases', () => {
  it('matches equivalent rational forms', async () => {
    const r = await gradeV2Async('1/(1+x^2)', '1/(x^2+1)', { giacEval });
    expect(r.match).toBe(true);
    expect(r.method).toBe('symbolic');
  });
  it('matches a re-associated polynomial', async () => {
    const r = await gradeV2Async('(x+1)^2', 'x^2+2*x+1', { giacEval });
    expect(r.match).toBe(true);
  });
});

describe('symbolic equivalence — guardrail (must NOT match)', () => {
  it('rejects genuinely different expressions', async () => {
    expect((await gradeV2Async('x^2', 'x^3', { giacEval })).match).toBe(false);
    expect((await gradeV2Async('1/(1+x^2)', '2/(1+x^2)', { giacEval })).match).toBe(false);
  });
  it('rejects non-equal abs vs bare (ln|x| vs ln x)', async () => {
    expect((await gradeV2Async('ln(abs(x))', 'ln(x)', { giacEval })).match).toBe(false);
  });
});

describe('async grade() end-to-end', () => {
  it('grades an equivalent-form response correct via symbolic stage', async () => {
    const r = await grade('Therefore the derivative is \\(\\frac{1}{1+x^2}\\).', '1/(x^2+1)');
    expect(r.correct).toBe(true);
    expect(r.method).toBe('symbolic');
  });
  it('still grades a wrong response wrong', async () => {
    const r = await grade('The answer is x^3.', 'x^2');
    expect(r.correct).toBe(false);
  });
});
