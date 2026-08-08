# CLI Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `compute`, `verify` and `plot` invocable as shell subcommands from the existing npm package, without changing how MCP clients start the server, and ship a skill definition so any agent can use them with no setup.

**Architecture:** `dist/cli.js` stays the single `bin` but becomes a dispatcher: no arguments keeps today's MCP stdio server byte for byte, a subcommand enters CLI mode. The CLI calls the same wrapped tool handlers the MCP server registers, so CAS-session semantics cannot diverge between the two surfaces.

**Tech Stack:** TypeScript (NodeNext ESM), vitest, zod. **No new dependencies** — argument parsing is hand-rolled.

**Spec:** [docs/superpowers/specs/2026-08-08-cli-surface-design.md](../specs/2026-08-08-cli-surface-design.md)

## Global Constraints

- Node.js >= 20. ESM with NodeNext: relative imports inside `src/` carry `.js` extensions even though sources are `.ts`.
- **No new dependencies of any kind**, production or dev.
- `package.json`'s `bin` stays `{ "axiom-mcp": "./dist/cli.js" }`. Do not add a second bin: two bins whose names don't match the package name make `npx -y axiom-advanced-math-mcp` fail with "could not determine executable to run", which is the line in every MCP client config.
- **Running with no arguments must keep starting the MCP stdio server, unchanged.** This is the backwards-compatibility guarantee; Task 7 tests it explicitly.
- **stdout carries only the requested output.** Usage errors, warnings, hints and tool errors all go to stderr. A single stray stdout line breaks `RESULT=$(axiom-mcp compute -q '...')`.
- `-q` never parses human-readable text. It prints one scalar sourced from structured data.
- Output modes `--json`, `--latex`, `-q` are mutually exclusive; combining two is a usage error (exit 1).
- Exit codes: `0` success (and for `verify`, verified) · `1` tool or usage error · `2` `verify` only, ran but claim not verified.
- `src/server/transports/http-app.ts` must keep importing no `node:*` module, directly or transitively (`test/http-portability.test.ts` enforces it). Nothing in this plan should touch it.
- Existing suites must stay green: 675 unit, 45 integration.
- Branch: `feat/cli-surface`, from `main` @ `221af26`.
- Do not touch `benchmark/`.

## File structure

| File | Responsibility |
| --- | --- |
| `src/cli.ts` (rewrite) | Dispatcher: no args → MCP server; subcommand → CLI. Owns process exit codes. |
| `src/cli/parse.ts` (new) | argv → a typed `Command` object. Pure; throws `UsageError`. |
| `src/cli/render.ts` (new) | Turns a handler result into the bytes stdout gets, per output mode. Pure. |
| `src/cli/commands.ts` (new) | The three subcommands: call a tool, hand the result to `render`, return an exit code. |
| `src/server/tools.ts` (new) | The CAS-wrapped tool functions, consumed by `createServer()` **and** the CLI. |
| `src/server/tools/plot/render.ts` (new) | `plotToSvg` extracted from the inline MCP handler, plus its result type. |
| `src/server/tools/plot/index.ts` (modify) | Register the MCP tool using `plotToSvg`. |
| `src/server/tools/verify/index.ts` (modify) | Add the `format` field and a JSON branch. |
| `src/server/index.ts` (modify) | Consume `src/server/tools.ts` instead of wrapping inline. |
| `skills/axiom-math/SKILL.md` (new) | The agent-facing skill definition. |
| `test/cli-parse.test.ts` (new) | Unit: parsing and rendering. No build needed. |
| `test/cli-contract.test.ts` (new) | Integration: real process invocation. Needs `dist/`. |

---

### Task 0: Create the working branch

**Files:** none

- [ ] **Step 1: Branch from main**

```bash
cd /Users/tufantunc/Desktop/Projects/Personal/axiom-advanced-math-mcp
git checkout main
git checkout -b feat/cli-surface
```

- [ ] **Step 2: Confirm a clean baseline**

Run: `npm test`
Expected: `Tests  675 passed (675)`.

---

### Task 1: Shared wrapped tool definitions

The MCP registration currently wraps handlers in a local `withIsolatedCasSession` inside `src/server/index.ts`. The CLI needs the *same* wrapper, so move it somewhere both can import. Pure refactor — no behaviour change.

**Files:**
- Create: `src/server/tools.ts`
- Modify: `src/server/index.ts`

**Interfaces:**
- Produces:
  - `export const computeTool: (args: ComputeArgs) => Promise<ToolResult>`
  - `export const verifyTool: (args: Record<string, unknown>) => Promise<ToolResult>`
  - where `ToolResult` is `{ content: { type: 'text'; text: string }[]; isError?: boolean }`
  - Tasks 6 and 7 consume both.

- [ ] **Step 1: Create the shared module**

Create `src/server/tools.ts`:

```ts
import { withGiacSession } from './giac/session-lock.js';
import { evaluationCache } from './tools/symbolic/cache.js';
import { computeHandler } from './tools/compute/index.js';
import { verifyHandler } from './tools/verify/index.js';

/**
 * Runs one Giac-backed tool call as an isolated CAS session.
 *
 * `withGiacSession` resets the *engine*; this also drops the memoized *results*
 * computed under the session being discarded. See the long comment in
 * giac/session-lock.ts for why both halves are needed.
 *
 * This lives here rather than in index.ts so the CLI can wrap the same way the
 * MCP registration does. If the two surfaces wrapped differently, CAS isolation
 * would silently depend on which one you came in through.
 */
function withIsolatedCasSession<A, R>(handler: (args: A) => Promise<R>): (args: A) => Promise<R> {
  return withGiacSession(async (args: A) => {
    evaluationCache.clear();
    return handler(args);
  });
}

export const computeTool = withIsolatedCasSession(
  async (args: Parameters<typeof computeHandler>[0]) => computeHandler(args)
);

export const verifyTool = withIsolatedCasSession(async (args: Record<string, unknown>) =>
  verifyHandler(args)
);
```

- [ ] **Step 2: Consume it from the server**

