import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { evalWithLatex } from '../src/server/tools/giac-eval.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

function allText(r: { content: { text: string }[] }): string {
  return r.content.map((c) => c.text).join('\n');
}

describe('evalWithLatex — verify callback + methodNote', () => {
  it('attaches verification from the verify callback', async () => {
    const r = await evalWithLatex({
      giacExpr: 'factor(x^2-4)',
      operation: 'factor',
      verify: async () => ({ verified: true, method: 'expand', detail: 'ok' }),
    });
    expect(allText(r)).toContain('Verified: ✓ (expand: ok)');
  });
  it('passes methodNote through', async () => {
    const r = await evalWithLatex({
      giacExpr: 'csolve(x^2+1,x)',
      operation: 'solve',
      methodNote: 'csolve (escalated)',
      verify: async () => ({ verified: true, method: 'substitution', detail: '2/2' }),
    });
    expect(allText(r)).toContain('Method: csolve (escalated)');
  });
});
