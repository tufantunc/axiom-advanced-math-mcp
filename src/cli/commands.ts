import { writeFileSync } from 'node:fs';
import { computeTool, verifyTool } from '../server/tools.js';
import { plotToSvg } from '../server/tools/plot/render.js';
import { giacEngine } from '../server/giac/index.js';
import { MAX_EXPRESSION_LENGTH } from '../server/tools/limits.js';
import type { ComputeCommand, VerifyCommand, PlotCommand } from './parse.js';
import { renderCompute, renderVerify, renderPlotMeta, resultText } from './render.js';

/**
 * Byte ceiling on piped input.
 *
 * `MAX_EXPRESSION_LENGTH` is a *character* cap and can only be applied after
 * decoding, so reading first and checking after would let `yes | axiom-math
 * compute` grow the buffer without bound. Four bytes is the widest UTF-8 code
 * point, so this can never reject an input the character cap would accept —
 * anything past it is refused before it is buffered.
 */
const MAX_STDIN_BYTES = MAX_EXPRESSION_LENGTH * 4;

/** Reads the whole of stdin, for when the expression is piped in. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_STDIN_BYTES) {
      throw new Error(`input on stdin exceeds the ${MAX_EXPRESSION_LENGTH}-character limit`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

/**
 * Resolves the expression from the positional argument or stdin.
 *
 * Never blocks on an interactive terminal: with no argument and a TTY on stdin
 * there is nothing coming, so say so instead of hanging.
 *
 * Also enforces the same input-length cap the MCP surface's zod schemas apply
 * (`MAX_EXPRESSION_LENGTH`). The CLI calls the tool handlers directly rather
 * than through the MCP SDK's schema validation, so that cap has to be
 * enforced here — evaluation is bounded out of process, but the preprocessing
 * and routing an expression goes through first run on the event loop.
 */
async function resolveInput(positional: string | undefined, label: string): Promise<string> {
  let value: string;
  if (positional !== undefined && positional !== '') {
    value = positional;
  } else if (process.stdin.isTTY) {
    throw new Error(`no ${label} given — pass it as an argument or pipe it on stdin`);
  } else {
    const piped = await readStdin();
    if (piped === '') throw new Error(`no ${label} given on stdin`);
    value = piped;
  }

  if (value.length > MAX_EXPRESSION_LENGTH) {
    throw new Error(
      `${label} exceeds the ${MAX_EXPRESSION_LENGTH}-character limit (got ${value.length} characters)`
    );
  }
  return value;
}

async function runCompute(cmd: ComputeCommand): Promise<number> {
  const problem = await resolveInput(cmd.expression, 'expression');

  // quiet reads the envelope's display field, so it needs the json format too.
  let format: 'text' | 'latex' | 'json' = 'json';
  if (cmd.output === 'text') format = 'text';
  else if (cmd.output === 'latex') format = 'latex';

  // computeTool takes `Record<string, unknown>`, so these casts buy no
  // checking from the compiler — parse.ts is the only thing that guarantees
  // `domain` and `format` are members of the enums the zod schema declares
  // (DOMAINS in parse.ts, mirrored by hand from computeSchema). They are here
  // to document the contract, not to enforce it; a typo in a key name would
  // compile and arrive as `undefined`.
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

  // verifyHandler's catch block sets isError for anything that escapes its
  // per-strategy handling, so this is a live path, not a defensive one.
  if (result.isError) {
    console.error(resultText(result));
    return 1;
  }

  const { out, verified, evaluated } = renderVerify(result, cmd.output);

  // Exit 2 means "checked, and the claim is false". A claim that could not be
  // parsed or evaluated was not checked at all, so it exits 1 like any other
  // failure to run — otherwise `verify '((('` tells a script the mathematics
  // was refuted. stdout stays clean so nothing captures a bogus verdict.
  if (!evaluated) {
    console.error(`axiom-math: could not check the claim\n${out}`);
    return 1;
  }

  console.log(out);
  return verified ? 0 : 2;
}

async function runPlot(cmd: PlotCommand): Promise<number> {
  const expression = await resolveInput(cmd.expression, 'expression');

  const result = await plotToSvg({
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
    try {
      writeFileSync(cmd.out, result.svg, 'utf8');
    } catch (err) {
      // A raw ENOENT/EACCES from fs names the syscall, not what the user did.
      throw new Error(
        `could not write ${cmd.out}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (cmd.output === 'json') console.log(renderPlotMeta(result, cmd.out));
    else if (cmd.output === 'quiet') console.log(cmd.out);
    else console.log(`Wrote ${cmd.out} — f(${result.variable}) = ${result.expression}`);
    return 0;
  }

  // No -o: --json prints ~200 bytes of metadata either way, so it is exempt
  // from the TTY guard below — only raw SVG on a terminal is refused.
  if (cmd.output === 'json') {
    console.log(renderPlotMeta(result, null));
    return 0;
  }

  // The SVG itself is the output, which only makes sense when piped.
  if (process.stdout.isTTY) {
    throw new Error('refusing to write SVG to a terminal — use -o <file> or pipe stdout');
  }
  process.stdout.write(result.svg);
  return 0;
}

/**
 * Runs one subcommand and returns the process exit code.
 *
 * Giac is initialised here rather than at import time so `--help` and
 * `--version` do not pay for a worker fork they never use. `plot` skips the CAS
 * engine entirely — it still forks the js-compute child, which is where its
 * sampling runs.
 */
export async function runCommand(
  cmd: ComputeCommand | VerifyCommand | PlotCommand
): Promise<number> {
  if (cmd.kind === 'plot') return runPlot(cmd);

  await giacEngine.initialize();
  return cmd.kind === 'compute' ? runCompute(cmd) : runVerify(cmd);
}