In `src/server/index.ts`: delete the local `withIsolatedCasSession` function and its doc comment, remove the now-unused `withGiacSession` and `evaluationCache` imports, and add:

```ts
import { computeTool, verifyTool } from './tools.js';
```

Then change the two registrations to pass the shared functions directly:

```ts
    computeSchema.shape,
    computeTool
```

```ts
    verifySchema.shape,
    verifyTool
```

Leave the file's top-of-file comment about Giac session state in place — it still explains why the wrapping exists.

- [ ] **Step 3: Verify nothing changed behaviourally**

Run: `npm test`
Expected: `Tests  675 passed (675)` — same count, all passing. The CAS-isolation tests in `test/http-app.test.ts` are the ones that would catch a mistake here.

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/server/tools.ts src/server/index.ts
git commit -m "refactor: share the CAS-wrapped tool definitions

The CLI needs the same withIsolatedCasSession wrapper the MCP
registration uses. Moved to src/server/tools.ts so both surfaces import
one definition instead of each wrapping their own way."
```

---

### Task 2: `verify` gains structured output

`verifyHandler` already computes `VerifyResult { verified, confidence, explanation, checks_performed }` and then formats it away. Expose it, so both the CLI's `--json` and MCP clients can read `verified` instead of parsing `Verified: TRUE ✓`.

**Files:**
- Modify: `src/server/tools/verify/index.ts`
- Test: `test/verify-format.test.ts` (new)

**Interfaces:**
- Produces: `verifySchema` gains `format?: 'text' | 'json'`. Task 6 passes `format: 'json'` for `--json` and `-q`.

- [ ] **Step 1: Write the failing test**

Create `test/verify-format.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { verifyHandler } from '../src/server/tools/verify/index.js';

function text(r: { content: { text: string }[] }): string {
  return r.content.map((c) => c.text).join('\n');
}

