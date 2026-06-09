import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { evalWithLatex } from '../src/server/tools/giac-eval.js';
import { computeHandler } from '../src/server/tools/compute/index.js';
import { verifyHandler } from '../src/server/tools/verify/index.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

function allText(r: { content: { text: string }[] }): string {
  return r.content.map((c) => c.text).join('\n');
}

describe('evalWithLatex — input unicode normalization', () => {
  it('normalizes a superscript in giacExpr (no micro corruption)', async () => {
    const r = await evalWithLatex({ giacExpr: 'factor(x²-4)', operation: 'factor' });
    const text = allText(r);
    expect(text).toContain('Result: (x-2)*(x+2)');
    expect(text).not.toContain('micro');
  });
  it('normalizes a middot in giacExpr (no undef)', async () => {
    const r = await evalWithLatex({ giacExpr: 'simplify(2·x)', operation: 'simplify' });
    expect(allText(r)).toContain('Result: 2*x');
  });
});

describe('compute end-to-end — input unicode normalization', () => {
  it('factor(x²-4) via computeHandler resolves correctly', async () => {
    const r = await computeHandler({ problem: 'factor(x²-4)' });
    const text = allText(r);
    expect(text).toContain('(x-2)*(x+2)');
    expect(text).not.toContain('micro');
  });
});

describe('verify tool — input unicode normalization', () => {
  it('verifies an identity written with unicode glyphs', async () => {
    const r = await verifyHandler({ claim: 'x² = x·x' });
    expect(allText(r)).toContain('Verified: TRUE ✓');
  });
});
