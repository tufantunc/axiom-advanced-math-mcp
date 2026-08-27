import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { computeHandler } from '../src/server/tools/compute/index.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

const text = (r: { content: { text: string }[] }): string =>
  r.content.map((c) => c.text).join('\n');

describe('sequence_identify: a pattern needs at least two terms', () => {
  it('rejects an unparseable term list instead of calling it constant', async () => {
    // `[].every(...)` is vacuously true, so an empty list satisfied the
    // constant-sequence check and reported "Constant sequence" with
    // `a(n) = undefined` and isError false.
    const r = await computeHandler({ problem: 'sequence(a_n = 2*n+1)' });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('at least 2 terms');
    expect(text(r)).not.toContain('Constant sequence');
  });

  it('rejects a single term', async () => {
    const r = await computeHandler({ problem: 'sequence(5)' });
    expect(r.isError).toBe(true);
  });

  it('still identifies a real sequence', async () => {
    const out = text(await computeHandler({ problem: 'sequence(2,4,6,8)' }));
    expect(out).toContain('Arithmetic sequence');
  });

  it('accepts the smallest real sequence — two terms', async () => {
    // The boundary the guard moved. Without this, raising it to `< 3` would
    // reject exactly what the guard is meant to admit, with the suite green.
    const out = text(await computeHandler({ problem: 'sequence(3,7)' }));
    expect(out).toContain('Arithmetic sequence');
  });

  it('accepts the bracketed form as well as the bare one', async () => {
    // `JSON.parse('[' + '[2,4,6,8]' + ']')` gave [[2,4,6,8]] — one element —
    // so the arity guard told a user who typed four terms they supplied one.
    const bracketed = text(await computeHandler({ problem: 'sequence([2,4,6,8])' }));
    const bare = text(await computeHandler({ problem: 'sequence(2,4,6,8)' }));
    expect(bracketed).toBe(bare);
    expect(bracketed).toContain('Arithmetic sequence');
  });

  it('a genuinely constant sequence is still constant', async () => {
    const out = text(await computeHandler({ problem: 'sequence(5,5,5)' }));
    expect(out).toContain('Constant sequence');
    // Assert the payload: `not.toContain('undefined')` cannot fail here, since
    // terms[0] is 5 on every path that reaches this branch.
    expect(out).toContain('a(n) = 5');
  });
});
