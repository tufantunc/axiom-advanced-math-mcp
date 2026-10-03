import { describe, it, expect, beforeAll, vi } from 'vitest';
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
      'method=%s alone cannot certify the collapse: x^(-1) sin(x) = x^(-1) cos(x)',
      async (method) => {
        // The refusal happens before either strategy runs. These rows pin
        // that neither strategy is left as an unguarded way in — a guard
        // that only covered the symbolic path would pass method=symbolic and
        // redden the numeric row (verified by mutation).
        const res = await verifyHandler({
          claim: 'x^(-1) sin(x) = x^(-1) cos(x)',
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
        claim: 'x=2 satisfies x^(-1) sin(x) = x^(-1) sin(x)',
        format: 'json',
      });
      const parsed = JSON.parse(getText(res));
      expect(parsed.verified).toBe(false);
      expect(parsed.evaluated).toBe(false);
    });

    it('stays UNKNOWN when the asserted value itself reads undefined', async () => {
      const res = await verifyHandler({
        claim: 'x = x^(-1) sin(x) satisfies x - x = 0',
        format: 'json',
      });
      const parsed = JSON.parse(getText(res));
      expect(parsed.verified).toBe(false);
      expect(parsed.evaluated).toBe(false);
    });

    // On main this reported FALSE (evaluated: true) — a refutation of
    // notation that was never read. The mixed one-defined-side case is the
    // verdict flip most visible to existing callers; pin it so the guard
    // cannot regress from `||` to `&&` with the suite green. The
    // checks_performed assertion names the REFUSAL POINT, not just the
    // outcome: under the `&&` regression the outcome assertion is not
    // GUARANTEED to redden (the numeric strategy's sampled differences on
    // an undefined side sometimes fabricate numbers, sometimes skip —
    // environment-dependent); the guard's signature reddens by construction.
    it('stays UNKNOWN, not FALSE, when exactly one side reads undefined', async () => {
      const res = await verifyHandler({
        claim: 'x^(-1) sin(x) = sin(x)^2 + cos(x)^2',
        format: 'json',
      });
      const parsed = JSON.parse(getText(res));
      expect(parsed.verified).toBe(false);
      expect(parsed.evaluated).toBe(false);
      expect(parsed.checks_performed).toContain('undefined_reading');
    });

    it('stays UNKNOWN when a side reading never comes back from the engine', async () => {
      // A transient engine failure while reading a side (worker crash, IPC
      // loss, timeout) must not silently disable the reading guard: the
      // numeric strategy would then substitute through the unread side and
      // can fabricate a refutation. One rejected reading, everything else
      // real.
      const spy = vi
        .spyOn(giacEngine, 'evaluate')
        .mockRejectedValueOnce(new Error('worker crashed mid-read'));
      try {
        const res = await verifyHandler({
          claim: 'x^(-1) sin(x) = sin(x)^2 + cos(x)^2',
          format: 'json',
        });
        const parsed = JSON.parse(getText(res));
        expect(parsed.verified).toBe(false);
        expect(parsed.evaluated).toBe(false);
        expect(parsed.checks_performed).toContain('unreadable_side');
      } finally {
        spy.mockRestore();
      }
    });

    it('stays UNKNOWN when a side reading comes back empty', async () => {
      // The sibling of the rejected reading: the worker resolved but sent
      // nothing. Unreachable with a healthy engine (the worker always sends
      // a string or rejects), so the empty answer is injected here — the
      // branch would otherwise be dead weight a regression could delete
      // with the suite green.
      const spy = vi.spyOn(giacEngine, 'evaluate').mockResolvedValueOnce('');
      try {
        const res = await verifyHandler({
          claim: 'x^(-1) sin(x) = sin(x)^2 + cos(x)^2',
          format: 'json',
        });
        const parsed = JSON.parse(getText(res));
        expect(parsed.verified).toBe(false);
        expect(parsed.evaluated).toBe(false);
        expect(parsed.checks_performed).toContain('unreadable_side');
      } finally {
        spy.mockRestore();
      }
    });

    // Characterization, deliberate trade-off (found by review): a side too
    // large to evaluate standalone throws in the reading (WASM memory trap),
    // and the refusal flips verdicts the old code produced — TRUE here (Giac
    // cancels A - A structurally without evaluating it) and FALSE for the +1
    // variant. We knowingly give those up: the same old path reported
    // `2^100000 = 2^100000` as NOT verified with high confidence (numeric
    // parseFloat of the huge side poisoned the combination), and UNKNOWN is
    // this product's preferred failure over a might-be-wrong verdict.
    it.each([
      '10000!*x = 10000!*x',
      '10000!*x = 10000!*x + 1',
      '2^100000 = 2^100000',
    ])('knowingly refuses the huge-side claim: %s', async (claim) => {
      const res = await verifyHandler({ claim, format: 'json' });
      const parsed = JSON.parse(getText(res));
      expect(parsed.verified).toBe(false);
      expect(parsed.evaluated).toBe(false);
      expect(parsed.checks_performed).toContain('unreadable_side');
    });

    it('a chained equation is refused with zero engine calls', async () => {
      // The contract this pins: a chained equation never reaches the engine
      // at all — refusal happens at parse shape, before any reading. The
      // two-part claim only proves the engine is reachable (anti-vacuous
      // guard against 0 === 0).
      const countEvaluates = async (claim: string): Promise<number> => {
        const spy = vi.spyOn(giacEngine, 'evaluate');
        try {
          await verifyHandler({ claim, format: 'json' });
        } finally {
          const n = spy.mock.calls.length;
          spy.mockRestore();
          return n;
        }
      };
      const few = await countEvaluates('x=1 satisfies 1=1');
      const many = await countEvaluates('x=1 satisfies ' + '1='.repeat(40) + '1');
      expect(few).toBeGreaterThan(0);
      expect(many).toBe(0);
    });
  });

  describe('Chained and comparison-shaped equations', () => {
    // A chain `a=b=c` is ambiguous notation, not an equation: the
    // substitution check reads only the first two `=`-separated parts and
    // certified claims whose remaining notation it never looked at
    // (measured: `x^2-4=0=(f^(+))(x)` verified TRUE with an unreadable
    // tail). Refused before any engine call. A `==` glued to the equation's
    // own `=` is the same hole one operator wide: the naive split still
    // breaks at every `=` character, so the comparison tail is never read
    // (found by review — `x^2-4=0==(f^(+))(x)` verified TRUE/high).
    it.each([
      'x=1 satisfies 1=1=1',
      'x=1 satisfies 1=1=1=1=garbage_tail',
      'x=2 satisfies x^2-4=0=garbage_tail',
      'x=2 satisfies x^2-4=0==garbage_tail',
      'x=1 satisfies 1=1==tail',
      'n=2 satisfies n^2=4 == (n mod 2 == 0)',
      // `!=` is the same hole one operator over (found by re-review): the
      // naive split breaks inside it, the tail goes unread, and the mangled
      // rhs `4!` is a FACTORIAL — `24=4!=tail` certified TRUE, and the true
      // compound claim `x^2-4=0, x != 5` was refuted with exit 2.
      'x=2 satisfies 24=4!=garbage_tail',
      'x=2 satisfies x^2-4=0, x != 5',
      'x=2 satisfies x^2=4!=0',
      // Bang-only is the same factorial mangle with no equation '=' to mix
      // with: `x != 2` splits to lhs `x !` — a FACTORIAL — so the false
      // claim "2 ≠ 2" certified TRUE (2!−2=0) and the true "1 ≠ 2" was
      // refuted (1!−2=−1). Unicode ≥/≤ are Giac-live operators the
      // canonicaliser did not map, so compound clauses evaluated COMPLETE
      // and the verdict inverted against them (found by adversarial
      // re-review; the ASCII twins already refused).
      'x=2 satisfies x != 2',
      'x=1 satisfies 1 != 2',
      // A space inside the comparison defeats a single-character lookback:
      // Giac reads `x !` as a factorial just as happily, so `x ! = 2`
      // certified the false "2 ≠ 2" TRUE — the spaced twin of the row
      // above it.
      'x=2 satisfies x ! = 2',
      'x=1 satisfies 1 ! = 2',
      'x=1 satisfies x^2-1=0, 2 ≥ x',
      'x=1 satisfies x^2-1=0, 0 ≥ x',
    ])('stays UNKNOWN for the chained or comparison-mixed equation: %s', async (claim) => {
      const res = await verifyHandler({ claim, format: 'json' });
      const parsed = JSON.parse(getText(res));
      expect(parsed.verified).toBe(false);
      expect(parsed.evaluated).toBe(false);
      expect(parsed.checks_performed).toContain('equation_shape');
    });

    // Identity-path sibling (pre-existing, found by review): `1=1=2` parses
    // as lhs='1', rhs='1=2', and the numeric arm once certified it TRUE —
    // parseFloat stops at '=' so '1.0=2.0' parsed as 1. Refused the same
    // way: a side that still carries a top-level '=' is chain residue.
    it.each(['1=1=2', '1=1=1', 'x+y=2, x-y=0', '2=3==4', '1 <= 2 = 1'])(
      'stays UNKNOWN for the chained identity-shaped claim: %s',
      async (claim) => {
        const res = await verifyHandler({ claim, format: 'json' });
        const parsed = JSON.parse(getText(res));
        expect(parsed.verified).toBe(false);
        expect(parsed.evaluated).toBe(false);
        expect(parsed.checks_performed).toContain('equation_shape');
      }
    );

    // The solution regex carves the value as ([^,\s]+) — permissive enough
    // to carry '=' itself. `x=2=99 satisfies x^2=4` substituted
    // `x=2=99`, Giac answered the equation object `0=9797`, and
    // parseFloat stopped at '=' → 0 → verified TRUE (adversarial
    // re-review). The value now faces the same shape policy.
    it.each(['x=2=99 satisfies x^2=4', 'x=2!=3 satisfies x^2-4=0', 'x=(0=5)+1 satisfies x-1=0'])(
      'stays UNKNOWN when the asserted value itself chains: %s',
      async (claim) => {
        const res = await verifyHandler({ claim, format: 'json' });
        const parsed = JSON.parse(getText(res));
        expect(parsed.verified).toBe(false);
        expect(parsed.evaluated).toBe(false);
        expect(parsed.checks_performed).toContain('equation_shape');
      }
    );

    // A fullwidth ＝ (CJK IMEs) used to sail through as an identifier —
    // no ASCII '=' anywhere, so the claim routed into the expression=0
    // path and the TRUE claim `x^2-4＝0` at x=2 was REFUTED. Canonicalised
    // to '=' like every other operator glyph, it verifies like its ASCII
    // twin.
    it('a fullwidth equals canonicalises and verifies: x^2-4＝0 at x=2', async () => {
      const res = await verifyHandler({ claim: 'x=2 satisfies x^2-4＝0', format: 'json' });
      const parsed = JSON.parse(getText(res));
      expect(parsed.verified).toBe(true);
      expect(parsed.evaluated).toBe(true);
    });

    // The spaced-comparison twin on the identity seam: no main equals once
    // the lookback skips whitespace, so the claim degrades to parse-UNKNOWN
    // instead of ruling on `2 !` (a factorial).
    it('a spaced ! = comparison has no main equals: 2 ! = 2 stays UNKNOWN', async () => {
      const res = await verifyHandler({ claim: '2 ! = 2', format: 'json' });
      const parsed = JSON.parse(getText(res));
      expect(parsed.verified).toBe(false);
      expect(parsed.evaluated).toBe(false);
    });

    // The at-pattern's two structural `=` end up inside subst(...) parens
    // after parsing — the shape refusal must not touch this claim form.
    it('a point-evaluation claim with its two structural equals still verifies', async () => {
      const res = await verifyHandler({ claim: 'x^2 at x=2 = 4', format: 'json' });
      const parsed = JSON.parse(getText(res));
      expect(parsed.verified).toBe(true);
      expect(parsed.evaluated).toBe(true);
    });

    // A comparison operator is not an equation separator, alone or mixed:
    // the naive split breaks inside every one of them (x ! re-reads as a
    // FACTORIAL, a dangling < or > reads undef, ≥ evaluates whole and inverts
    // the verdict). Comparison-only and comparison-mixed shapes are refused
    // alike — the equation_shape invariant is uniform: exactly one top-level
    // `=`, nothing else.
    it.each([
      'x=1 satisfies y == y',
      'x=1 satisfies x^2-4=0, x >= 0',
    ])('stays UNKNOWN for the comparison-bearing equation: %s', async (claim) => {
      const res = await verifyHandler({ claim, format: 'json' });
      const parsed = JSON.parse(getText(res));
      expect(parsed.verified).toBe(false);
      expect(parsed.evaluated).toBe(false);
      expect(parsed.checks_performed).toContain('equation_shape');
    });

    // An `=` nested inside the equation's own sides cannot be split apart
    // by the solution check: the naive split used to break INSIDE it and
    // rule on the mangled remainder — `abs(x=1) = 1` verified TRUE on the
    // reading `abs(x) - 1` (re-review measurement), and ifte forms errored
    // into UNKNOWN. Refused now; the identity path evaluates piecewise
    // sides whole and handles them correctly, so the message points there.
    it.each([
      'x=1 satisfies abs(x=1) = 1',
      'x=2 satisfies ifte(x=2,1,0) = 1',
      // Nested-only: findMainEquals answers -1, the first `=` CHARACTER is
      // inside the parens, and the split mangled it — `x=1 satisfies
      // (x=1)+(x=1)` was refuted on the reading `(x) - (1)+(x=1)`.
      'x=1 satisfies (x=1)+(x=1)',
    ])('stays UNKNOWN when the equals nests inside a side: %s', async (claim) => {
      const res = await verifyHandler({ claim, format: 'json' });
      const parsed = JSON.parse(getText(res));
      expect(parsed.verified).toBe(false);
      expect(parsed.evaluated).toBe(false);
      expect(parsed.checks_performed).toContain('equation_shape');
    });
  });

  describe('Undefined-marker edge forms (text mode, whole-result, identifiers)', () => {
    it('says UNKNOWN, not FALSE, in text mode for an undefined-collapse claim', async () => {
      const text = getText(await verifyHandler({ claim: 'x^(-1) sin(x) = x^(-1) cos(x)' }));
      expect(text).toContain('Verified: UNKNOWN');
      expect(text).not.toContain('FALSE');
    });

    // Division-by-zero identities were already refused before this guard
    // existed, at a different layer: `1/0`'s sides read `infinity` and the
    // refusal comes from the strategies (the difference simplifies to whole
    // `undef`, numeric samples are NaN), while `x^(-1)y`'s sides read bare
    // `undef` and now refuse at the reading guard. Both must stay UNKNOWN.
    it.each(['1/0 = 1/0', 'x^(-1)y = x^(-1)z'])('keeps refusing undefined sides: %s', async (claim) => {
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

  describe('How the strategies combine into one verdict', () => {
    // A numeric run that produced no usable number is missing evidence, not
    // a counterexample. `2^1100 = 2^1100` once reported NOT verified with
    // HIGH confidence while its own checks list carried the symbolic proof
    // (simplify(LHS - RHS) = 0): parseFloat overflows both sides to Infinity,
    // the direct difference is NaN, and the combination rule counted that
    // "could not evaluate" as a refutation.
    it.each(['2^1100 = 2^1100', '10^400 = 10^400'])(
      'a symbolic proof stands when numeric merely has no number: %s',
      async (claim) => {
        const res = await verifyHandler({ claim, format: 'json' });
        const parsed = JSON.parse(getText(res));
        expect(parsed.verified).toBe(true);
        expect(parsed.evaluated).toBe(true);
        expect(parsed.confidence).toBe('high');
      }
    );

    it('a huge identity still verifies with method=symbolic alone', async () => {
      const res = await verifyHandler({ claim: '2^1100 = 2^1100', method: 'symbolic', format: 'json' });
      const parsed = JSON.parse(getText(res));
      expect(parsed.verified).toBe(true);
      expect(parsed.evaluated).toBe(true);
      expect(parsed.confidence).toBe('high');
    });

    // A real counterexample disputes the proof: ln(x^2) = 2*ln(x) simplifies
    // to 0 symbolically, but the numeric arm samples x=-1, where ln(-1) is
    // complex and the parsed difference is -6.28… — the identity genuinely
    // fails off the positive reals. Not verified, checked, LOW confidence:
    // proof and counterexample in one run is a conflict, not certainty.
    it('a numeric counterexample disputes the symbolic proof: ln(x^2) = 2*ln(x)', async () => {
      const res = await verifyHandler({ claim: 'ln(x^2) = 2*ln(x)', format: 'json' });
      const parsed = JSON.parse(getText(res));
      expect(parsed.verified).toBe(false);
      expect(parsed.evaluated).toBe(true);
      expect(parsed.confidence).toBe('low');
      // Pin which arm carried which evidence: the same verdict triple is
      // producible by a plain symbolic refutation, but this cell is proof +
      // counterexample, and the explanation must say so rather than print
      // "≠" next to a proof line.
      const detail = parsed.checks_performed.join('\n');
      expect(detail).toContain('simplify(LHS - RHS) = 0 ✓');
      expect(detail).toMatch(/At x=-1: diff = -6\.28/);
      expect(parsed.explanation).toContain('in conflict');
    });

    // The same principle, symmetric arm: a symbolic run that died without an
    // answer (timeout, worker crash) is missing evidence, not a refutation.
    // Injected here by rejecting the simplify round trip; the numeric arm
    // runs for real and settles 2+3 = 5.
    it('a symbolic run that never answered does not refute what numeric settles', async () => {
      const real = giacEngine.evaluate.bind(giacEngine);
      const spy = vi.spyOn(giacEngine, 'evaluate').mockImplementation(async (expr: string) => {
        if (expr.startsWith('simplify(')) throw new Error('Giac evaluation timed out');
        return real(expr);
      });
      try {
        const res = await verifyHandler({ claim: '2+3 = 5', format: 'json' });
        const parsed = JSON.parse(getText(res));
        expect(parsed.verified).toBe(true);
        expect(parsed.evaluated).toBe(true);
        expect(parsed.confidence).toBe('medium');
      } finally {
        spy.mockRestore();
      }
    });

    // And the other side of the symmetry: a symbolic run that genuinely
    // compared and found a nonzero difference refutes the claim even when
    // the numeric arm's sampled points all agree. Injected by answering the
    // simplify round trip with a fabricated nonzero difference.
    it('a genuine symbolic refutation stands even when numeric samples agree', async () => {
      const real = giacEngine.evaluate.bind(giacEngine);
      const spy = vi.spyOn(giacEngine, 'evaluate').mockImplementation(async (expr: string) => {
        if (expr.startsWith('simplify(')) return '1';
        return real(expr);
      });
      try {
        const res = await verifyHandler({ claim: '2+3 = 5', format: 'json' });
        const parsed = JSON.parse(getText(res));
        expect(parsed.verified).toBe(false);
        expect(parsed.evaluated).toBe(true);
        expect(parsed.confidence).toBe('low');
      } finally {
        spy.mockRestore();
      }
    });

    it('numeric-only on a no-number claim stays UNKNOWN', async () => {
      const res = await verifyHandler({ claim: '2^1100 = 2^1100', method: 'numeric', format: 'json' });
      const parsed = JSON.parse(getText(res));
      expect(parsed.verified).toBe(false);
      expect(parsed.evaluated).toBe(false);
      expect(parsed.confidence).toBe('low');
    });

    // The refutation direction is untouched: a real symbolic difference is
    // still a refutation even when numeric has no number either.
    it('a huge non-identity is still refuted when numeric has no number', async () => {
      const res = await verifyHandler({ claim: '2^1100 = 2^1100 + 1', format: 'json' });
      const parsed = JSON.parse(getText(res));
      expect(parsed.verified).toBe(false);
      expect(parsed.evaluated).toBe(true);
      expect(parsed.confidence).toBe('low');
    });

    // Within double range both arms agree and nothing changes.
    it('a huge-but-representable identity still verifies through both arms', async () => {
      const res = await verifyHandler({ claim: '2^1000 = 2^1000', format: 'json' });
      const parsed = JSON.parse(getText(res));
      expect(parsed.verified).toBe(true);
      expect(parsed.confidence).toBe('high');
    });
  });

  describe('Caret exponents with no operand', () => {
    // Giac does not error on an operator-only exponent — it guesses, and
    // every guess is wrong somewhere. Measured: `x^(==)` reads as `x` (the
    // exponent silently dropped), `x^(!=)` as `1`, `2^(==)+1` as `3`,
    // `x^(==)*y` as `x*y`; `x^(+)`, `x^()`, `x^-` collapse toward undef.
    // No answer that comes back can be trusted, so the claim is refused
    // before parsing — this is the ASCII sibling of the superscript
    // refusal, and `x^(==) = x` used to verify TRUE with high confidence.
    it.each([
      'x^(==) = x',
      'x^(!=) = 1',
      '2^(==)+1 = 3',
      'x^(+) = x',
      'x^() = x^()',
      'x=2 satisfies x^(==) = x',
      // One space before the exponent is the same soup to Giac — it reads
      // `x^ (==)` exactly like `x^(==)` (found by review: the spaced form
      // verified TRUE/high after the unspaced one was refused). A spaced
      // MINUS over a number is the inverse case: `x^- 1` is a real exponent
      // (Giac answers 1/x) and must not be refused.
      'x^ (==) = x',
      'x ^ (==) = x',
      '2 ^ (==)+1 = 3',
      // A C-style comment blinds the scan the same way: Giac discards
      // /*…*/ wholesale, so the operand characters inside one are not real
      // and the effective exponent is still soup (found by verification —
      // `x^ /*c*/ (==) = x` verified TRUE/high).
      'x^ /*c*/ (==) = x',
      'x^(/*c*/ ==) = x',
      '2^ /*c*/ (==)+1 = 3',
    ])('stays UNKNOWN for the operand-free exponent: %s', async (claim) => {
      const res = await verifyHandler({ claim, format: 'json' });
      const parsed = JSON.parse(getText(res));
      expect(parsed.verified).toBe(false);
      expect(parsed.evaluated).toBe(false);
      expect(parsed.checks_performed).toContain('exponent_reading');
    });

    it('method=numeric alone cannot certify it either: x^(==) = x', async () => {
      const res = await verifyHandler({ claim: 'x^(==) = x', method: 'numeric', format: 'json' });
      const parsed = JSON.parse(getText(res));
      expect(parsed.verified).toBe(false);
      expect(parsed.evaluated).toBe(false);
      expect(parsed.checks_performed).toContain('exponent_reading');
    });

    // Real exponents — operators AROUND an operand are fine; only an
    // exponent that is nothing BUT operators is refused. The spaced minus
    // over a number is a real exponent (Giac answers 1/x for `x^- 1`); it
    // was being refused before the scan learned to look past whitespace.
    it.each([
      'x^(-1) = 1/x',
      'e^(x) = exp(x)',
      'x^(n+1) = x^(n+1)',
      '2^10 = 1024',
      'x^(-x) = x^(-x)',
      'x^- 1 = 1/x',
      'x ^ - 1 = 1/x',
    ])('still verifies the legitimate exponent: %s', async (claim) => {
      const text = getText(await verifyHandler({ claim }));
      expect(text).toContain('Verified: TRUE');
    });
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
