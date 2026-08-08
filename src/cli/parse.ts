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

  axiom-mcp plot    <expr>  [-o file.svg] [--variable x]
                            [--x-min n] [--x-max n] [--y-min n] [--y-max n]
                            [--width n] [--height n] [--title s] [--json | -q]

  -q            print one value only (for scripting)
  --json        structured output
  -h, --help    this text, or help for a subcommand
  -V, --version print the version

The expression is read from stdin when no positional argument is given.
Set AXIOM_EVAL_TIMEOUT_MS to change the per-evaluation timeout (default 10000).

Examples:
  axiom-mcp compute 'integrate(sin(x)^3,x)'
  axiom-mcp compute -q 'solve(x^2-4=0,x)'
  axiom-mcp verify 'sin(x)^2+cos(x)^2 = 1' --json
  echo 'diff(x^3,x)' | axiom-mcp compute
  axiom-mcp plot 'sin(x)' -o wave.svg`;

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

  if (rest.includes('-h') || rest.includes('--help')) {
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

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];

    if (!arg.startsWith('-')) {
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
