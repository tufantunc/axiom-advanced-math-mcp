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
