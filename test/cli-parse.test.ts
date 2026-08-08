import { describe, it, expect } from 'vitest';
import { parseArgs, UsageError } from '../src/cli/parse.js';
import {
  resultText,
  renderCompute,
  renderVerify,
  renderPlotMeta,
} from '../src/cli/render.js';

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
    expect(parseArgs(['compute', 'x', '--json']).output).toBe('json');
    expect(parseArgs(['compute', 'x', '--latex']).output).toBe('latex');
    expect(parseArgs(['compute', 'x', '-q']).output).toBe('quiet');
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
    [['compute', 'x', '--variable', 't'], /--variable is only valid for plot/],
    [['compute', 'x', '--x-min', '0'], /--x-min is only valid for plot/],
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
      'plot', 'sin(x)', '-o', 'out.svg',
      '--variable', 't', '--x-min', '-1', '--x-max', '1',
      '--width', '800', '--height', '600', '--title', 'hi',
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
    expect(parseArgs(['plot', 'sin(x)', '-o', 'f.svg', '-q']).output).toBe('quiet');
  });

  it('rejects a non-numeric range value', () => {
    expect(() => parseArgs(['plot', 'sin(x)', '--x-min', 'left'])).toThrow(UsageError);
  });
});

describe('render', () => {
  const envelope = {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ success: true, display: '{-2, 2}', latex: '\\{-2,2\\}' }),
      },
    ],
  };

  it('joins content blocks into text', () => {
    expect(resultText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe(
      'a\nb'
    );
  });

  it('quiet mode prints the envelope display field, not scraped text', () => {
    expect(renderCompute(envelope, 'quiet')).toBe('{-2, 2}');
  });

  it('json mode prints the envelope as-is', () => {
    expect(JSON.parse(renderCompute(envelope, 'json')).display).toBe('{-2, 2}');
  });

  it('text mode passes the handler text through', () => {
    const r = { content: [{ type: 'text', text: 'Result: 4' }] };
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
      content: [{ type: 'text', text: 'Error: something went wrong' }],
    };
    expect(() => renderCompute(nonJsonResult, 'quiet')).toThrow(/something went wrong/);
  });

  it('renderVerify in quiet mode with non-JSON input throws a legible error', () => {
    const nonJsonResult = {
      content: [{ type: 'text', text: 'Error: something went wrong' }],
    };
    expect(() => renderVerify(nonJsonResult, 'quiet')).toThrow(/something went wrong/);
  });

  it('renderCompute in text mode with non-JSON input returns it unchanged', () => {
    const nonJsonResult = {
      content: [{ type: 'text', text: 'Error: something went wrong' }],
    };
    expect(renderCompute(nonJsonResult, 'text')).toBe('Error: something went wrong');
  });
});
