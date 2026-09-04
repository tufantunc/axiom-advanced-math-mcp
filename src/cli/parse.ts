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
  ComputeCommand | VerifyCommand | PlotCommand | ServerCommand | HelpCommand | VersionCommand;

export const USAGE = `axiom-math — symbolic math over MCP, or straight from the shell

With no arguments it runs as an MCP stdio server (what MCP clients invoke).
With a subcommand it runs that computation and exits.

  axiom-math compute <expr>  [--domain real|complex|numeric|exact]
                             [--precision 1..50] [--json | --latex | -q]

  axiom-math verify  <claim> [--method numeric|symbolic|both] [--json | -q]

  axiom-math plot    <expr>  [-o|--out file.svg] [--variable x]
                             [--x-min n] [--x-max n] [--y-min n] [--y-max n]
                             [--width n] [--height n] [--title s] [--json | -q]

  -q, --quiet   print one value only (for scripting)
  --json        structured output
  -h, --help    this text, or help for a subcommand
  -V, --version print the version

The expression is read from stdin when no positional argument is given.
Use \`--\` before an expression that starts with a minus sign, e.g.
\`axiom-math compute -- '-2+2'\`.
Set AXIOM_EVAL_TIMEOUT_MS to change the per-evaluation timeout (default 10000).
Set AXIOM_INTEGRATION_BUDGET_MS to bound one integration or root search (default 3x the
per-evaluation timeout, minimum 30000). Set AXIOM_JS_COMPUTE_HEAP_MB to cap the memory of
one arbitrary-precision or arithmetic computation (default 512).

Examples:
  axiom-math compute 'integrate(sin(x)^3,x)'
  axiom-math compute -q 'solve(x^2-4=0,x)'
  axiom-math verify 'sin(x)^2+cos(x)^2 = 1' --json
  echo 'diff(x^3,x)' | axiom-math compute
  axiom-math plot 'sin(x)' -o wave.svg

Run \`axiom-math <command> --help\` for a subcommand's own flags and examples.`;

export const USAGE_COMPUTE = `axiom-math compute — evaluate a math expression or CAS-style problem

  axiom-math compute <expr> [--domain real|complex|numeric|exact]
                            [--precision 1..50] [--json | --latex | -q]

Flags:
  --domain <d>     real|complex|numeric|exact — solution domain
  --precision <n>  significant digits, 1..50 (omit for full precision)
  --json           structured output (parseable envelope)
  --latex          LaTeX-formatted result
  -q, --quiet      print one value only (for scripting)
  -h, --help       show this text

The expression is read from stdin when no positional argument is given.
Use \`--\` before an expression that starts with a minus sign.

Examples:
  axiom-math compute 'integrate(sin(x)^3,x)'
  axiom-math compute -q 'solve(x^2-4=0,x)'
  axiom-math compute --domain complex 'solve(x^2+1=0,x)'`;

export const USAGE_VERIFY = `axiom-math verify — check a mathematical claim

  axiom-math verify <claim> [--method numeric|symbolic|both] [--json | -q]

Flags:
  --method <m>   numeric|symbolic|both — verification method
  --json         structured output (parseable envelope)
  -q, --quiet    print "true" or "false" only (for scripting)
  -h, --help     show this text

The claim is read from stdin when no positional argument is given.
Exit codes: 0 verified, 2 not verified, 1 could not run.

Examples:
  axiom-math verify 'sin(x)^2+cos(x)^2 = 1'
  axiom-math verify -q 'x=2 satisfies x^2-4=0'
  axiom-math verify --method numeric --json 'sin(x)^2+cos(x)^2 = 1'`;

export const USAGE_PLOT = `axiom-math plot — render a function graph as SVG

  axiom-math plot <expr> [-o|--out file.svg] [--variable x]
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
  axiom-math plot 'sin(x)' -o wave.svg
  axiom-math plot 'x^2-4' --x-min -5 --x-max 5 -o parabola.svg
  axiom-math plot 'sin(x)' --json`;

/** Returns the usage text for a subcommand, or the global text when omitted. */
export function topicUsage(topic?: 'compute' | 'verify' | 'plot'): string {
  if (topic === 'compute') return USAGE_COMPUTE;
  if (topic === 'verify') return USAGE_VERIFY;
  if (topic === 'plot') return USAGE_PLOT;
  return USAGE;
}

/**
 * Range/size flag -> the PlotCommand field it sets.
 *
 * `satisfies Record<string, keyof PlotCommand>` is what makes a mistyped field
 * name a compile error; RangeField is then derived from this map, so the field
 * names have exactly one author.
 */
