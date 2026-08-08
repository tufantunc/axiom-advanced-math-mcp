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
  const verifyEnvelope = (verified: boolean) => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          verified,
          confidence: 'high',
          explanation: verified ? 'holds' : 'does not hold',
          checks_performed: ['Symbolic: checked'],
        }),
      },
    ],
  });

  it('verify quiet mode prints the boolean and reports the verdict', () => {
    expect(renderVerify(verifyEnvelope(false), 'quiet')).toEqual({
      out: 'false',
      verified: false,
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
          points: 200,
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
      points: 200,
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