describe('verify format: json', () => {
  it('returns a parseable VerifyResult for a true claim', async () => {
    const r = await verifyHandler({ claim: 'sin(x)^2+cos(x)^2 = 1', format: 'json' });
    const parsed = JSON.parse(text(r));
    expect(parsed.verified).toBe(true);
    expect(parsed.confidence).toBeDefined();
    expect(Array.isArray(parsed.checks_performed)).toBe(true);
  });

  it('reports verified:false for a false claim', async () => {
    const r = await verifyHandler({ claim: 'sin(x)^2+cos(x)^2 = 2', format: 'json' });
    expect(JSON.parse(text(r)).verified).toBe(false);
  });

  it('still returns human-readable text by default', async () => {
    const r = await verifyHandler({ claim: 'sin(x)^2+cos(x)^2 = 1' });
    expect(text(r)).toContain('Verified: TRUE');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/verify-format.test.ts`
Expected: FAIL — the first two cases throw from `JSON.parse`, because the handler still returns the human-readable lines.

- [ ] **Step 3: Add the schema field**

In `src/server/tools/verify/index.ts`, add to `verifySchema` after the `method` field:

```ts
  format: z
    .enum(['text', 'json'])
    .optional()
    .describe(
      'Output format:\n' +
        '  text (default) — human-readable verdict\n' +
        '  json — structured VerifyResult'
    ),
```

Note this deliberately does not mirror `compute`'s `text|latex|json`: a verification verdict has no LaTeX form.

- [ ] **Step 4: Branch on it in the formatter**

In `src/server/tools/verify/index.ts`, change `formatVerifyResponse` to take the format and emit JSON when asked:

Note the `export`: the CLI renders text mode by calling this, so the human-readable
layout lives in exactly one place and nothing has to parse it back.

```ts
export function formatVerifyResponse(
  result: VerifyResult,
  format: 'text' | 'json'
): {
  content: { type: 'text'; text: string }[];
  isError: boolean;
} {
  if (format === 'json') {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      isError: false,
    };
  }

  const lines: string[] = [
    `Verified: ${result.verified ? 'TRUE ✓' : 'FALSE ✗'}`,
    `Confidence: ${result.confidence}`,
    `Explanation: ${result.explanation}`,
    '',
    'Checks performed:',
    ...result.checks_performed.map((c) => `  - ${c}`),
  ];
  return {
    content: lines.map((l) => ({ type: 'text' as const, text: l })),
    isError: false,
  };
}
```

Then in `verifyHandler`, read the option and pass it through. Find where `method` is read:

```ts
  const method = (args.method as string) || 'both';
```

and add below it:

```ts
  const format = args.format === 'json' ? 'json' : 'text';
```

Then update every `formatVerifyResponse(result)` call site in the file to `formatVerifyResponse(result, format)`. Use your editor's find-all to be sure none is missed — the file has more than one.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/verify-format.test.ts`
Expected: PASS, 3 tests.

Run: `npm test`
Expected: `Tests  678 passed (678)` (675 + 3).

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/server/tools/verify/index.ts test/verify-format.test.ts
git commit -m "feat(verify): add format:json for structured output

VerifyResult was already computed and then formatted away. Exposing it
means an agent can read verified:true instead of parsing 'Verified: TRUE ✓'.
Benefits MCP clients too, not just the upcoming CLI."
```

---

### Task 3: Extract `plotToSvg`

`plot`'s logic is inline in `registerPlotTools`. The CLI needs the SVG and its metadata without the base64 image wrapping, so extract the core. Pure refactor of the MCP path.

**Files:**
- Create: `src/server/tools/plot/render.ts`
- Modify: `src/server/tools/plot/index.ts`
- Test: `test/plot-render.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  export interface PlotArgs {
    expression: string; variable?: string;
    xMin?: number; xMax?: number; yMin?: number; yMax?: number;
    width?: number; height?: number; title?: string;
  }
  export interface PlotResult {
    svg: string; expression: string; variable: string;
    xMin: number; xMax: number; yMin: number; yMax: number;
    segments: number; points: number;
  }
  export function plotToSvg(args: PlotArgs): PlotResult   // throws Error on bad input
  ```
  Task 6 consumes `plotToSvg` and `PlotResult`.

- [ ] **Step 1: Write the failing test**

Create `test/plot-render.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { plotToSvg } from '../src/server/tools/plot/render.js';

describe('plotToSvg', () => {
  it('returns SVG text and the metadata describing it', () => {
    const r = plotToSvg({ expression: 'sin(x)', xMin: -10, xMax: 10 });
    expect(r.svg.startsWith('<svg')).toBe(true);
    expect(r.expression).toBe('sin(x)');
    expect(r.variable).toBe('x');
    expect(r.xMin).toBe(-10);
    expect(r.xMax).toBe(10);
    expect(r.segments).toBeGreaterThan(0);
    expect(r.points).toBeGreaterThan(0);
  });

  it('honours an explicit variable and y range', () => {
    const r = plotToSvg({ expression: 't^2', variable: 't', yMin: 0, yMax: 4 });
    expect(r.variable).toBe('t');
    expect(r.yMin).toBe(0);
    expect(r.yMax).toBe(4);
  });

  it('throws when the x range is inverted', () => {
    expect(() => plotToSvg({ expression: 'sin(x)', xMin: 5, xMax: 5 })).toThrow(
      /x_min must be less than x_max/
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/plot-render.test.ts`
Expected: FAIL — cannot resolve `../src/server/tools/plot/render.js`.

- [ ] **Step 3: Create the extracted renderer**

Create `src/server/tools/plot/render.ts`:

```ts
import { evaluateFunction } from './evaluator.js';
import { renderSvg } from './svg-renderer.js';

/** How many samples `evaluateFunction` takes across the x range. */
const PLOT_POINTS = 200;

export interface PlotArgs {
  expression: string;
  variable?: string;
  xMin?: number;
  xMax?: number;
  yMin?: number;
  yMax?: number;
  width?: number;
  height?: number;
  title?: string;
}

export interface PlotResult {
  svg: string;
  expression: string;
  variable: string;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  segments: number;
  points: number;
}

/**
 * Renders a function plot to SVG text plus the metadata describing it.
 *
 * Deliberately returns raw SVG rather than the base64 image block the MCP tool
 * sends: the CLI writes the SVG to a file or to stdout, and there is no inline
 * image in that path. Both callers share this function so the two surfaces
 * cannot drift apart on defaults or range handling.
 */
export function plotToSvg(args: PlotArgs): PlotResult {
  const variable = args.variable || 'x';
  const xMin = args.xMin ?? -10;
  const xMax = args.xMax ?? 10;
  const width = args.width ?? 600;
  const height = args.height ?? 400;

  if (xMin >= xMax) {
    throw new Error('x_min must be less than x_max');
  }

  const evalResult = evaluateFunction(args.expression, variable, xMin, xMax, PLOT_POINTS);
  const yMin = args.yMin ?? evalResult.yMin;
  const yMax = args.yMax ?? evalResult.yMax;

  const svg = renderSvg({
    width,
    height,
    xMin,
    xMax,
    yMin,
    yMax,
    title: args.title || `f(${variable}) = ${args.expression}`,
    segments: evalResult.segments,
  });

  return {
    svg,
    expression: args.expression,
    variable,
    xMin,
    xMax,
    yMin,
    yMax,
    segments: evalResult.segments.length,
    points: PLOT_POINTS,
  };
}
```

- [ ] **Step 4: Rewrite the MCP handler to use it**

In `src/server/tools/plot/index.ts`, replace the two `evaluateFunction`/`renderSvg` imports with:

```ts
import { plotToSvg } from './render.js';
```

Then replace the whole `async (args) => { ... }` handler body with:

```ts
    async (args) => {
      try {
        const result = plotToSvg({
          expression: args.expression as string,
          variable: args.variable as string | undefined,
          xMin: args.x_min as number | undefined,
          xMax: args.x_max as number | undefined,
          yMin: args.y_min as number | undefined,
          yMax: args.y_max as number | undefined,
          width: args.width as number | undefined,
          height: args.height as number | undefined,
          title: args.title as string | undefined,
        });

        const svgBase64 = Buffer.from(result.svg, 'utf-8').toString('base64');

        return {
          content: [
            { type: 'image' as const, data: svgBase64, mimeType: 'image/svg+xml' },
            {
              type: 'text' as const,
              text: `Plot of f(${result.variable}) = ${result.expression} over [${result.xMin}, ${result.xMax}]`,
            },
          ],
          isError: false,
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
```

The `x_min >= x_max` case now surfaces through the `catch` as `Error: x_min must be less than x_max`, which is the same text the old inline check produced.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/plot-render.test.ts`
Expected: PASS, 3 tests.

Run: `npm test`
Expected: `Tests  681 passed (681)` (678 + 3).

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/server/tools/plot/render.ts src/server/tools/plot/index.ts test/plot-render.test.ts
git commit -m "refactor(plot): extract plotToSvg from the MCP handler

The CLI needs the SVG and its metadata without the base64 image wrapping.
Both surfaces now share one function, so defaults and range handling
cannot drift apart."
```

---

### Task 4: Argument parser

**Files:**
- Create: `src/cli/parse.ts`
- Test: `test/cli-parse.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  export type OutputMode = 'text' | 'latex' | 'json' | 'quiet';
  export class UsageError extends Error {}
  export interface ComputeCommand { kind: 'compute'; expression?: string; domain?: string; precision?: number; output: OutputMode }
  export interface VerifyCommand { kind: 'verify'; claim?: string; method?: string; output: OutputMode }
  export interface PlotCommand { kind: 'plot'; expression?: string; out?: string; variable?: string; xMin?: number; xMax?: number; yMin?: number; yMax?: number; width?: number; height?: number; title?: string; output: OutputMode }
  export interface ServerCommand { kind: 'server' }
  export interface HelpCommand { kind: 'help'; topic?: 'compute' | 'verify' | 'plot' }
  export interface VersionCommand { kind: 'version' }
  export type Command = ComputeCommand | VerifyCommand | PlotCommand | ServerCommand | HelpCommand | VersionCommand;
  export function parseArgs(argv: string[]): Command;
  export const USAGE: string;
  ```
  Tasks 6 and 7 consume `parseArgs`, `Command`, `UsageError`, `USAGE`.
  `expression`/`claim` are optional because they may arrive on stdin.

- [ ] **Step 1: Write the failing test**

Create `test/cli-parse.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/cli-parse.test.ts`
Expected: FAIL — cannot resolve `../src/cli/parse.js`.

- [ ] **Step 3: Write the parser**

Create `src/cli/parse.ts`:

```ts
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
  if (value === undefined || value.startsWith('-')) {
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
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/cli-parse.test.ts`
Expected: PASS, all cases.

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/cli/parse.ts test/cli-parse.test.ts
git commit -m "feat(cli): argument parser for compute/verify/plot

Hand-rolled, no dependency. Rejects conflicting output modes, validates
enums and ranges against the tool schemas, and treats a missing
positional as 'read from stdin' rather than an error."
```

---

### Task 5: Output rendering and exit codes

**Files:**
- Create: `src/cli/render.ts`
- Modify: `test/cli-parse.test.ts` (add a `describe` block for rendering)

**Interfaces:**
- Consumes: `OutputMode` from `src/cli/parse.js` (Task 4); `PlotResult` from `src/server/tools/plot/render.js` (Task 3).
- Produces:
  ```ts
  export interface ToolResult { content: { type: string; text?: string }[]; isError?: boolean }
  export function resultText(r: ToolResult): string
  export function renderCompute(r: ToolResult, mode: OutputMode): string
  export function renderVerify(r: ToolResult, mode: OutputMode): { out: string; verified: boolean }
  export function renderPlotMeta(p: PlotResult, path: string | null): string
  ```
  Task 6 consumes all four.

- [ ] **Step 1: Write the failing test**

Append to `test/cli-parse.test.ts`:

```ts
import {
  resultText,
  renderCompute,
  renderVerify,
  renderPlotMeta,
} from '../src/cli/render.js';

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
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run test/cli-parse.test.ts`
Expected: FAIL — cannot resolve `../src/cli/render.js`.

- [ ] **Step 3: Write the renderer**

Create `src/cli/render.ts`:

```ts
import type { OutputMode } from './parse.js';
import type { PlotResult } from '../server/tools/plot/render.js';
import { formatVerifyResponse, type VerifyResult } from '../server/tools/verify/index.js';

export interface ToolResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

/** Concatenates a handler's text blocks the way the MCP client would see them. */
export function resultText(r: ToolResult): string {
  return r.content.map((c) => c.text ?? '').join('\n');
}

/**
 * `quiet` and `json` both read the structured envelope the handler produced with
 * `format: 'json'` — never the human-readable text. Scraping text would be
 * fragile, and a silently wrong answer is this product's worst failure mode.
 */
export function renderCompute(r: ToolResult, mode: OutputMode): string {
  const text = resultText(r);
  if (mode === 'text' || mode === 'latex') return text;

  const envelope = JSON.parse(text) as { display?: string };
  if (mode === 'json') return text;
  return envelope.display ?? '';
}

/**
 * The CLI always asks `verify` for `format: 'json'`, so the verdict is read from
 * a typed field in every mode — including text mode, whose human-readable layout
 * is produced by calling the tool's own formatter rather than reconstructing it
 * here. Nothing parses human-readable output anywhere.
 */
export function renderVerify(
  r: ToolResult,
  mode: OutputMode
): { out: string; verified: boolean } {
  const json = resultText(r);
  const parsed = JSON.parse(json) as VerifyResult;
  const verified = parsed.verified === true;

  if (mode === 'json') return { out: json, verified };
  if (mode === 'quiet') return { out: String(verified), verified };

  const rendered = formatVerifyResponse(parsed, 'text');
  return { out: rendered.content.map((c) => c.text).join('\n'), verified };
}

export function renderPlotMeta(p: PlotResult, path: string | null): string {
  return JSON.stringify(
    {
      ok: true,
      path,
      expression: p.expression,
      variable: p.variable,
      x_range: [p.xMin, p.xMax],
      y_range: [p.yMin, p.yMax],
      segments: p.segments,
      points: p.points,
    },
    null,
    2
  );
}
```

**`VerifyResult` must also be exported** from `src/server/tools/verify/index.ts` for the type import above — add `export` to its `interface VerifyResult` declaration (it is currently file-local).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/cli-parse.test.ts`
Expected: PASS, all cases.

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/cli/render.ts test/cli-parse.test.ts
git commit -m "feat(cli): output rendering per mode

quiet and json read the structured envelope, never the human-readable
text. The one exception is verify's text mode, which has no envelope to
read; documented in place and covered by an integration test."
```

---

### Task 6: The three subcommands

**Files:**
- Create: `src/cli/commands.ts`

**Interfaces:**
- Consumes: `computeTool`, `verifyTool` (Task 1); `plotToSvg`, `PlotResult` (Task 3); `Command` types (Task 4); render functions (Task 5).
- Produces:
  ```ts
  export async function runCommand(cmd: ComputeCommand | VerifyCommand | PlotCommand): Promise<number>
  ```
  Returns the process exit code. Task 7 consumes it.

- [ ] **Step 1: Write the implementation**

Create `src/cli/commands.ts`:

```ts
import { writeFileSync } from 'node:fs';
import { computeTool, verifyTool } from '../server/tools.js';
import { plotToSvg } from '../server/tools/plot/render.js';
import { giacEngine } from '../server/giac/index.js';
import type { ComputeCommand, VerifyCommand, PlotCommand } from './parse.js';
import { renderCompute, renderVerify, renderPlotMeta, resultText } from './render.js';

/** Reads the whole of stdin, for when the expression is piped in. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').trim();
}

/**
 * Resolves the expression from the positional argument or stdin.
 *
 * Never blocks on an interactive terminal: with no argument and a TTY on stdin
 * there is nothing coming, so say so instead of hanging.
 */
async function resolveInput(positional: string | undefined, label: string): Promise<string> {
  if (positional !== undefined && positional !== '') return positional;
  if (process.stdin.isTTY) {
    throw new Error(`no ${label} given — pass it as an argument or pipe it on stdin`);
  }
  const piped = await readStdin();
  if (piped === '') throw new Error(`no ${label} given on stdin`);
  return piped;
}

async function runCompute(cmd: ComputeCommand): Promise<number> {
  const problem = await resolveInput(cmd.expression, 'expression');

  // quiet reads the envelope's display field, so it needs the json format too.
  const format = cmd.output === 'text' ? 'text' : cmd.output === 'latex' ? 'latex' : 'json';

  // The casts are narrowing, not silencing: parse.ts already validated these
  // against the same enums the zod schema declares, so the strings are known
  // to be members. Do not weaken them to `as never` or `as any`.
  const result = await computeTool({
    problem,
    ...(cmd.domain !== undefined
      ? { domain: cmd.domain as 'real' | 'complex' | 'numeric' | 'exact' }
      : {}),
    ...(cmd.precision !== undefined ? { precision: cmd.precision } : {}),
    format: format as 'text' | 'latex' | 'json',
  });

  if (result.isError) {
    console.error(resultText(result));
    return 1;
  }

  console.log(renderCompute(result, cmd.output));
  return 0;
}

async function runVerify(cmd: VerifyCommand): Promise<number> {
  const claim = await resolveInput(cmd.claim, 'claim');

  // Always json, in every mode: the verdict drives the exit code and must come
  // from a typed field. Text mode's human-readable layout is produced by the
  // tool's own formatter inside renderVerify, so nothing parses text back.
  const result = await verifyTool({
    claim,
    ...(cmd.method !== undefined ? { method: cmd.method } : {}),
    format: 'json',
  });

  if (result.isError) {
    console.error(resultText(result));
    return 1;
  }

  const { out, verified } = renderVerify(result, cmd.output);
  console.log(out);
  return verified ? 0 : 2;
}

async function runPlot(cmd: PlotCommand): Promise<number> {
  const expression = await resolveInput(cmd.expression, 'expression');

  const result = plotToSvg({
    expression,
    ...(cmd.variable !== undefined ? { variable: cmd.variable } : {}),
    ...(cmd.xMin !== undefined ? { xMin: cmd.xMin } : {}),
    ...(cmd.xMax !== undefined ? { xMax: cmd.xMax } : {}),
    ...(cmd.yMin !== undefined ? { yMin: cmd.yMin } : {}),
    ...(cmd.yMax !== undefined ? { yMax: cmd.yMax } : {}),
    ...(cmd.width !== undefined ? { width: cmd.width } : {}),
    ...(cmd.height !== undefined ? { height: cmd.height } : {}),
    ...(cmd.title !== undefined ? { title: cmd.title } : {}),
  });

  if (cmd.out !== undefined) {
    writeFileSync(cmd.out, result.svg, 'utf8');
    if (cmd.output === 'json') console.log(renderPlotMeta(result, cmd.out));
    else if (cmd.output === 'quiet') console.log(cmd.out);
    else console.log(`Wrote ${cmd.out} — f(${result.variable}) = ${result.expression}`);
    return 0;
  }

  // No -o: the SVG itself is the output, which only makes sense when piped.
  if (process.stdout.isTTY) {
    throw new Error('refusing to write SVG to a terminal — use -o <file> or pipe stdout');
  }
  if (cmd.output === 'json') console.log(renderPlotMeta(result, null));
  else process.stdout.write(result.svg);
  return 0;
}

/**
 * Runs one subcommand and returns the process exit code.
 *
 * Giac is initialised here rather than at import time so `--help` and
 * `--version` do not pay for a worker fork they never use. `plot` is mathjs
 * only, so it skips the engine entirely.
 */
export async function runCommand(
  cmd: ComputeCommand | VerifyCommand | PlotCommand
): Promise<number> {
  if (cmd.kind === 'plot') return runPlot(cmd);

  await giacEngine.initialize();
  return cmd.kind === 'compute' ? runCompute(cmd) : runVerify(cmd);
}
```

- [ ] **Step 2: Write the unit test**

Create `test/cli-commands.test.ts`. It drives `runCommand` against the **real**
tools — this repo has no mocking anywhere and introducing it here would let the
mocks drift from the handlers. Real Giac costs ~300 ms per case, which is in
line with the existing suite.

```ts
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../src/cli/commands.js';
import { giacEngine } from '../src/server/giac/index.js';

let out: string[] = [];
let err: string[] = [];
let workdir: string;

beforeAll(async () => {
  await giacEngine.initialize();
  workdir = mkdtempSync(join(tmpdir(), 'axiom-cmd-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  out = [];
  err = [];
});

/** Captures what the command writes, so we assert on stdout/stderr separately. */
function capture(): void {
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    err.push(a.map(String).join(' '));
  });
}

describe('runCommand — compute', () => {
  it('prints the value and exits 0 in quiet mode', async () => {
    capture();
    const code = await runCommand({ kind: 'compute', expression: 'solve(x^2-4=0,x)', output: 'quiet' });
    expect(code).toBe(0);
    expect(out.join('\n').trim()).toBe('{-2, 2}');
  }, 30_000);

  it('exits 1 on a bad expression and writes nothing to stdout', async () => {
    capture();
    const code = await runCommand({ kind: 'compute', expression: 'integrate(', output: 'text' });
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err.length).toBeGreaterThan(0);
  }, 30_000);
});

describe('runCommand — verify', () => {
  it('exits 0 for a true claim', async () => {
    capture();
    const code = await runCommand({ kind: 'verify', claim: 'sin(x)^2+cos(x)^2 = 1', output: 'quiet' });
    expect(code).toBe(0);
    expect(out.join('').trim()).toBe('true');
  }, 30_000);

  it('exits 2 for a false claim', async () => {
    capture();
    const code = await runCommand({ kind: 'verify', claim: 'sin(x)^2+cos(x)^2 = 2', output: 'quiet' });
    expect(code).toBe(2);
    expect(out.join('').trim()).toBe('false');
  }, 30_000);

  it('text mode still reports the verdict through the exit code', async () => {
    capture();
    const code = await runCommand({ kind: 'verify', claim: 'sin(x)^2+cos(x)^2 = 2', output: 'text' });
    expect(code).toBe(2);
    expect(out.join('\n')).toContain('Verified: FALSE');
  }, 30_000);
});

describe('runCommand — plot', () => {
  it('writes the file and prints its path in quiet mode', async () => {
    capture();
    const target = join(workdir, 'p.svg');
    const code = await runCommand({ kind: 'plot', expression: 'sin(x)', out: target, output: 'quiet' });
    expect(code).toBe(0);
    expect(out.join('').trim()).toBe(target);
    expect(readFileSync(target, 'utf8').startsWith('<svg')).toBe(true);
  }, 30_000);
});
```

Add a cleanup for the temp directory at the end of the file:

```ts
import { afterAll } from 'vitest';

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});
```

- [ ] **Step 3: Run the tests**

Run: `npx vitest run test/cli-commands.test.ts`
Expected: PASS, 6 tests.

Run: `npm run typecheck`
Expected: no output, exit 0.

Run: `npm test`
Expected: the Task 5 count plus 6.

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands.ts test/cli-commands.test.ts
git commit -m "feat(cli): compute, verify and plot subcommands

Giac is initialised lazily so --help and --version do not fork a worker,
and plot skips it entirely (mathjs only). stdin is read when no
positional argument is given, but never on an interactive terminal."
```

---

### Task 7: The dispatcher, and the backwards-compatibility guarantee

**Files:**
- Modify: `src/cli.ts` (full rewrite)
- Create: `test/cli-contract.test.ts`
- Modify: `vitest.config.ts` (add to `exclude`)
- Modify: `vitest.config.integration.ts` (add to `include`)

**Interfaces:**
- Consumes: `parseArgs`, `UsageError`, `USAGE` (Task 4); `runCommand` (Task 6); `startStdioServer` from `src/server/transports/stdio.js`; `VERSION` from `src/version.js`.

- [ ] **Step 1: Rewrite the entrypoint**

Replace the entire contents of `src/cli.ts` with:

```ts
#!/usr/bin/env node
import { startStdioServer } from './server/transports/stdio.js';
import { parseArgs, UsageError, USAGE } from './cli/parse.js';
import { runCommand } from './cli/commands.js';
import { VERSION } from './version.js';

/**
 * Single entry point for both surfaces.
 *
 * No arguments starts the MCP stdio server — the behaviour every MCP client
 * config depends on, unchanged. A subcommand runs that computation and exits.
 *
 * There is deliberately only one `bin`: two bins whose names do not match the
 * package name make `npx -y axiom-advanced-math-mcp` fail outright with
 * "could not determine executable to run", and that is the line in every MCP
 * client config.
 */
async function main(): Promise<number> {
  let command;
  try {
    command = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`axiom-mcp: ${err.message}\n`);
      console.error(USAGE);
      return 1;
    }
    throw err;
  }

  switch (command.kind) {
    case 'help':
      // Help is requested output, so it goes to stdout.
      console.log(USAGE);
      return 0;

    case 'version':
      console.log(VERSION);
      return 0;

    case 'server':
      if (process.stdin.isTTY) {
        // A human ran this by hand. stdout belongs to the protocol, so the hint
        // goes to stderr where it cannot corrupt a client's stream.
        console.error(
          'axiom-mcp: starting as an MCP stdio server (waiting for JSON-RPC on stdin).\n' +
            'For one-off computations try: axiom-mcp compute \'2+2\'   ·   axiom-mcp --help'
        );
      }
      await startStdioServer();
      // The server owns the process from here; it exits on transport close.
      return -1;

    default:
      return runCommand(command);
  }
}

main()
  .then((code) => {
    if (code >= 0) process.exit(code);
  })
  .catch((err) => {
    console.error(`axiom-mcp: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
```

- [ ] **Step 2: Write the integration test**

Create `test/cli-contract.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERSION } from '../src/version.js';

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the built CLI with the given args, optionally piping stdin. */
async function cli(args: string[], stdin?: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['dist/cli.js', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

let workdir: string;

beforeAll(() => {
  if (!existsSync('dist/cli.js')) {
    throw new Error('dist/cli.js missing — run `npm run build` before the integration suite');
  }
  workdir = mkdtempSync(join(tmpdir(), 'axiom-cli-'));
});

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('CLI — the MCP server still starts with no arguments', () => {
  // THE critical test: adding CLI mode must not break any existing MCP client
  // config, all of which invoke the bin with no arguments.
  it('completes an MCP initialize handshake over stdio', async () => {
    const child = spawn('node', ['dist/cli.js'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));

    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'cli-contract', version: '1.0.0' },
        },
      }) + '\n'
    );

    const response = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no MCP response within 20s')), 20_000);
      child.stdout.on('data', () => {
        const line = out.split('\n').find((l) => l.includes('"result"'));
        if (line) {
          clearTimeout(timer);
          resolve(line);
        }
      });
    });

    child.kill('SIGKILL');
    const parsed = JSON.parse(response.replace(/^data:\s*/, ''));
    expect(parsed.result.serverInfo.name).toBe('axiom-advanced-math-mcp');
  }, 30_000);
});

describe('CLI — compute', () => {
  it('computes and exits 0', async () => {
    const r = await cli(['compute', 'integrate(sin(x)^3,x)']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('-cos(x)+cos(x)^3/3');
  }, 30_000);

  it('-q prints exactly the value and nothing else', async () => {
    const r = await cli(['compute', '-q', 'solve(x^2-4=0,x)']);
    expect(r.code).toBe(0);
    // The contract a skill builds on: one line, no decoration.
    expect(r.stdout.trim()).toBe('{-2, 2}');
  }, 30_000);

  it('--json emits a parseable envelope', async () => {
    const r = await cli(['compute', '--json', 'solve(x^2-4=0,x)']);
    expect(r.code).toBe(0);
    const envelope = JSON.parse(r.stdout);
    expect(envelope.success).toBe(true);
    expect(envelope.display).toBe('{-2, 2}');
  }, 30_000);

  it('reads the expression from stdin', async () => {
    const r = await cli(['compute', '-q'], 'diff(x^3,x)\n');
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('3*x^2');
  }, 30_000);

  it('exits 1 on a bad expression and keeps stdout clean', async () => {
    const r = await cli(['compute', 'integrate(']);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).not.toBe('');
  }, 30_000);
});

describe('CLI — verify', () => {
  it('exits 0 for a true claim', async () => {
    const r = await cli(['verify', 'sin(x)^2+cos(x)^2 = 1']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Verified: TRUE');
  }, 30_000);

  it('exits 2 for a false claim', async () => {
    const r = await cli(['verify', 'sin(x)^2+cos(x)^2 = 2']);
    expect(r.code).toBe(2);
  }, 30_000);

  it('--json exposes the verified field', async () => {
    const r = await cli(['verify', '--json', 'sin(x)^2+cos(x)^2 = 1']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).verified).toBe(true);
  }, 30_000);

  it('-q prints just the boolean', async () => {
    const r = await cli(['verify', '-q', 'sin(x)^2+cos(x)^2 = 2']);
    expect(r.code).toBe(2);
    expect(r.stdout.trim()).toBe('false');
  }, 30_000);
});

describe('CLI — plot', () => {
  it('writes an SVG file', async () => {
    const target = join(workdir, 'wave.svg');
    const r = await cli(['plot', 'sin(x)', '-o', target]);
    expect(r.code).toBe(0);
    expect(readFileSync(target, 'utf8').startsWith('<svg')).toBe(true);
  }, 30_000);

  it('-q prints the path it wrote', async () => {
    const target = join(workdir, 'quiet.svg');
    const r = await cli(['plot', 'sin(x)', '-o', target, '-q']);
    expect(r.stdout.trim()).toBe(target);
  }, 30_000);

  it('--json describes the file', async () => {
    const target = join(workdir, 'meta.svg');
    const r = await cli(['plot', 'sin(x)', '-o', target, '--json']);
    const meta = JSON.parse(r.stdout);
    expect(meta.ok).toBe(true);
    expect(meta.path).toBe(target);
    expect(meta.x_range).toEqual([-10, 10]);
  }, 30_000);

  it('writes the SVG to stdout when stdout is not a TTY and no -o is given', async () => {
    const r = await cli(['plot', 'sin(x)']);
    expect(r.code).toBe(0);
    expect(r.stdout.startsWith('<svg')).toBe(true);
  }, 30_000);
});

describe('CLI — meta', () => {
  it('--version matches the package version', async () => {
    const r = await cli(['--version']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(VERSION);
  });

  it('--help exits 0 and writes usage to stdout', async () => {
    const r = await cli(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('axiom-mcp compute');
  });

  it('rejects an unknown subcommand with usage on stderr, not stdout', async () => {
    const r = await cli(['frobnicate']);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('unknown command');
  });

  it('rejects conflicting output modes', async () => {
    const r = await cli(['compute', '2+2', '--json', '-q']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('mutually exclusive');
  });
});
```

- [ ] **Step 3: Register the file in the integration config**

In `vitest.config.integration.ts`, add `'test/cli-contract.test.ts'` to the `include` array.

- [ ] **Step 4: Keep it out of the unit suite**

In `vitest.config.ts`, add `'test/cli-contract.test.ts'` to the `exclude` array.

- [ ] **Step 5: Build and run the integration suite**

```bash
npm run build && npx vitest run --config vitest.config.integration.ts
```

Expected: all suites pass. The CLI file adds roughly 20 cases; each subcommand invocation costs ~300 ms.

- [ ] **Step 6: Run everything**

Run: `npm test`
Expected: the Task 5 count, unchanged (`cli-contract` is excluded here).

Run: `npm run typecheck`
Expected: no output, exit 0.

Run: `npx oxlint src`
Expected: `Found 0 warnings and 0 errors.`

- [ ] **Step 7: Confirm the MCP invocation still works from a packed tarball**

This is the guarantee that matters most, checked the way a user would hit it:

```bash
npm pack --pack-destination /tmp/axiom-cli-check
mkdir -p /tmp/axiom-cli-check/app && cd /tmp/axiom-cli-check/app
npm init -y >/dev/null && npm install ../axiom-advanced-math-mcp-0.2.0.tgz
npx axiom-mcp compute -q '2+2'
cd - >/dev/null
```

Expected: prints `4`. Then confirm the server mode still answers by piping an initialize message:

```bash
cd /tmp/axiom-cli-check/app
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' | npx axiom-mcp | head -c 200
cd - >/dev/null
rm -rf /tmp/axiom-cli-check
```

Expected: a JSON-RPC response containing `"serverInfo"`.

- [ ] **Step 8: Commit**

```bash
git add src/cli.ts test/cli-contract.test.ts vitest.config.ts vitest.config.integration.ts
git commit -m "feat(cli): dispatch on arguments, keeping the MCP server default

No arguments still starts the MCP stdio server, byte for byte — the
integration suite proves it with a real initialize handshake, because
every existing client config depends on it. A subcommand runs one
computation and exits with 0/1/2.

When a human runs it bare on a TTY, a hint goes to stderr instead of the
process hanging with no explanation. stdout stays protocol-only."
```

---

### Task 8: Skill definition and README

**Files:**
- Create: `skills/axiom-math/SKILL.md`
- Modify: `README.md`
- Modify: `package.json` (`files`)

- [ ] **Step 1: Write the skill**

Create `skills/axiom-math/SKILL.md`:

```markdown
---
name: axiom-math
description: Use when a task needs mathematics that must be exact rather than estimated — symbolic integration or differentiation, solving equations, factoring, limits, series, matrix algebra, combinatorics, or checking whether a mathematical claim is actually true. Runs a computer algebra system (Giac/Xcas) locally via a CLI, so results are computed rather than recalled.
---

# Axiom — exact mathematics from the shell

LLMs are unreliable at symbolic algebra and multi-step arithmetic. This runs a
real CAS instead. Every command exits non-zero on failure, so you can trust the
exit code.

## Compute

```bash
npx -y axiom-advanced-math-mcp compute 'integrate(sin(x)^3,x)'
```

Full output includes the result, its LaTeX, the CAS command used, and a
verification line. For one value to put in a variable:

```bash
ANSWER=$(npx -y axiom-advanced-math-mcp compute -q 'solve(x^2-4=0,x)')   # {-2, 2}
```

For structured output:

```bash
npx -y axiom-advanced-math-mcp compute --json 'solve(x^2-4=0,x)'
```

```json
{ "success": true, "result_type": "set", "display": "{-2, 2}",
  "latex": "\\{-2,2\\}", "data": { "solutions": ["-2", "2"], "count": 2 },
  "method": "solve_equation", "giac_command": "solve(x^2-4=0,x)",
  "verification": { "status": "verified", "check": "(substitution: 2/2 roots satisfy the equation)" } }
```

Options: `--domain real|complex|numeric|exact`, `--precision 1..50`,
`--latex` for LaTeX-focused text.

## Verify

Checks a claim independently. **Exit code carries the verdict:** `0` verified,
`2` not verified, `1` could not run.

```bash
npx -y axiom-advanced-math-mcp verify 'sin(x)^2+cos(x)^2 = 1' && echo "holds"
npx -y axiom-advanced-math-mcp verify -q 'diff(x^3,x) = 3*x^2'   # true
npx -y axiom-advanced-math-mcp verify --json 'x=2 satisfies x^2-4=0'
```

## Plot

```bash
npx -y axiom-advanced-math-mcp plot 'sin(x)' -o wave.svg
```

Options: `--variable`, `--x-min`, `--x-max`, `--y-min`, `--y-max`, `--width`,
`--height`, `--title`. Without `-o` the SVG goes to stdout, so it can be piped.

## Notes

- Expressions can be piped instead of quoted, which avoids shell-escaping pain:
  `echo 'diff(x^3,x)' | npx -y axiom-advanced-math-mcp compute -q`
- **The first invocation downloads about 3.8 MB** (the CAS engine, compiled to
  WebAssembly) and takes a few seconds. Later calls come from the npx cache and
  take roughly 300 ms.
- `AXIOM_EVAL_TIMEOUT_MS` bounds a single evaluation; the default is 10000.
- Syntax is Giac/Xcas: `int(...)`, `diff(...)`, `limit(...)`, `taylor(...)`,
  `factor(...)`, `expand(...)`, `det([[1,2],[3,4]])`, `C(10,3)`, `ifactor(2310)`.
```

- [ ] **Step 2: Ship the skill in the package**

In `package.json`, add `"skills"` to the `files` array so the skill travels with the published package:

```json
  "files": [
    "dist",
    "scripts",
    "skills",
    "README.md",
    "LICENSE",
    "THIRD-PARTY-NOTICES.md",
    "SECURITY.md"
  ]
```

- [ ] **Step 3: Document the CLI in the README**

In `README.md`, immediately after the `### CLI (STDIO Transport)` section (which documents MCP client usage), add:

````markdown
### Command line

The same binary works as a one-shot CLI, so agents can use it as a skill with no
MCP configuration. With no arguments it is the MCP server; with a subcommand it
runs one computation and exits.

```bash
npx -y axiom-advanced-math-mcp compute 'integrate(sin(x)^3,x)'
npx -y axiom-advanced-math-mcp compute -q 'solve(x^2-4=0,x)'     # {-2, 2}
npx -y axiom-advanced-math-mcp verify 'sin(x)^2+cos(x)^2 = 1'    # exit 0 if true
npx -y axiom-advanced-math-mcp plot 'sin(x)' -o wave.svg
echo 'diff(x^3,x)' | npx -y axiom-advanced-math-mcp compute -q   # 3*x^2
```

| Flag | Meaning |
| --- | --- |
| `-q` | print one value only, for scripting |
| `--json` | structured output |
| `--latex` | LaTeX-focused text (`compute` only) |
| `-h`, `--help` | usage, or usage for a subcommand |

Exit codes: `0` success · `1` tool or usage error · `2` `verify` ran and the
claim was **not** verified.

A ready-to-use agent skill is in [skills/axiom-math/SKILL.md](skills/axiom-math/SKILL.md).
````

- [ ] **Step 4: Verify the skill's examples actually work**

Every command in the skill file must run. Check the four load-bearing ones against the build:

```bash
npm run build
node dist/cli.js compute -q 'solve(x^2-4=0,x)'
node dist/cli.js verify -q 'diff(x^3,x) = 3*x^2'
echo 'diff(x^3,x)' | node dist/cli.js compute -q
node dist/cli.js plot 'sin(x)' -o /tmp/axiom-skill-check.svg && head -c 20 /tmp/axiom-skill-check.svg && rm /tmp/axiom-skill-check.svg
```

Expected: `{-2, 2}`, `true`, `3*x^2`, and an SVG beginning `<svg`. Fix the skill file if any example's output differs from what it claims.

- [ ] **Step 5: Confirm the package contents**

Run: `npm pack --dry-run 2>&1 | grep -E "SKILL|total files"`
Expected: `skills/axiom-math/SKILL.md` is listed.

- [ ] **Step 6: Commit**

```bash
git add skills/axiom-math/SKILL.md README.md package.json
git commit -m "docs(cli): agent skill definition and README section

The skill file doubles as living documentation: its examples are verified
against the build, so a broken one is noticed by whoever uses it rather
than rotting in a README."
```

---

## Done criteria

- `npm test` green; `npx vitest run --config vitest.config.integration.ts` green.
- `npx axiom-mcp compute -q '2+2'` prints `4` from a packed, installed tarball.
- Piping an `initialize` message into `npx axiom-mcp` with no arguments still returns `serverInfo` — proven from the tarball, not only in-repo.
- `verify` exits `0`/`2`/`1` for verified / not verified / error.
- `grep -c "" package.json` shows no new dependency: `npm ls --omit=dev --all` reports the same package count as before this branch.
- Every command in `skills/axiom-math/SKILL.md` produces the output it claims.