const RANGE_FIELDS = {
  '--x-min': 'xMin',
  '--x-max': 'xMax',
  '--y-min': 'yMin',
  '--y-max': 'yMax',
  '--width': 'width',
  '--height': 'height',
} as const satisfies Record<string, keyof PlotCommand>;

type RangeFlag = keyof typeof RANGE_FIELDS;
type RangeField = (typeof RANGE_FIELDS)[RangeFlag];

// Object.hasOwn, not `in`: `in` walks the prototype chain, so `toString` and
// `constructor` would test true and index RANGE_FIELDS to a function. Bare words
// are already rejected upstream as an extra argument, so that is unreachable
// today — but the predicate should be correct on its own terms rather than
// relying on a guard elsewhere in the function.
const isRangeFlag = (arg: string): arg is RangeFlag => Object.hasOwn(RANGE_FIELDS, arg);

const DOMAINS = ['real', 'complex', 'numeric', 'exact'];
const METHODS = ['numeric', 'symbolic', 'both'];

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined) {
    throw new UsageError(`${flag} needs a value`);
  }
  // The next argument being another flag means this one was left without a
  // value. A long flag (`--json`) or a single-letter short flag (`-q`) counts;
  // a negative number (`-1`, `-2.5`) does not, since that is a legitimate
  // value for --x-min and friends.
  if (value.startsWith('--') || /^-[a-zA-Z]$/.test(value)) {
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

  // `-h`/`--help` only counts before a `--` sentinel: `compute -- --help` must
  // compute the literal expression `--help`, not print help.
  const doubleDashIndex = rest.indexOf('--');
  const beforeDoubleDash = doubleDashIndex === -1 ? rest : rest.slice(0, doubleDashIndex);
  if (beforeDoubleDash.includes('-h') || beforeDoubleDash.includes('--help')) {
    return { kind: 'help', topic: first };
  }

  if (first === 'compute') return parseComputeArgs(rest);
  if (first === 'verify') return parseVerifyArgs(rest);
  return parsePlotArgs(rest);
}

/**
 * Which subcommand a flag belongs to. Each parser's switch handles only its
 * own flags; this table is what a foreign flag hits, so it is the single
 * author of both the "only valid for" error and the flag/kind pairing —
 * the same drift guard RANGE_FIELDS gives the range flags. Range flags
 * derive their owner from RANGE_FIELDS so the two tables cannot disagree.
 */
const FLAG_OWNER = {
  '--latex': 'compute',
  '--domain': 'compute',
  '--precision': 'compute',
  '--method': 'verify',
  // The old switch's case label was `-o`; --out fell into it, so the error
  // named `-o` whichever spelling the user typed. Kept byte-identical.
  '-o': 'plot',
  '--out': 'plot',
  '--variable': 'plot',
  '--title': 'plot',
  ...Object.fromEntries(Object.keys(RANGE_FIELDS).map((f) => [f, 'plot'])),
} as const satisfies Record<string, 'compute' | 'verify' | 'plot'>;

/**
 * The one alias whose foreign-flag error names its primary spelling: the old
 * switch's case label was `-o`, so `--out` reported `-o` whichever spelling
 * the user typed. `-q`/`--quiet` never carried a kind guard, so no other
 * alias has an error text to preserve.
 */
const FLAG_ERROR_NAME: Partial<Record<string, string>> = { '--out': '-o' };

/** The shared default case: a flag we know, but for another subcommand. */
function rejectForeignFlag(kind: string, arg: string): never {
  const owner = Object.hasOwn(FLAG_OWNER, arg)
    ? FLAG_OWNER[arg as keyof typeof FLAG_OWNER]
    : undefined;
  if (owner !== undefined && owner !== kind) {
    const name = FLAG_ERROR_NAME[arg] ?? arg;
    throw new UsageError(`${name} is only valid for ${owner}`);
  }
  throw new UsageError(`unknown option: ${arg}`);
}

/** One loop iteration's classification — the `--` mechanics live only here. */
function classifyArg(sawDoubleDash: boolean, arg: string): 'sentinel' | 'positional' | 'flag' {
  if (!sawDoubleDash && arg === '--') return 'sentinel';
  if (sawDoubleDash || !arg.startsWith('-')) return 'positional';
  return 'flag';
}

/** Accepts the single positional, refusing a second one. */
function takePositional(current: string | undefined, arg: string): string {
  if (current !== undefined) {
    throw new UsageError(`unexpected extra argument: ${arg}`);
  }
  return arg;
}

