import { createJsComputeHost } from './host.js';
import type { TaskName } from './tasks.js';

/**
 * The process-wide bounded compute worker.
 *
 * Lazily forked on first use, so a server that never runs one of these
 * computations never pays for the child.
 */
const host = createJsComputeHost();

/** Runs one arbitrary-precision computation in the bounded worker. */
export function runJsCompute(task: TaskName, args: Record<string, unknown>): Promise<string> {
  return host.run(task, args);
}

export function disposeJsCompute(): Promise<void> {
  return host.dispose();
}

export { createJsComputeHost } from './host.js';
export { TASKS, type TaskName } from './tasks.js';
