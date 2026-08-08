/**
 * Hand-rolled argument parsing for the three subcommands.
 *
 * Deliberately not a dependency: three subcommands and a dozen flags do not
 * justify adding a package to a tree this project spent effort shrinking.
 */

export type OutputMode = 'text' | 'latex' | 'json' | 'quiet';

/** Thrown for anything the user could fix by reading the usage text. */
export class UsageError extends Error {}

export interface ComputeCommand {
  kind: 'compute';
  expression?: string;
  domain?: string;
  precision?: number;
  output: OutputMode;
}

export interface VerifyCommand {
  kind: 'verify';
  claim?: string;
  method?: string;
  output: OutputMode;
}

export interface PlotCommand {
  kind: 'plot';
  expression?: string;
  out?: string;
  variable?: string;
  xMin?: number;
  xMax?: number;
  yMin?: number;
  yMax?: number;
  width?: number;
  height?: number;
  title?: string;
  output: OutputMode;
}

export interface ServerCommand {
  kind: 'server';
}

export interface HelpCommand {
  kind: 'help';
  topic?: 'compute' | 'verify' | 'plot';
}

export interface VersionCommand {
  kind: 'version';
}

export type Command =
  | ComputeCommand
  | VerifyCommand
  | PlotCommand
  | ServerCommand
  | HelpCommand
  | VersionCommand;

export const USAGE = `axiom-mcp — symbolic math over MCP, or straight from the shell

With no arguments it runs as an MCP stdio server (what MCP clients invoke).
With a subcommand it runs that computation and exits.

  axiom-mcp compute <expr>  [--domain real|complex|numeric|exact]
                            [--precision 1..50] [--json | --latex | -q]

  axiom-mcp verify  <claim> [--method numeric|symbolic|both] [--json | -q]

  axiom-mcp plot    <expr>  [-o|--out file.svg] [--variable x]
                            [--x-min n] [--x-max n] [--y-min n] [--y-max n]
                            [--width n] [--height n] [--title s] [--json | -q]

  -q, --quiet   print one value only (for scripting)
  --json        structured output
  -h, --help    this text, or help for a subcommand
  -V, --version print the version

The expression is read from stdin when no positional argument is given.
Use \`--\` before an expression that starts with a minus sign, e.g.
\`axiom-mcp compute -- '-2+2'\`.
Set AXIOM_EVAL_TIMEOUT_MS to change the per-evaluation timeout (default 10000).

Examples:
  axiom-mcp compute 'integrate(sin(x)^3,x)'
  axiom-mcp compute -q 'solve(x^2-4=0,x)'
  axiom-mcp verify 'sin(x)^2+cos(x)^2 = 1' --json
  echo 'diff(x^3,x)' | axiom-mcp compute
  axiom-mcp plot 'sin(x)' -o wave.svg

Run \`axiom-mcp <command> --help\` for a subcommand's own flags and examples.`;

export const USAGE_COMPUTE = `axiom-mcp compute — evaluate a math expression or CAS-style problem

  axiom-mcp compute <expr> [--domain real|complex|numeric|exact]
                           [--precision 1..50] [--json | --latex | -q]

Flags:
  --domain <d>     real|complex|numeric|exact — solution domain
  --precision <n>  decimal places, 1..50
  --json           structured output (parseable envelope)
  --latex          LaTeX-formatted result
  -q, --quiet      print one value only (for scripting)
  -h, --help       show this text

The expression is read from stdin when no positional argument is given.
Use \`--\` before an expression that starts with a minus sign.

Examples:
  axiom-mcp compute 'integrate(sin(x)^3,x)'
  axiom-mcp compute -q 'solve(x^2-4=0,x)'
  axiom-mcp compute --domain complex 'solve(x^2+1=0,x)'`;

export const USAGE_VERIFY = `axiom-mcp verify — check a mathematical claim

  axiom-mcp verify <claim> [--method numeric|symbolic|both] [--json | -q]

Flags:
  --method <m>   numeric|symbolic|both — verification method
  --json         structured output (parseable envelope)
  -q, --quiet    print "true" or "false" only (for scripting)
  -h, --help     show this text

The claim is read from stdin when no positional argument is given.
Exit codes: 0 verified, 2 not verified, 1 could not run.

Examples:
  axiom-mcp verify 'sin(x)^2+cos(x)^2 = 1'
  axiom-mcp verify -q 'x=2 satisfies x^2-4=0'
  axiom-mcp verify --method numeric --json 'sin(x)^2+cos(x)^2 = 1'`;