function parseComputeArgs(rest: string[]): ComputeCommand {
  let expression: string | undefined;
  let output: OutputMode = 'text';
  let domain: string | undefined;
  let precision: number | undefined;
  let sawDoubleDash = false;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const cls = classifyArg(sawDoubleDash, arg);
    if (cls === 'sentinel') {
      sawDoubleDash = true;
    } else if (cls === 'positional') {
      expression = takePositional(expression, arg);
    } else {
      switch (arg) {
        case '--json':
          output = setOutput(output, 'json');
          break;
        case '-q':
        case '--quiet':
          output = setOutput(output, 'quiet');
          break;
        case '--latex':
          output = setOutput(output, 'latex');
          break;
        case '--domain':
          domain = requireValue(arg, rest[++i]);
          if (!DOMAINS.includes(domain)) {
            throw new UsageError(`--domain must be one of ${DOMAINS.join('|')}`);
          }
          break;
        case '--precision': {
          precision = parseNumber(arg, requireValue(arg, rest[++i]));
          if (!Number.isInteger(precision) || precision < 1 || precision > 50) {
            throw new UsageError('--precision must be an integer between 1 and 50');
          }
          break;
        }
        default:
          rejectForeignFlag('compute', arg);
      }
    }
  }

  const cmd: ComputeCommand = { kind: 'compute', output };
  if (expression !== undefined) cmd.expression = expression;
  if (domain !== undefined) cmd.domain = domain;
  if (precision !== undefined) cmd.precision = precision;
  return cmd;
}

function parseVerifyArgs(rest: string[]): VerifyCommand {
  let claim: string | undefined;
  let output: OutputMode = 'text';
  let method: string | undefined;
  let sawDoubleDash = false;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const cls = classifyArg(sawDoubleDash, arg);
    if (cls === 'sentinel') {
      sawDoubleDash = true;
    } else if (cls === 'positional') {
      claim = takePositional(claim, arg);
    } else {
      switch (arg) {
        case '--json':
          output = setOutput(output, 'json');
          break;
        case '-q':
        case '--quiet':
          output = setOutput(output, 'quiet');
          break;
        case '--method':
          method = requireValue(arg, rest[++i]);
          if (!METHODS.includes(method)) {
            throw new UsageError(`--method must be one of ${METHODS.join('|')}`);
          }
          break;
        default:
          rejectForeignFlag('verify', arg);
      }
    }
  }

  const cmd: VerifyCommand = { kind: 'verify', output };
  if (claim !== undefined) cmd.claim = claim;
  if (method !== undefined) cmd.method = method;
  return cmd;
}

function parsePlotArgs(rest: string[]): PlotCommand {
  let expression: string | undefined;
  let output: OutputMode = 'text';
  let out: string | undefined;
  let variable: string | undefined;
  let title: string | undefined;
  const range: Partial<Record<RangeField, number>> = {};
  let sawDoubleDash = false;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const cls = classifyArg(sawDoubleDash, arg);
    if (cls === 'sentinel') {
      sawDoubleDash = true;
    } else if (cls === 'positional') {
      expression = takePositional(expression, arg);
    } else {
      switch (arg) {
        case '--json':
          output = setOutput(output, 'json');
          break;
        case '-q':
        case '--quiet':
          output = setOutput(output, 'quiet');
          break;
        case '-o':
        case '--out':
          out = requireValue(arg, rest[++i]);
          break;
        case '--variable':
          variable = requireValue(arg, rest[++i]);
          break;
        case '--title':
          title = requireValue(arg, rest[++i]);
          break;
        default:
          // Range/size flags are dispatched off RANGE_FIELDS rather than their
          // own case labels, so that table is the single author of both which
          // flags exist and which field each one sets. With case labels, drift
          // was only half-caught: a label with no entry failed to compile, but
          // an entry with no label compiled clean and silently did nothing.
          if (isRangeFlag(arg)) {
            range[RANGE_FIELDS[arg]] = parseNumber(arg, requireValue(arg, rest[++i]));
            break;
          }
          rejectForeignFlag('plot', arg);
      }
    }
  }

  // plot: -q prints the written path, so without -o there is nothing to print
  if (output === 'quiet' && out === undefined) {
    throw new UsageError('-q requires -o for plot: without a file there is no path to print');
  }
  // `range` holds only the flags actually seen, so spreading it keeps the
  // absent-key style the rest of this function uses.
  const cmd: PlotCommand = { kind: 'plot', output, ...range };
  if (expression !== undefined) cmd.expression = expression;
  if (out !== undefined) cmd.out = out;
  if (variable !== undefined) cmd.variable = variable;
  if (title !== undefined) cmd.title = title;
  return cmd;
}
