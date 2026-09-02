import { createJsComputeHost } from './host.js';
import type { TaskName, TaskArgs } from './tasks.js';
import type {
  MathJsTaskName,
  MathJsTaskArgs,
  EvaluatedExpression,
  SampledFunction,
} from './mathjs-tasks.js';

/**
 * The process-wide bounded compute worker.
 *
 * Lazily forked on first use, so a server that never runs one of these
 * computations never pays for the child.
 */
const host = createJsComputeHost();

/** Every task the worker can run, with its argument shape. */
export type AllTaskArgs = TaskArgs & MathJsTaskArgs;

/**
 * Result shape per JSON-returning task.
 *
 * The point of declaring these is that a renamed field now fails `tsc` instead
 * of surfacing at runtime: dropping `numPoints` from a `mathjs_sample` payload
 * used to compile and return a blank plot with no error at all.
 */
export interface TaskResults {
  mathjs_evaluate: EvaluatedExpression;
  mathjs_sample: SampledFunction;
}

/** Runs one bounded computation in the worker, returning its raw string. */
export function runJsCompute<K extends keyof AllTaskArgs>(
  task: K,
  args: AllTaskArgs[K]
): Promise<string> {
  return host.run(task as TaskName | MathJsTaskName, args as Record<string, unknown>);
}

/** As `runJsCompute`, parsing the reply into the task's declared result type. */
export async function runJsComputeJson<K extends keyof TaskResults & keyof AllTaskArgs>(
  task: K,
  args: AllTaskArgs[K]
): Promise<TaskResults[K]> {
  const raw = await runJsCompute(task, args);
  return JSON.parse(raw) as TaskResults[K];
}

export function disposeJsCompute(): Promise<void> {
  return host.dispose();
}

export { createJsComputeHost } from './host.js';
export { TASKS, type TaskName, type TaskArgs } from './tasks.js';
export { JsComputeError, type JsComputeErrorCode } from './errors.js';
export type {
  MathJsTaskName,
  EvaluatedExpression,
  SampledFunction,
  PlotPoint,
  PlotSegment,
} from './mathjs-tasks.js';