export const USAGE_PLOT = `axiom-mcp plot — render a function graph as SVG

  axiom-mcp plot <expr> [-o|--out file.svg] [--variable x]
                        [--x-min n] [--x-max n] [--y-min n] [--y-max n]
                        [--width n] [--height n] [--title s] [--json | -q]

Flags:
  -o, --out <file>       write the SVG to a file instead of stdout
  --variable <v>         the free variable to plot over (default x)
  --x-min, --x-max <n>   horizontal range
  --y-min, --y-max <n>   vertical range (auto-fit if omitted)
  --width, --height <n>  SVG pixel dimensions
  --title <s>            plot title
  --json                 structured metadata instead of the SVG
  -q, --quiet            print the written path only (requires -o)
  -h, --help             show this text

The expression is read from stdin when no positional argument is given.
Without \`-o\` the SVG itself is written to stdout, so it can be piped.

Examples:
  axiom-mcp plot 'sin(x)' -o wave.svg
  axiom-mcp plot 'x^2-4' --x-min -5 --x-max 5 -o parabola.svg
  axiom-mcp plot 'sin(x)' --json`;

/** Returns the usage text for a subcommand, or the global text when omitted. */
export function topicUsage(topic?: 'compute' | 'verify' | 'plot'): string {
  if (topic === 'compute') return USAGE_COMPUTE;
  if (topic === 'verify') return USAGE_VERIFY;
  if (topic === 'plot') return USAGE_PLOT;
  return USAGE;
}

const DOMAINS = ['real', 'complex', 'numeric', 'exact'];
const METHODS = ['numeric', 'symbolic', 'both'];

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined) {
    throw new UsageError(`${flag} needs a value`);
  }
  // A flag starts with -- or is a single-char flag like -o, -q
  // A negative number like -1 is not a flag
  if (value.startsWith('--') || (value.startsWith('-') && value.length > 1 && /^-[a-zA-Z]$/.test(value))) {
    throw new UsageError(`${flag} needs a value`);
  }
  return value;
}

