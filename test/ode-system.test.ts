import { describe, it, expect } from 'vitest';
import { parseOdeSystem } from '../src/server/tools/ode-system-shape.js';
import { translateOdeSystem } from '../src/server/tools/ode-system.js';

/**
 * Unit tests for the ODE-system rewrite.
 *
 * These live here rather than in handler-seam.test.ts because that file's job is
 * one representative row per advertised capability, and this module has ~20
 * branches. Several of them — a CAS error, a malformed reply, a probe that
 * throws — can only be reached with a stub engine, which is exactly what
 * `translateOdeSystem`'s injected `GiacEngineLike` parameter is for.
 */
/**
 * A stub engine. `reply` answers the coefficient probe; the separate degree
 * question a non-homogeneous system asks is answered with `degree` (default 0),
 * so a test that sets a forcing term does not have to care about it.
 */
const stub = (reply: string | Error, degree = '[0,0]') => ({
  evaluate: (expr: string): Promise<string> => {
    if (expr.startsWith('[max(')) return Promise.resolve(degree);
    // The domain classifier: `exact` echoes its argument, so nothing reads as a
    // float unless a test says otherwise.
    if (expr.startsWith('size(lvar(')) return Promise.resolve('0');
    if (expr.startsWith('exact(')) return Promise.resolve(expr.slice(6, -1));
    // The conditions scan makes TWO calls — `exact([...])` and the bare list —
    // and only the first was answered. The bare one fell through to the
    // coefficient reply below, so the two never matched and every conditioned
    // system built on this stub read as holding a float. Nothing failed only
    // because the conditioned tests here are homogeneous; the next one written
    // would have asserted a float refusal for a system with no float in it.
    if (/^\[[A-Za-z_]\w*\(/.test(expr)) return Promise.resolve(expr);
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  },
});

describe('parseOdeSystem', () => {
  it.each([
    ["[y'=z, z'=-y]", ['y', 'z']],
    ['[dy/dx=z, dz/dx=-y]', ['y', 'z']],
    ['[diff(y(x),x)=z, diff(z(x),x)=-y]', ['y', 'z']],
    ["([y'=z, z'=-y])", ['y', 'z']],
    ["[z'=-y, y'=z]", ['z', 'y']],
  ])('reads %s as a system over %j', (equation, functions) => {
    expect(parseOdeSystem(equation)?.equations.map((e) => e.fn)).toEqual(functions);
  });

  it.each([
    // A bracketed list is also the initial-condition form. Only a derivative NOT
    // applied to a point is an equation.
    ["y'=2*x"],
    ["[y'=2*x, y(0)=1]"],
    ["[y''=-y, y(0)=1, y'(0)=0]"],
    ['[diff(y(x),x,2)=-y, y(0)=1, diff(y(x),x)(0)=0]'],
  ])('does not read %s as a system', (equation) => {
    expect(parseOdeSystem(equation)).toBeNull();
  });

  it('records the derivative order', () => {
    expect(parseOdeSystem("[y''=z, z'=-y]")?.equations.map((e) => e.order)).toEqual([2, 1]);
    expect(
      parseOdeSystem('[diff(y(x),x,2)=z, diff(z(x),x)=-y]')?.equations.map((e) => e.order)
    ).toEqual([2, 1]);
  });

  it('separates conditions from equations', () => {
    const system = parseOdeSystem("[y'=z, z'=-y, y(0)=1, z(0)=0]");
    expect(system?.equations).toHaveLength(2);
    expect(system?.conditions).toEqual(['y(0)=1', 'z(0)=0']);
  });
});

describe('translateOdeSystem refusals', () => {
  const system = (equation: string) => {
    const parsed = parseOdeSystem(equation);
    if (!parsed) throw new Error(`not a system: ${equation}`);
    return parsed;
  };
  const err = async (equation: string, variable = 'x', reply = '[[[0,1],[-1,0]],[0,0],[0,0]]') => {
    const out = await translateOdeSystem(system(equation), variable, stub(reply));
    return 'error' in out ? out.error : `UNEXPECTED SUCCESS: ${out.command}`;
  };

  it('refuses the same function differentiated twice', async () => {
    await expect(err("[y'=z, y'=-y]")).resolves.toMatch(/same function twice/);
  });

  it('refuses a derivative of order above one', async () => {
    await expect(err("[y''=z, z'=-y]")).resolves.toMatch(/differentiates y 2 times/);
  });

  it('refuses a variable that is also an unknown', async () => {
    await expect(err("[y'=z, z'=-y]", 'z')).resolves.toMatch(/both the independent variable/);
  });

  it.each([['x)'], [''], ['1x']])('refuses %j as a variable name', async (variable) => {
    // It reaches two RegExp constructors; `x)` produced "Invalid regular
    // expression: Unmatched ')'" as the user-facing message.
    await expect(err("[y'=z, z'=-y]", variable)).resolves.toMatch(/independent variable/);
  });

  // Both directions of the cap. The accept side is the one that reaches the
  // WASM engine the bound exists to protect, and it is also what caught the cap
  // being unreachable: at 10 this case was refused for exceeding the CHARACTER
  // limit, so the count message could never be produced by any input.
  const ring = (n: number) =>
    `[${Array.from({ length: n }, (_, i) => `v${i}'=v${(i + 1) % n}`).join(',')}]`;
  const zeros = (n: number) =>
    `[${JSON.stringify(Array.from({ length: n }, () => Array(n).fill(0)))},` +
    `${JSON.stringify(Array(n).fill(0))},${JSON.stringify(Array(n).fill(0))}]`;

  it('refuses ten equations for the count, not for the probe length', async () => {
    const message = await err(ring(10));
    expect(message).toMatch(/at most 9/);
    expect(message).not.toMatch(/character/);
  });

  it('accepts nine', async () => {
    // Pin the command, not merely that one exists: a rewrite that emitted a
    // wrong-dimension matrix or dropped a component would still have a command.
    const out = await translateOdeSystem(system(ring(9)), 'x', stub(zeros(9)));
    expect(out).toMatchObject({
      command: `desolve(Y'=${JSON.stringify(Array.from({ length: 9 }, () => Array(9).fill(0)))}*Y,x,Y)`,
      functions: Array.from({ length: 9 }, (_, i) => `v${i}`),
    });
  });

  it('refuses a function applied to another argument', async () => {
    await expect(err("[y'=z(t), z'=-y]")).resolves.toMatch(/applies z to an argument other than x/);
  });

  it.each([
    ['GIAC_ERROR: bad'],
    // Two top-level commas, so the reply splits into exactly the three parts a
    // GOOD reply has. Without the GIAC_ERROR check this parses as a matrix, a
    // constant vector and a residual, the residual is not "0", and the caller
    // is told their system is not linear — a wrong diagnosis of a CAS failure.
    ['GIAC_ERROR: Unable to isolate c_0, in x, y'],
  ])('reports %s as unreadable, not as a nonlinear system', async (reply) => {
    const message = await err("[y'=z, z'=-y]", 'x', reply);
    expect(message).toMatch(/coefficients that could not be read/);
    expect(message).not.toMatch(/not linear/);
  });

  it('reports a malformed reply', async () => {
    await expect(err("[y'=z, z'=-y]", 'x', '[[[0,1],[-1,0]]]')).resolves.toMatch(
      /could not be read/
    );
  });

  it('reports a probe that throws instead of leaking the engine message', async () => {
    const out = await translateOdeSystem(
      system("[y'=z, z'=-y]"),
      'x',
      stub(new Error('RuntimeError: unreachable'))
    );
    expect('error' in out && out.error).toMatch(/could not be analysed/);
  });

  it('refuses a nonzero residual even when the gradient is constant', async () => {
    // floor/sign/frac differentiate to a constant, so the gradient scan alone
    // called them linear. The residual is the check that catches them.
    await expect(err("[y'=z, z'=-y]", 'x', '[[[0,1],[-1,0]],[0,0],[floor(z),0]]')).resolves.toMatch(
      /not linear in the unknown functions/
    );
  });

  it.each([
    // Giac prints a float zero as `0.0`; a textual comparison to '0' called
    // these systems nonlinear.
    ['[[[0,1],[-1,0]],[0.0,-0.0],[0.0,-0.0]]', 'accept'],
    // An empty entry must NOT count as zero, even though Number('') is 0.
    // Giac does not produce one, but the reply is not this module's to trust,
    // and treating it as zero would build a matrix out of a malformed answer
    // instead of refusing it.
    // A residue too large to be a rounding artifact still refuses: the tolerance
    // is bounded, not a blanket pass for anything numeric. A leftover this size
    // means the matrix/constant split itself disagreed.
    ['[[[0,1],[-1,0]],[0,0],[5,0]]', 'refuse'],
    ['[[[0,1],[-1,0]],[0,0],[0.001,0]]', 'refuse'],
    // The boundary itself, so the tolerance cannot drift up: at 1e-4 a residue
    // of 5e-5 — far too large to be an extended-precision cancellation, and
    // evidence the matrix/constant split disagreed — would be accepted.
    ['[[[0,1],[-1,0]],[0,0],[1e-9,0]]', 'refuse'],
    ['[[[0,1],[-1,0]],[0,0],[1e-10,0]]', 'accept'],
    // Exponent-notation zero: only the numeric half of isZero recognises this
    // one, so it is what distinguishes the two arms.
    ['[[[0,1],[-1,0]],[0,0],[0e-10,0]]', 'accept'],
    ['[[[0,1],[-1,0]],[0,0],[0E0,0]]', 'accept'],
    // ...but an extended-precision cancellation artifact does not.
    ['[[[0,1],[-1,0]],[0,0],[0.100000000000000e-14,0]]', 'accept'],
    ['[[[0,1],[-1,0]],[0,0],[,0]]', 'refuse'],
    ['[[[0,1],[-1,0]],[0,0],[ ,0]]', 'refuse'],
  ])('reads residual %s as %s', async (reply, verdict) => {
    const out = await translateOdeSystem(system("[y'=z, z'=-y]"), 'x', stub(reply));
    expect('command' in out).toBe(verdict === 'accept');
  });

  it.each([
    // Both failure modes of the degree probe. Without them a trapped probe
    // escapes as a rejection and the raw engine message reaches the caller,
    // and a malformed reply puts NaN into both `> MAX` comparisons — which are
    // false — so the system is accepted with no degree bound applied at all.
    ['rejects', undefined],
    ['answers nonsense', '[foo,bar]'],
  ])('refuses when the degree probe %s', async (_label, reply) => {
    const out = await translateOdeSystem(system("[y'=z, z'=-y+x^2]"), 'x', {
      evaluate: (expr: string): Promise<string> => {
        if (!expr.startsWith('[max(')) return Promise.resolve('[[[0,1],[-1,0]],[x^2,0],[0,0]]');
        return reply === undefined ? Promise.reject(new Error('trap')) : Promise.resolve(reply);
      },
    });
    expect('error' in out && out.error).toMatch(/degree in x could not be read/);
  });

  it.each([
    // The matrix normalisation must not make things worse when it fails: an
    // error reply must not become the matrix, and a trap must not escape.
    ['an error reply', 'GIAC_ERROR: bad'],
    ['a rejection', undefined],
  ])('keeps the exact matrix when evalf gives %s', async (_label, reply) => {
    const out = await translateOdeSystem(system("[y'=z, z'=-y]"), 'x', {
      evaluate: (expr: string): Promise<string> => {
        if (expr.startsWith('[max(')) return Promise.resolve('[0,0]');
        if (expr.startsWith('evalf('))
          return reply === undefined ? Promise.reject(new Error('trap')) : Promise.resolve(reply);
        return Promise.resolve('[[[0,1.5],[-1,pi]],[0,0],[0,0]]');
      },
    });
    expect('command' in out).toBe(true);
    if ('command' in out) {
      expect(out.command).toContain('pi');
      expect(out.command).not.toContain('GIAC_ERROR');
    }
  });

  it('keeps the textual verdict when the engine cannot settle the residual', async () => {
    // The numeric second opinion is asked only when the text says nonlinear, so
    // losing it must leave the refusal standing. Treating a failed round-trip as
    // "affine after all" would turn an engine outage into an accepted system.
    const out = await translateOdeSystem(system("[y'=z, z'=-y]"), 'x', {
      evaluate: (expr: string): Promise<string> =>
        expr.startsWith('evalf(')
          ? Promise.reject(new Error('trap'))
          : Promise.resolve('[[[0,1],[-1,0]],[0,0],[floor(z),0]]'),
    });
    expect('error' in out && out.error).toMatch(/not linear/);
  });

  it('refuses a gradient entry naming an unknown', async () => {
    await expect(err("[y'=z, z'=-y]", 'x', '[[[0,z],[-1,0]],[0,0],[0,0]]')).resolves.toMatch(
      /not linear/
    );
  });

  it('refuses a gradient entry naming the variable', async () => {
    await expect(err("[y'=z, z'=-y]", 'x', '[[[0,x],[-1,0]],[0,0],[0,0]]')).resolves.toMatch(
      /still mentions x after normalising/
    );
  });
});

describe('what is decided before the engine is asked', () => {
  const system = (equation: string) => {
    const parsed = parseOdeSystem(equation);
    if (!parsed) throw new Error(`not a system: ${equation}`);
    return parsed;
  };

  it.each([
    // Every one of these is decidable from the caller's text, and every one used
    // to cost five engine round trips first — on a shared, single-threaded
    // worker, for a request that was never going to be answered.
    ["[y'=z, z'=-y, y(0)=1, w(0)=2]", /names w in an initial condition/],
    ["[y'=z, z'=-y, y(0)=1]", /a value for every function, or none/],
    ["[y'=z, z'=-y, y(0)=1, z(1)=0]", /different points/],
    ["[y'=z, z'=-y, y(0)=1, y(0)=2, z(0)=0]", /two different initial conditions/],
    ["[y'=z, z'=-y, 7]", /not of the form y\(0\)=1/],
    ["[y'=z, z'=-y, y(0)=10^100000, z(0)=0]", /implausible magnitude/],
  ])('refuses %s without asking the engine at all', async (equation, expected) => {
    let calls = 0;
    const out = await translateOdeSystem(system(equation), 'x', {
      evaluate: (): Promise<string> => {
        calls += 1;
        return Promise.resolve('[[[0,1],[-1,0]],[0,0],[0,0]]');
      },
    });
    expect('error' in out && out.error).toMatch(expected);
    expect(calls).toBe(0);
  });

  it.each([
    // The engine's own text is not the caller's business: one names this
    // service's internal worker recycling, the other a probe expression the
    // caller never wrote.
    // The worker's lifecycle is not a verdict on the caller's mathematics: the
    // class is reported so an outage is distinguishable from a real refusal,
    // while the engine's own text still never reaches them.
    [new Error('Giac worker exited (code 1)'), /^could not be analysed: the CAS was unavailable/],
    [new Error('Bad Argument Value'), /^could not be analysed$/],
    // A per-call timeout is the caller's cost, not an outage — this input wedged
    // the shared worker for the whole budget. Classifying it as unavailable
    // inverted the fix's purpose and advised a retry that repeats the wedge.
    [new Error('Giac evaluation timed out'), /^could not be analysed in the time the CAS allows/],
    // ...and the state where every caller would otherwise be told their
    // mathematics is broken because the engine never came up.
    [new Error('Giac worker init failed: WASM init timeout'), /the CAS was unavailable/],
    [new Error('worker host disposed'), /the CAS was unavailable/],
    // The two most common outages there are, and both were deletable from the
    // classifier with the suite green: `Giac worker unavailable` is what every
    // call pending on a recycle receives.
    [new Error('Giac worker unavailable'), /the CAS was unavailable — retry/],
    [
      new Error('Giac worker recycled repeatedly; call abandoned'),
      /the CAS was unavailable — retry/,
    ],
    [
      'GIAC_ERROR: Bad Argument Value grad(z,[y,z]) at line 1 col 7',
      // ...and the function NAMES are the caller's own data — the one signal
      // identifying a name the CAS has reserved, which dropping the raw string
      // had removed entirely.
      /could not be read for y, z — one of those names may be reserved/,
    ],
  ])('refuses without quoting the engine (%s)', async (reply, expected) => {
    const out = await translateOdeSystem(system("[y'=z, z'=-y]"), 'x', {
      evaluate: (): Promise<string> =>
        reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply),
    });
    expect('error' in out && out.error).toMatch(expected);
  });

  it.each([
    // The bound at its value, both ways. A real initial condition is a number —
    // these are far past anything a caller writes, and the trapping shape is only
    // a factor of two above the cap, so the number matters rather than just the
    // direction.
    // `y(0)=` is five of the characters the bound counts, so these are the
    // 280th and 281st character of the condition itself.
    ['at the limit', 275, 'accept'],
    ['one over', 276, 'refuse'],
  ])('reads a condition %s as %s', async (_label, valueLength, verdict) => {
    let calls = 0;
    const value = 'x'.repeat(valueLength);
    const out = await translateOdeSystem(system(`[y'=z, z'=-y, y(0)=${value}, z(0)=0]`), 'x', {
      evaluate: (expr: string): Promise<string> => {
        calls += 1;
        if (expr.startsWith('[max(')) return Promise.resolve('[0,0,0]');
        if (expr.startsWith('size(lvar(')) return Promise.resolve('0');
        if (expr.startsWith('exact(')) return Promise.resolve(expr.slice(6, -1));
        return Promise.resolve('[[[0,1],[-1,0]],[0,0],[0,0]]');
      },
    });
    if (verdict === 'refuse') {
      expect('error' in out && out.error).toMatch(/281 characters, above the 280/);
      expect(calls).toBe(0);
    } else {
      // That it was ACCEPTED, not merely that something downstream ran. `calls > 0`
      // holds for a refusal further down too, so the row named "accept" was pinned
      // only against the bound being tightened, never against the value at the
      // limit becoming unusable for some other reason.
      expect('command' in out).toBe(true);
    }
  });

  it('refuses an over-long condition before it reaches the engine', async () => {
    // Nothing else measured this channel: MAX_PROBE_CHARS bounds the probe and
    // MAX_COMMAND_CHARS the finished command, both later. A flat 7,441-character
    // condition traps the engine, and at that size it exhausts the JS stack
    // rather than trapping in WASM — which left the worker UP and corrupted, so
    // three unrelated callers got raw engine text before it crashed itself out.
    let calls = 0;
    // The worst shape rather than the cheapest: a division chain traps at 606
    // characters where a flat product survives to 994, and a factorial chain
    // poisons the worker WITHOUT throwing, so nothing downstream would catch it.
    const long = `9${'/9'.repeat(400)}`;
    const out = await translateOdeSystem(system(`[y'=z, z'=-y, y(0)=${long}, z(0)=0]`), 'x', {
      evaluate: (): Promise<string> => {
        calls += 1;
        return Promise.resolve('[[[0,1],[-1,0]],[0,0],[0,0]]');
      },
    });
    expect('error' in out && out.error).toMatch(/\d+ characters, above the \d+/);
    expect(calls).toBe(0);
  });

  it('refuses a condition nested past what the CAS can parse', async () => {
    // Depth is a separate axis from length: nested 600 deep this was 2,415
    // characters — inside every length cap that existed — and killed the shared
    // worker. Sending one copy per call raised that threshold; it did not remove
    // it.
    let calls = 0;
    // Deep but SHORT — 203 characters, inside the length bound above, so this
    // exercises the depth axis rather than falling through to it.
    // Grouping parentheses, because they are the only shape dense enough to pass
    // 100 levels inside the 400-character bound above — two characters a level
    // against four for the cheapest call. They are also harmless to the engine
    // past 600, so this pins the GUARD rather than the hazard; the hazard is
    // function nesting, which is graceful at 100 and fatal at 400.
    const deep = `${'('.repeat(101)}1${')'.repeat(101)}`;
    const out = await translateOdeSystem(system(`[y'=z, z'=-y, y(0)=${deep}, z(0)=0]`), 'x', {
      evaluate: (): Promise<string> => {
        calls += 1;
        return Promise.resolve('[[[0,1],[-1,0]],[0,0],[0,0]]');
      },
    });
    expect('error' in out && out.error).toMatch(/nested \d+ deep, above the \d+ this tool accepts/);
    expect(calls).toBe(0);
  });

  it('sends the condition text once per call, not twice in one', async () => {
    // Doubling it into a single command turned a 7,528-character request — inside
    // the 8,192 input cap — into a ~15,000-character command, past the ~10,000
    // where Giac traps fatally and takes the shared worker with it.
    const sent: string[] = [];
    await translateOdeSystem(system("[y'=z, z'=-y, y(0)=1, z(0)=0]"), 'x', {
      evaluate: (expr: string): Promise<string> => {
        sent.push(expr);
        if (expr.startsWith('[max(')) return Promise.resolve('[0,0]');
        if (expr.startsWith('size(lvar(')) return Promise.resolve('0');
        if (expr.startsWith('exact(')) return Promise.resolve(expr.slice(6, -1));
        return Promise.resolve('[[[0,1],[-1,0]],[0,0],[0,0]]');
      },
    });
    // The TOTAL, not a per-expression ceiling. `copies < 2` is satisfied by zero,
    // so the assertion passed when the substring appeared nowhere — including on
    // the doubled command it exists to forbid, if the condition were spelt with a
    // space. Two occurrences across two calls is the shape being asserted: one
    // inside `exact(...)`, one bare.
    const total = sent.reduce((n, expr) => n + expr.split('y(0)=1').length - 1, 0);
    expect(total).toBe(2);
    expect(sent.every((expr) => expr.split('y(0)=1').length - 1 <= 1)).toBe(true);
  });
});

describe('translateOdeSystem numeric domain', () => {
  const system = (equation: string) => {
    const parsed = parseOdeSystem(equation);
    if (!parsed) throw new Error('not a system');
    return parsed;
  };
  /**
   * Counts the engine calls, so a skipped normalisation is observable.
   *
   * `atoms` is what `size(lvar(...))` reports, and `exact` is what `exact(...)`
   * gives back — returning something different from the argument is how a test
   * says "this holds a float".
   */
  const counting = (reply: string, atoms = '0', exact?: string) => {
    const seen: string[] = [];
    return {
      seen,
      evaluate: (expr: string): Promise<string> => {
        seen.push(expr);
        if (expr.startsWith('[max(')) return Promise.resolve('[0,0,0]');
        if (expr.startsWith('evalf(')) return Promise.resolve('[[0.0,1.0],[-1.5,0.69314718056]]');
        if (expr.startsWith('size(lvar(')) return Promise.resolve(atoms);
        if (expr.startsWith('exact(')) {
          const argument = expr.slice(6, -1);
          // Only the matrix is claimed to hold a float; the forcing vector
          // echoes, so these rows isolate the matrix side.
          return Promise.resolve(exact && argument.includes('[[') ? exact : argument);
        }
        return Promise.resolve(reply);
      },
    };
  };

  it('does not read a reprint that differs only in whitespace as a float', async () => {
    // Both sides of the comparison are the engine's own print, but they come from
    // two different calls, so a wrapped or spaced reply must not read as "this
    // changed". It would mean an unnecessary evalf, which costs precision.
    const seen: string[] = [];
    await translateOdeSystem(system("[y'=z, z'=-y]"), 'x', {
      evaluate: (expr: string): Promise<string> => {
        seen.push(expr);
        if (expr.startsWith('[max(')) return Promise.resolve('[0,0,0]');
        if (expr.startsWith('size(lvar(')) return Promise.resolve('1');
        // Same matrix, reprinted with newlines and spaces.
        if (expr.startsWith('exact('))
          return Promise.resolve(`\n${expr.slice(6, -1).replace(/,/g, ', ')}\n`);
        return Promise.resolve('[[[0,1],[-1,0]],[0,0],[0,0]]');
      },
    });
    expect(seen.some((e) => e.startsWith('evalf('))).toBe(false);
  });

  it.each([
    // An outage that lands in the CONDITIONS scan is still an outage. Only the
    // probe's catch classified at first, so a recycle caused by somebody else's
    // request read as a verdict on this caller's initial conditions.
    [new Error('Giac worker exited (code 1)'), /the CAS was unavailable/],
    [new Error('Giac evaluation timed out'), /in the time the CAS allows/],
    [new Error('Bad Argument Value'), /could not be applied$/],
  ])('classifies %s in the conditions scan too', async (thrown, expected) => {
    const out = await translateOdeSystem(system("[y'=z, z'=-y, y(0)=1, z(0)=0]"), 'x', {
      evaluate: (expr: string): Promise<string> => {
        if (expr.startsWith('exact([y')) return Promise.reject(thrown);
        if (expr.startsWith('[max(')) return Promise.resolve('[0,0,0]');
        if (expr.startsWith('size(lvar(')) return Promise.resolve('0');
        if (expr.startsWith('exact(')) return Promise.resolve(expr.slice(6, -1));
        return Promise.resolve('[[[0,1],[-1,0]],[0,0],[0,0]]');
      },
    });
    expect('error' in out && out.error).toMatch(expected);
  });

  it('refuses when the engine cannot examine the CONDITIONS for a decimal', async () => {
    // The sibling of the test below, and split out deliberately so one failure
    // cannot clear the other's flags — but only the matrix/forcing half was
    // pinned. Silently clearing this one turns off MAX_CONDITION_FLOAT_DEGREE.
    const out = await translateOdeSystem(system("[y'=z, z'=-y, y(0)=1, z(0)=0]"), 'x', {
      evaluate: (expr: string): Promise<string> => {
        // Two calls now, one copy of the condition text each — the single
        // doubled command it used to send could cross Giac's trap threshold.
        if (expr.startsWith('exact([y(0)')) return Promise.reject(new Error('trap'));
        if (expr.startsWith('[max(')) return Promise.resolve('[0,0]');
        if (expr.startsWith('size(lvar(')) return Promise.resolve('0');
        if (expr.startsWith('exact(')) return Promise.resolve(expr.slice(6, -1));
        return Promise.resolve('[[[0,1],[-1,0]],[0,0],[0,0]]');
      },
    });
    expect('error' in out && out.error).toMatch(/initial conditions that could not be examined/);
  });

  it('refuses when the engine cannot say whether a decimal is involved', async () => {
    // Not a shrug. These flags gate the accuracy bounds and the normalisation, so
    // clearing them lets the request continue with both guards silently off — and
    // the measured consequence is an answer this module has already established is
    // wrong. Not knowing whether the answer is safe to produce is not the same as
    // knowing that it is.
    const seen: string[] = [];
    const out = await translateOdeSystem(system("[y'=z, z'=-y]"), 'x', {
      evaluate: (expr: string): Promise<string> => {
        seen.push(expr);
        if (expr.startsWith('size(lvar(')) return Promise.reject(new Error('trap'));
        if (expr.startsWith('[max(')) return Promise.resolve('[0,0]');
        return Promise.resolve('[[[0,1],[-1/4*pi^2,pi]],[0,0],[0,0]]');
      },
    });
    expect('error' in out && out.error).toMatch(/could not be examined for decimal/);
    expect(seen.some((e) => e.startsWith('evalf('))).toBe(false);
  });

  it.each([
    // Both halves matter, and neither alone is the condition. A float beside an
    // exact constant is the harmful mix; a float with nothing to mix with has
    // nothing to normalise, and an exact matrix has no float to normalise to —
    // normalising one anyway broke repeated-root systems outright. Driven through
    // what the engine answers, so this pins the decision rather than a spelling.
    ['1', '[[0,1],[-1.5,X]]', true, 'a float beside an exact constant'],
    ['0', '[[0,1],[-1.5,0]]', false, 'floats only, nothing to mix with'],
    ['0', '', false, 'exact rationals only'],
    ['1', '', false, 'exact with names, no float'],
  ])('normalises when lvar=%s and exact gives %s: %s (%s)', async (atoms, exact, expected) => {
    const engine = counting('[[[0,1],[-1,0]],[0,0],[0,0]]', atoms, exact);
    await translateOdeSystem(system("[y'=z, z'=-y]"), 'x', engine);
    expect(engine.seen.some((e) => e.startsWith('evalf('))).toBe(expected);
  });
});

describe('translateOdeSystem initial conditions', () => {
  const system = (equation: string) => {
    const parsed = parseOdeSystem(equation);
    if (!parsed) throw new Error('not a system');
    return parsed;
  };
  const clean = '[[[0,1],[-1,0]],[0,0],[0,0]]';
  const build = async (equation: string) => {
    const out = await translateOdeSystem(system(equation), 'x', stub(clean));
    return 'command' in out ? out.command : `ERROR: ${out.error}`;
  };

  it('maps each value to its own function, in the equation order', async () => {
    // Asymmetric values, so a reversed mapping cannot pass. A swapped order was
    // invisible to an assertion that only looked for cos(x) in the answer.
    await expect(build("[y'=z, z'=-y, y(0)=2, z(0)=3]")).resolves.toContain('Y(0)=[2,3]');
    await expect(build("[z'=-y, y'=z, y(0)=2, z(0)=3]")).resolves.toContain('Y(0)=[3,2]');
  });

  it('keeps the point the caller gave', async () => {
    await expect(build("[y'=z, z'=-y, y(1)=2, z(1)=3]")).resolves.toContain('Y(1)=[2,3]');
  });

  it.each([
    ["[y'=z, z'=-y, y(0)=1]", /every function, or none/],
    ["[y'=z, z'=-y, y(0)=1, z(1)=0]", /different points/],
    ["[y'=z, z'=-y, w(0)=1, y(0)=1, z(0)=1]", /does not solve for/],
    ["[y'=z, z'=-y, 7]", /not of the form/],
  ])('refuses %s', async (equation, expected) => {
    await expect(build(equation)).resolves.toMatch(expected);
  });

  it.each([
    // The homogeneous check has no `negligible` fallback behind it, so isZero's
    // numeric arm is what recognises an exponent-notation zero here. Without it
    // the command carries a `+[0e-10,0]` the system never had.
    ['[[[0,1],[-1,0]],[0e-10,0],[0,0]]'],
    ['[[[0,1],[-1,0]],[0E0,0],[0,0]]'],
  ])('treats %s as homogeneous', async (reply) => {
    const out = await translateOdeSystem(system("[y'=z, z'=-y]"), 'x', stub(reply));
    expect('command' in out && out.command).toBe("desolve(Y'=[[0,1],[-1,0]]*Y,x,Y)");
  });

  it('omits a zero inhomogeneous term from the command', async () => {
    await expect(build("[y'=z, z'=-y]")).resolves.toBe("desolve(Y'=[[0,1],[-1,0]]*Y,x,Y)");
  });

  it('keeps a real one', async () => {
    const out = await translateOdeSystem(
      system("[y'=z, z'=-y]"),
      'x',
      stub('[[[0,1],[-1,0]],[1,0],[0,0]]')
    );
    expect('command' in out && out.command).toContain('+[1,0]');
  });

  it('picks a vector symbol that appears nowhere in the problem', async () => {
    const out = await translateOdeSystem(
      system("[Y'=Z, Z'=-Y]"),
      'x',
      stub('[[[0,1],[-1,0]],[0,0],[0,0]]')
    );
    expect('command' in out && out.command).toMatch(/^desolve\(Y_'=/);
  });

  it('escalates past a taken symbol more than once', async () => {
    const out = await translateOdeSystem(
      system("[Y'=Z+Y_, Z'=-Y]"),
      'x',
      stub('[[[0,1],[-1,0]],[Y_,0],[0,0]]')
    );
    expect('command' in out && out.command).toMatch(/Y__/);
  });
});
