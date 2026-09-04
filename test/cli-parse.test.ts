import { describe, it, expect } from 'vitest';
import { parseArgs, UsageError } from '../src/cli/parse.js';
import type { ComputeCommand, PlotCommand } from '../src/cli/parse.js';
import { resultText, renderCompute, renderVerify, renderPlotMeta } from '../src/cli/render.js';

describe('parseArgs — dispatch', () => {
  it('treats no arguments as the MCP server', () => {
    expect(parseArgs([])).toEqual({ kind: 'server' });
  });

  it('recognises --help and -h', () => {
    expect(parseArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseArgs(['-h'])).toEqual({ kind: 'help' });
  });

  it('recognises per-subcommand help', () => {
    expect(parseArgs(['compute', '--help'])).toEqual({ kind: 'help', topic: 'compute' });
  });

  it('recognises --version and -V', () => {
    expect(parseArgs(['--version'])).toEqual({ kind: 'version' });
    expect(parseArgs(['-V'])).toEqual({ kind: 'version' });
  });

  it('rejects an unknown subcommand', () => {
    expect(() => parseArgs(['frobnicate'])).toThrow(UsageError);
  });
});

describe('parseArgs — compute', () => {
  it('takes the expression positionally', () => {
    expect(parseArgs(['compute', '2+2'])).toEqual({
      kind: 'compute',
      expression: '2+2',
      output: 'text',
    });
  });

  it('leaves the expression undefined when omitted (stdin)', () => {
    expect(parseArgs(['compute'])).toEqual({ kind: 'compute', output: 'text' });
  });

  it('accepts domain and precision', () => {
    const c = parseArgs(['compute', 'x', '--domain', 'complex', '--precision', '20']);
    expect(c).toEqual({
      kind: 'compute',
      expression: 'x',
      domain: 'complex',
      precision: 20,
      output: 'text',
    });
  });

  it('maps the output flags', () => {
    expect((parseArgs(['compute', 'x', '--json']) as ComputeCommand).output).toBe('json');
    expect((parseArgs(['compute', 'x', '--latex']) as ComputeCommand).output).toBe('latex');
    expect((parseArgs(['compute', 'x', '-q']) as ComputeCommand).output).toBe('quiet');
  });

  it('rejects two output modes together', () => {
    expect(() => parseArgs(['compute', 'x', '--json', '-q'])).toThrow(/mutually exclusive/);
  });

  it('rejects an invalid domain', () => {
    expect(() => parseArgs(['compute', 'x', '--domain', 'imaginary'])).toThrow(UsageError);
  });

  // Every flag is scoped to one subcommand. Accepting a foreign flag would
  // silently drop it — the value is parsed, then never read by that command's
  // branch — so each guard is checked rather than trusting the one that has a
  // test. These are the nine that exist in parseArgs.
  it.each([
    [['compute', 'x', '--method', 'numeric'], /--method is only valid for verify/],
    [['compute', 'x', '-o', 'f.svg'], /-o is only valid for plot/],
    // --out's error names its primary spelling -o: the old switch's case
    // label was `-o`, and the compat table preserves that quirk.
    [['compute', 'x', '--out', 'f.svg'], /-o is only valid for plot/],
    [['compute', 'x', '--variable', 't'], /--variable is only valid for plot/],
    [['compute', 'x', '--x-min', '0'], /--x-min is only valid for plot/],
    [['verify', 'x=1', '--width', '100'], /--width is only valid for plot/],
    [['compute', 'x', '--title', 'hi'], /--title is only valid for plot/],
    [['verify', 'x=1', '--domain', 'real'], /--domain is only valid for compute/],
    [['verify', 'x=1', '--precision', '5'], /--precision is only valid for compute/],
    [['verify', 'x=1', '--latex'], /--latex is only valid for compute/],
    [['plot', 'x', '--method', 'numeric'], /--method is only valid for verify/],
  ])('rejects %j as out of scope for its subcommand', (argv, message) => {
    expect(() => parseArgs(argv as string[])).toThrow(message as RegExp);
  });

  it('rejects an unknown option', () => {
    expect(() => parseArgs(['compute', 'x', '--frobnicate'])).toThrow(/unknown option/);
  });

  // The refusal is the CLI's defence against unquoted expressions —
  // `compute x^2 + 1` arrives as three argv entries. The decomposition
  // copied the loop three times, so each parser's copy is pinned (dropping
  // the throw once made the CLI answer the LAST positional with exit 0).
  it.each([
    ['compute'],
    ['verify'],
    ['plot'],
  ])('rejects a second positional in %s', (kind) => {
    expect(() => parseArgs([kind, 'first', 'second'])).toThrow(
      /unexpected extra argument: second/
    );
  });

  // The sentinel is wired per parser now; compute's two cases above cover
  // only its copy. A leading-minus claim/expression after -- must stay
  // positional — and -q after -- is data, not a flag.
  it('verify takes a leading-minus claim after the sentinel', () => {
    const cmd = parseArgs(['verify', '--', '-x=1']) as { claim?: string };
    expect(cmd.claim).toBe('-x=1');
  });

  it('plot takes a flag-looking expression after the sentinel', () => {
    const cmd = parseArgs(['plot', '--', '-q']) as { expression?: string; output?: string };
    expect(cmd.expression).toBe('-q');
    expect(cmd.output).toBe('text');
  });

  it('takes a negative number as a value, not as the next flag', () => {
    // --x-min -5 must not be read as "--x-min has no value"; -q must.
    expect(parseArgs(['plot', 'x', '--x-min', '-5']).kind).toBe('plot');
    expect((parseArgs(['plot', 'x', '--x-min', '-5']) as { xMin?: number }).xMin).toBe(-5);
    expect(() => parseArgs(['plot', 'x', '--x-min', '-q'])).toThrow(/needs a value/);
    expect(() => parseArgs(['plot', 'x', '--x-min', '--json'])).toThrow(/needs a value/);
  });

  it('rejects precision outside 1..50', () => {
    expect(() => parseArgs(['compute', 'x', '--precision', '0'])).toThrow(UsageError);
    expect(() => parseArgs(['compute', 'x', '--precision', '51'])).toThrow(UsageError);
    expect(() => parseArgs(['compute', 'x', '--precision', 'abc'])).toThrow(UsageError);
  });

  it('rejects a flag with no value', () => {
    expect(() => parseArgs(['compute', 'x', '--precision'])).toThrow(UsageError);
  });

  it('rejects --latex on verify, which has no LaTeX form', () => {
    expect(() => parseArgs(['verify', 'x=x', '--latex'])).toThrow(UsageError);
  });

  it('-- treats a leading-minus expression as positional, not a flag', () => {
    expect(parseArgs(['compute', '--', '-2+2'])).toEqual({
      kind: 'compute',
      expression: '-2+2',
      output: 'text',
    });
  });

  it('-- makes --help a literal expression instead of a help request', () => {
    expect(parseArgs(['compute', '--', '--help'])).toEqual({
      kind: 'compute',
      expression: '--help',
      output: 'text',
    });
  });
});