function parseNumber(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new UsageError(`${flag} needs a number, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/** Records an output mode, rejecting a second one. */
function setOutput(current: OutputMode, next: OutputMode): OutputMode {
  if (current !== 'text') {
    throw new UsageError('--json, --latex and -q are mutually exclusive');
  }
  return next;
}

export function parseArgs(argv: string[]): Command {
  if (argv.length === 0) return { kind: 'server' };

  const [first, ...rest] = argv;

  if (first === '-h' || first === '--help') return { kind: 'help' };
  if (first === '-V' || first === '--version') return { kind: 'version' };

  if (first !== 'compute' && first !== 'verify' && first !== 'plot') {
    throw new UsageError(`unknown command: ${first}`);
  }
  const kind = first;

  // `-h`/`--help` only counts before a `--` sentinel: `compute -- --help` must
  // compute the literal expression `--help`, not print help.
  const doubleDashIndex = rest.indexOf('--');
  const beforeDoubleDash = doubleDashIndex === -1 ? rest : rest.slice(0, doubleDashIndex);
  if (beforeDoubleDash.includes('-h') || beforeDoubleDash.includes('--help')) {
    return { kind: 'help', topic: kind };
  }

  let positional: string | undefined;
  let output: OutputMode = 'text';
  let domain: string | undefined;
  let precision: number | undefined;
  let method: string | undefined;
  let out: string | undefined;
  let variable: string | undefined;
  let xMin: number | undefined;
  let xMax: number | undefined;
  let yMin: number | undefined;
  let yMax: number | undefined;
  let width: number | undefined;
  let height: number | undefined;
  let title: string | undefined;

  let sawDoubleDash = false;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];

    if (!sawDoubleDash && arg === '--') {
      sawDoubleDash = true;
      continue;
    }

    // After `--`, every remaining argument is positional — this is the escape
    // for expressions that begin with `-` (`-x^2+1`, `-2+2`), which would
    // otherwise be sent into the flag switch below and rejected.
    if (sawDoubleDash || !arg.startsWith('-')) {
      if (positional !== undefined) {
        throw new UsageError(`unexpected extra argument: ${arg}`);
      }
      positional = arg;
      continue;
    }

    switch (arg) {
      case '--json':
        output = setOutput(output, 'json');
        break;
      case '-q':
      case '--quiet':
        output = setOutput(output, 'quiet');
        break;
      case '--latex':
        if (kind !== 'compute') {
          throw new UsageError(`--latex is only valid for compute`);
        }
        output = setOutput(output, 'latex');
        break;
      case '--domain':
        if (kind !== 'compute') throw new UsageError('--domain is only valid for compute');
        domain = requireValue(arg, rest[++i]);
        if (!DOMAINS.includes(domain)) {
          throw new UsageError(`--domain must be one of ${DOMAINS.join('|')}`);
        }
        break;
      case '--precision': {
        if (kind !== 'compute') throw new UsageError('--precision is only valid for compute');
        precision = parseNumber(arg, requireValue(arg, rest[++i]));
        if (!Number.isInteger(precision) || precision < 1 || precision > 50) {
          throw new UsageError('--precision must be an integer between 1 and 50');
        }
        break;
      }
      case '--method':
        if (kind !== 'verify') throw new UsageError('--method is only valid for verify');
        method = requireValue(arg, rest[++i]);
        if (!METHODS.includes(method)) {
          throw new UsageError(`--method must be one of ${METHODS.join('|')}`);
        }
        break;
      case '-o':
      case '--out':
        if (kind !== 'plot') throw new UsageError('-o is only valid for plot');
        out = requireValue(arg, rest[++i]);
        break;
      case '--variable':
        if (kind !== 'plot') throw new UsageError('--variable is only valid for plot');
        variable = requireValue(arg, rest[++i]);
        break;
      case '--x-min':
      case '--x-max':
      case '--y-min':
      case '--y-max':
      case '--width':
      case '--height': {
        if (kind !== 'plot') throw new UsageError(`${arg} is only valid for plot`);
        const n = parseNumber(arg, requireValue(arg, rest[++i]));
        if (arg === '--x-min') xMin = n;
        else if (arg === '--x-max') xMax = n;
        else if (arg === '--y-min') yMin = n;
        else if (arg === '--y-max') yMax = n;
        else if (arg === '--width') width = n;
        else height = n;
        break;
      }
      case '--title':
        if (kind !== 'plot') throw new UsageError('--title is only valid for plot');
        title = requireValue(arg, rest[++i]);
        break;
      default:
        throw new UsageError(`unknown option: ${arg}`);
    }
  }

  if (kind === 'compute') {
    const cmd: ComputeCommand = { kind, output };
    if (positional !== undefined) cmd.expression = positional;
    if (domain !== undefined) cmd.domain = domain;
    if (precision !== undefined) cmd.precision = precision;
    return cmd;
  }

  if (kind === 'verify') {
    const cmd: VerifyCommand = { kind, output };
    if (positional !== undefined) cmd.claim = positional;
    if (method !== undefined) cmd.method = method;
    return cmd;
  }

  // plot: -q prints the written path, so without -o there is nothing to print
  if (output === 'quiet' && out === undefined) {
    throw new UsageError('-q requires -o for plot: without a file there is no path to print');
  }
  const cmd: PlotCommand = { kind, output };
  if (positional !== undefined) cmd.expression = positional;
  if (out !== undefined) cmd.out = out;
  if (variable !== undefined) cmd.variable = variable;
  if (xMin !== undefined) cmd.xMin = xMin;
  if (xMax !== undefined) cmd.xMax = xMax;
  if (yMin !== undefined) cmd.yMin = yMin;
  if (yMax !== undefined) cmd.yMax = yMax;
  if (width !== undefined) cmd.width = width;
  if (height !== undefined) cmd.height = height;
  if (title !== undefined) cmd.title = title;
  return cmd;
}
