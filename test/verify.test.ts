import { describe, it, expect, beforeAll } from 'vitest';
import { verifyHandler } from '../src/server/tools/verify/index.js';
import { giacEngine } from '../src/server/giac/index.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

function getText(res: { content: { type: string; text: string }[] }): string {
  return res.content.map((c) => c.text).join('\n');
}

describe('Verify Tool', () => {
  describe('Identity verification', () => {
    it('should verify sin^2 + cos^2 = 1', async () => {
      const res = await verifyHandler({
        claim: 'sin(x)^2 + cos(x)^2 = 1',
      });
      const text = getText(res);
      expect(text).toContain('TRUE');
      expect(text).toContain('Verified');
    });

    it('should verify (a+b)^2 = a^2+2ab+b^2', async () => {
      const res = await verifyHandler({
        claim: '(a+b)^2 = a^2+2*a*b+b^2',
      });
      const text = getText(res);
      expect(text).toContain('TRUE');
    });

    it('should reject false identity sin(x) = cos(x)', async () => {
      const res = await verifyHandler({
        claim: 'sin(x) = cos(x)',
      });
      const text = getText(res);
      expect(text).toContain('FALSE');
    });

    it('should verify numeric identity 2+3 = 5', async () => {
      const res = await verifyHandler({
        claim: '2+3 = 5',
      });
      const text = getText(res);
      expect(text).toContain('TRUE');
    });

    it('should reject numeric identity 2+3 = 6', async () => {
      const res = await verifyHandler({
        claim: '2+3 = 6',
      });
      const text = getText(res);
      expect(text).toContain('FALSE');
    });
  });

  describe('Solution verification', () => {
    it('should verify x=2 satisfies x^2-4=0', async () => {
      const res = await verifyHandler({
        claim: 'x=2 satisfies x^2-4=0',
      });
      const text = getText(res);
      expect(text).toContain('TRUE');
    });

    it('should verify x=-2 satisfies x^2-4=0', async () => {
      const res = await verifyHandler({
        claim: 'x=-2 satisfies x^2-4=0',
      });
      const text = getText(res);
      expect(text).toContain('TRUE');
    });

    it('should reject x=3 satisfies x^2-4=0', async () => {
      const res = await verifyHandler({
        claim: 'x=3 satisfies x^2-4=0',
      });
      const text = getText(res);
      expect(text).toContain('FALSE');
    });

    it('should verify x=1 is a solution of x^3-1=0', async () => {
      const res = await verifyHandler({
        claim: 'x=1 is a solution of x^3-1=0',
      });
      const text = getText(res);
      expect(text).toContain('TRUE');
    });
  });

  describe('Method options', () => {
    it('should work with symbolic-only method', async () => {
      const res = await verifyHandler({
        claim: 'sin(x)^2 + cos(x)^2 = 1',
        method: 'symbolic',
      });
      const text = getText(res);
      expect(text).toContain('TRUE');
      expect(text).toContain('Symbolic');
    });

    it('should work with numeric-only method', async () => {
      const res = await verifyHandler({
        claim: '2+3 = 5',
        method: 'numeric',
      });
      const text = getText(res);
      expect(text).toContain('TRUE');
      expect(text).toContain('Numeric');
    });
  });

  describe('Unparseable claims', () => {
    it('should handle unparseable claim gracefully', async () => {
      const res = await verifyHandler({
        claim: 'this is not a math claim',
      });
      const text = getText(res);
      expect(res.isError).toBe(false);
      expect(text).toContain('Could not parse');
    });

    // `evaluated` is what separates "checked and refuted" from "never checked".
    // The CLI turns the first into exit 2 and the second into exit 1, so a
    // claim that reported evaluated: true here would be read as a refutation.
    it('reports evaluated: false for a claim that does not parse', async () => {
      const res = await verifyHandler({ claim: 'this is not a math claim', format: 'json' });
      const parsed = JSON.parse(getText(res));
      expect(parsed.verified).toBe(false);
      expect(parsed.evaluated).toBe(false);
    });

    it('reports evaluated: false for a parseable claim Giac cannot evaluate', async () => {
      const res = await verifyHandler({ claim: 'x + = 1', format: 'json' });
      const parsed = JSON.parse(getText(res));
      expect(parsed.verified).toBe(false);
      expect(parsed.evaluated).toBe(false);
    });

    it('says UNKNOWN rather than FALSE in text mode when nothing was checked', async () => {
      const text = getText(await verifyHandler({ claim: 'this is not a math claim' }));
      expect(text).toContain('UNKNOWN');
      expect(text).not.toContain('FALSE');
    });

    it('reports evaluated: true for a claim that really was refuted', async () => {
      const res = await verifyHandler({ claim: 'sin(x)^2+cos(x)^2 = 2', format: 'json' });
      const parsed = JSON.parse(getText(res));
      expect(parsed.verified).toBe(false);
      expect(parsed.evaluated).toBe(true);
    });
  });
});