describe('parseArgs — verify', () => {
  it('takes the claim positionally and accepts a method', () => {
    expect(parseArgs(['verify', 'x=x', '--method', 'symbolic'])).toEqual({
      kind: 'verify',
      claim: 'x=x',
      method: 'symbolic',
      output: 'text',
    });
  });

  it('rejects an invalid method', () => {
    expect(() => parseArgs(['verify', 'x=x', '--method', 'vibes'])).toThrow(UsageError);
  });
});

describe('parseArgs — plot', () => {
  it('accepts the range, size and output path', () => {
    const c = parseArgs([
      'plot',
      'sin(x)',
      '-o',
      'out.svg',
      '--variable',
      't',
      '--x-min',
      '-1',
      '--x-max',
      '1',
      '--width',
      '800',
      '--height',
      '600',
      '--title',
      'hi',
    ]);
    expect(c).toEqual({
      kind: 'plot',
      expression: 'sin(x)',
      out: 'out.svg',
      variable: 't',
      xMin: -1,
      xMax: 1,
      width: 800,
      height: 600,
      title: 'hi',
      output: 'text',
    });
  });

  it('requires -o when -q is used, since there is no path to print otherwise', () => {
    expect(() => parseArgs(['plot', 'sin(x)', '-q'])).toThrow(/requires -o/);
  });

  it('accepts -q together with -o', () => {
    expect((parseArgs(['plot', 'sin(x)', '-o', 'f.svg', '-q']) as PlotCommand).output).toBe(
      'quiet'
    );
  });

  it('rejects a non-numeric range value', () => {
    expect(() => parseArgs(['plot', 'sin(x)', '--x-min', 'left'])).toThrow(UsageError);
  });
});

