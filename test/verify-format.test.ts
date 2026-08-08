import { describe, it, expect } from 'vitest';
import { verifyHandler } from '../src/server/tools/verify/index.js';

function text(r: { content: { text: string }[] }): string {
  return r.content.map((c) => c.text).join('\n');
}

describe('verify format: json', () => {
  it('returns a parseable VerifyResult for a true claim', async () => {
    const r = await verifyHandler({ claim: 'sin(x)^2+cos(x)^2 = 1', format: 'json' });
    const parsed = JSON.parse(text(r));
    expect(parsed.verified).toBe(true);
    expect(parsed.confidence).toBeDefined();
    expect(Array.isArray(parsed.checks_performed)).toBe(true);
  });

  it('reports verified:false for a false claim', async () => {
    const r = await verifyHandler({ claim: 'sin(x)^2+cos(x)^2 = 2', format: 'json' });
    expect(JSON.parse(text(r)).verified).toBe(false);
  });

  it('still returns human-readable text by default', async () => {
    const r = await verifyHandler({ claim: 'sin(x)^2+cos(x)^2 = 1' });
    expect(text(r)).toContain('Verified: TRUE');
  });
});
