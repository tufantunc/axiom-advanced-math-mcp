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

    it.each([
      ['(a+b)^2 = a^2+2ab+b^2', '(a+b)^2 = a^2+2*a*b+b^2'],
      ['2+3 = 5', '2+3 = 5'],
    ])('should verify %s', async (_label, claim) => {
      const res = await verifyHandler({ claim });
      const text = getText(res);
      // Full verdict line: every FALSE output also contains the letter T,
      // so a shorter matcher cannot discriminate (found by mutation).
      expect(text).toContain('Verified: TRUE');
    });

    it('should reject false identity sin(x) = cos(x)', async () => {
      const res = await verifyHandler({
        claim: 'sin(x) = cos(x)',
      });
      const text = getText(res);
      expect(text).toContain('FALSE');
      // The diagnostic names WHERE the sampled check failed, at which
      // substitution, with what residual — pin its shape so the failure
      // detail cannot degrade into an unreadable blob.
      expect(text).toMatch(/At x=[-\d.]+: diff = [-\d.e+]+/);
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
    it.each([
      ['x=2 satisfies x^2-4=0', 'TRUE'],
      ['x=-2 satisfies x^2-4=0', 'TRUE'],
      ['x=3 satisfies x^2-4=0', 'FALSE'],
      ['x=1 is a solution of x^3-1=0', 'TRUE'],
    ])('should rule on %s', async (claim, verdict) => {
      const res = await verifyHandler({ claim });
      const text = getText(res);
      // Full verdict line — every FALSE output also contains the letter T.
      expect(text).toContain(`Verified: ${verdict}`);
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
    it.each([
      ['a claim that does not parse', 'this is not a math claim'],
      ['a parseable claim Giac cannot evaluate', 'x + = 1'],
    ])('reports evaluated: false for %s', async (_label, claim) => {
      const res = await verifyHandler({ claim, format: 'json' });
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

  describe('Claims a side of which Giac reads as its undefined marker', () => {
    // Giac does not error on these notations — it answers `(f^(+))(x)` and
    // `x^(-1) sin(x)` with `undef(x)` (measured on the real engine). Two such
    // sides then AGREE: the symbolic difference is 0 and every sampled point
    // substitutes to 0, so the claim certified as TRUE with high confidence.
    // An `undef` anywhere in a side's reading means the notation was not
    // understood, and the claim is UNKNOWN — never verified, never refuted.
    it.each([
      '(f^(+))(x) = (f^(-))(x)',
      '(f^())(x) = (g^())(x)',
      'x^(-1) sin(x) = x^(-1) cos(x)',
      'x^(-1) f2(x) = x^(-1) g2(x)',
    ])('stays UNKNOWN: %s', async (claim) => {
      const res = await verifyHandler({ claim, format: 'json' });
      const parsed = JSON.parse(getText(res));
      expect(parsed.verified).toBe(false);
      expect(parsed.evaluated).toBe(false);
    });

    it.each(['symbolic', 'numeric'] as const)(
      'method=%s alone cannot certify the collapse: (f^(+))(x) = (f^(-))(x)',
      async (method) => {
        // The refusal happens before either strategy runs. These rows pin
        // that neither strategy is left as an unguarded way in — a guard
        // that only covered the symbolic path would pass method=symbolic and
        // redden the numeric row (verified by mutation).
        const res = await verifyHandler({
          claim: '(f^(+))(x) = (f^(-))(x)',
          method,
          format: 'json',
        });
        const parsed = JSON.parse(getText(res));
        expect(parsed.verified).toBe(false);
        expect(parsed.evaluated).toBe(false);
      }
    );

    it('stays UNKNOWN when the collapse hides in a solution claim equation', async () => {
      // Both sides of the equation read undef(x); substituting x=2 into
      // undef(x) - undef(x) yields 0 and the solution certified as TRUE.
      const res = await verifyHandler({
        claim: 'x=2 satisfies (f^(+))(x) = (f^(+))(x)',
        format: 'json',
      });
      const parsed = JSON.parse(getText(res));
      expect(parsed.verified).toBe(false);
      expect(parsed.evaluated).toBe(false);
    });

    it('stays UNKNOWN when the asserted value itself reads undefined', async () => {
      const res = await verifyHandler({
        claim: 'x = (f^(+))(x) satisfies x - x = 0',
        format: 'json',
      });
      const parsed = JSON.parse(getText(res));
      expect(parsed.verified).toBe(false);
      expect(parsed.evaluated).toBe(false);
    });

    it('says UNKNOWN, not FALSE, in text mode for an undefined-collapse claim', async () => {
      const text = getText(await verifyHandler({ claim: 'x^(-1) sin(x) = x^(-1) cos(x)' }));
      expect(text).toContain('Verified: UNKNOWN');
      expect(text).not.toContain('FALSE');
    });

    // Whole-result undef sides were already refused before this guard
    // existed; it must not loosen that.
    it.each(['1/0 = 1/0', 'x^(-1)y = x^(-1)z'])('keeps refusing whole-undef sides: %s', async (claim) => {
      const res = await verifyHandler({ claim, format: 'json' });
      const parsed = JSON.parse(getText(res));
      expect(parsed.verified).toBe(false);
      expect(parsed.evaluated).toBe(false);
    });

    // A claim genuinely about `undef` keeps its verdict: the limit side reads
    // bounded_function(1), the `undef` side now trips the same reading guard
    // that the old whole-result check caught — UNKNOWN before, UNKNOWN after.
    it('a claim that a limit equals undef stays UNKNOWN', async () => {
      const res = await verifyHandler({ claim: 'limit(sin(1/x), x, 0) = undef', format: 'json' });
      const parsed = JSON.parse(getText(res));
      expect(parsed.verified).toBe(false);
      expect(parsed.evaluated).toBe(false);
    });

    // Giac echoes identifiers that merely contain the letters verbatim
    // (`undefx+1` evaluates to `undefx+1`), so the marker is matched on word
    // boundaries and these legitimate claims keep verifying.
    it.each(['undefx = undefx', 'my_undef = my_undef'])(
      'does not refuse identifiers containing the letters: %s',
      async (claim) => {
        const text = getText(await verifyHandler({ claim }));
        expect(text).toContain('Verified: TRUE');
      }
    );
  });

  describe('Comparison-operator claims', () => {
    it('a bracketed identity still finds its main equals', async () => {
    // trackDepth's paren/bracket bookkeeping: swapping the counters makes
    // any '[' before the '=' swallow the depth and the claim degrades to
    // UNKNOWN (evaluated:false) with the suite green. Whether [1,2]=[1,2]
    // VERIFIES is a different question (simplify answers [0,0], not 0) —
    // the pin is that the claim parses and gets checked at all.
    const res = await verifyHandler({ claim: '[1,2] = [1,2]', format: 'json' });
    const parsed = JSON.parse(getText(res));
    expect(parsed.evaluated).toBe(true);
  });

  it('a bare == comparison has no main equals: 5 == 5 stays UNKNOWN', async () => {
      // The == skip must consume BOTH characters: a single-char version
      // leaves the second '=' as the main equals, and a true comparison
      // reports as refuted. This regression shipped once and was caught
      // only by review — the row exists so the suite catches it next time.
      const res = await verifyHandler({ claim: '5 == 5', format: 'json' });
      const parsed = JSON.parse(getText(res));
      expect(parsed.evaluated).toBe(false);
    });

    it('numeric tolerance sits below the wrong-claim band: x/3 = 0.3333*x stays FALSE', async () => {
      // The sampled check's residual is ~3.3e-5*|x| — above the 1e-6
      // tolerance, far below 1e-2. Loosening the threshold certifies this
      // false claim as an identity.
      const t = getText(await verifyHandler({ claim: 'x/3 = 0.3333*x', method: 'numeric' }));
      expect(t).toContain('Verified: FALSE');
    });
  });
});
