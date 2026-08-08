import { describe, it, expect } from 'vitest';
import { parseArgs, UsageError } from '../src/cli/parse.js';

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