describe('render', () => {
  const envelope = {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ success: true, display: '{-2, 2}', latex: '\\{-2,2\\}' }),
      },
    ],
    isError: false,
  };

  it('joins content blocks into text', () => {
    expect(
      resultText({
        content: [
          { type: 'text' as const, text: 'a' },
          { type: 'text' as const, text: 'b' },
        ],
        isError: false,
      })
    ).toBe('a\nb');
  });

  it('quiet mode prints the envelope display field, not scraped text', () => {
    expect(renderCompute(envelope, 'quiet')).toBe('{-2, 2}');
  });

  it('json mode prints the envelope as-is', () => {
    expect(JSON.parse(renderCompute(envelope, 'json')).display).toBe('{-2, 2}');
  });

  it('text mode passes the handler text through', () => {
    const r = { content: [{ type: 'text' as const, text: 'Result: 4' }], isError: false };
    expect(renderCompute(r, 'text')).toBe('Result: 4');
  });

  // Every verify mode reads the verdict from the typed field, so the input is
  // always the JSON envelope — text mode included.
  const verifyEnvelope = (verified: boolean, evaluated = true) => ({
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          verified,
          evaluated,
          confidence: 'high',
          explanation: verified ? 'holds' : 'does not hold',
          checks_performed: ['Symbolic: checked'],
        }),
      },
    ],
    isError: false,
  });

  it('verify quiet mode prints the boolean and reports the verdict', () => {
    expect(renderVerify(verifyEnvelope(false), 'quiet')).toEqual({
      out: 'false',
      verified: false,
      evaluated: true,
    });
  });

  it('verify json mode keeps the structure and still reports the verdict', () => {
    const rendered = renderVerify(verifyEnvelope(true), 'json');
    expect(JSON.parse(rendered.out).verified).toBe(true);
    expect(rendered.verified).toBe(true);
  });

  it('verify text mode renders via the tool formatter, not by parsing text', () => {
    const rendered = renderVerify(verifyEnvelope(true), 'text');
    expect(rendered.verified).toBe(true);
    expect(rendered.out).toContain('Verified: TRUE');
    expect(rendered.out).toContain('Checks performed:');
  });

  it('verify reports evaluated: false separately from a false verdict', () => {
    // The distinction the exit code rests on: "checked and refuted" (exit 2)
    // must not be reachable from "could not be checked at all" (exit 1).
    const rendered = renderVerify(verifyEnvelope(false, false), 'text');
    expect(rendered.verified).toBe(false);
    expect(rendered.evaluated).toBe(false);
    expect(rendered.out).toContain('UNKNOWN');
    expect(rendered.out).not.toContain('FALSE');
  });

  it('verify refuses an envelope with no verdict rather than assuming one', () => {
    const missing = {
      content: [{ type: 'text' as const, text: JSON.stringify({ confidence: 'high' }) }],
      isError: false,
    };
    expect(() => renderVerify(missing, 'quiet')).toThrow(/no verdict/);
  });

  it('plot metadata names the file it wrote', () => {
    const meta = JSON.parse(
      renderPlotMeta(
        {
          svg: '<svg/>',
          expression: 'sin(x)',
          variable: 'x',
          xMin: -10,
          xMax: 10,
          yMin: -1,
          yMax: 1,
          segments: 1,
          samples: 200,
          points: 187,
        },
        'out.svg'
      )
    );
    expect(meta).toEqual({
      ok: true,
      path: 'out.svg',
      expression: 'sin(x)',
      variable: 'x',
      x_range: [-10, 10],
      y_range: [-1, 1],
      segments: 1,
      samples: 200,
      points: 187,
    });
  });

  it('renderCompute in quiet mode with non-JSON input throws a legible error', () => {
    const nonJsonResult = {
      content: [{ type: 'text' as const, text: 'Error: something went wrong' }],
      isError: false,
    };
    expect(() => renderCompute(nonJsonResult, 'quiet')).toThrow(/something went wrong/);
  });

  it('renderVerify in quiet mode with non-JSON input throws a legible error', () => {
    const nonJsonResult = {
      content: [{ type: 'text' as const, text: 'Error: something went wrong' }],
      isError: false,
    };
    expect(() => renderVerify(nonJsonResult, 'quiet')).toThrow(/something went wrong/);
  });

  it('renderCompute in text mode with non-JSON input returns it unchanged', () => {
    const nonJsonResult = {
      content: [{ type: 'text' as const, text: 'Error: something went wrong' }],
      isError: false,
    };
    expect(renderCompute(nonJsonResult, 'text')).toBe('Error: something went wrong');
  });
});

describe('parse — each range flag lands in its own field', () => {
  // These six flags share one `switch` case and were then re-dispatched by a
  // second if/else cascade on the same token. Only --x-min was ever asserted
  // in isolation, so a mis-wired arm (e.g. --y-max writing height) would have
  // been invisible. One assertion per flag, so the mapping is pinned per arm.
  const cases: [string, keyof PlotCommand, number][] = [
    ['--x-min', 'xMin', -3],
    ['--x-max', 'xMax', 7],
    ['--y-min', 'yMin', -11],
    ['--y-max', 'yMax', 13],
    ['--width', 'width', 640],
    ['--height', 'height', 480],
  ];

  it.each(cases)('%s sets %s and nothing else', (flag, field, value) => {
    const cmd = parseArgs(['plot', 'sin(x)', flag, String(value)]) as PlotCommand;
    expect(cmd.kind).toBe('plot');
    expect(cmd[field]).toBe(value);
    // Every other range field stays untouched — this is what catches a
    // cascade arm assigning the wrong variable.
    for (const [, other] of cases) {
      if (other !== field) expect(cmd[other], `${flag} also set ${other}`).toBeUndefined();
    }
  });

  it('accepts all six together, each in its own field', () => {
    // Driven off the same table, so a seventh range flag needs one edit here,
    // not three.
    const argv = cases.flatMap(([flag, , value]) => [flag, String(value)]);
    const cmd = parseArgs(['plot', 'sin(x)', ...argv]) as PlotCommand;
    expect(cases.map(([, field]) => cmd[field])).toEqual(cases.map(([, , value]) => value));
  });
});
