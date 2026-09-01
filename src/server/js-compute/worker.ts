import { TASKS } from './tasks.js';
import { JsComputeError } from './errors.js';
import type { TaskFn, TaskModule } from './task-module.js';

/**
 * Runs one bounded pure-JS computation per message (a forked child process).
 *
 * Nothing here is allowed to be slow-but-recoverable: the host kills this
 * process on timeout, because a synchronous BigInt loop cannot be interrupted
 * any other way. Exhausting the heap likewise kills the child, not the server —
 * that is the whole point of the isolation.
 */
const send = (m: unknown): void => {
  process.send?.(m);
};

// When the parent goes away the IPC channel disconnects — exit rather than
// linger as an orphan holding a large heap.
process.on('disconnect', () => process.exit(0));

/**
 * The mathjs tasks, imported on first use.
 *
 * `require('mathjs')` costs ~170ms and ~50MB, and most tasks here do not need
 * it. The saving is once per worker process, not per call: the child is reused
 * until it faults.
 */
let mathjsTasks: TaskModule | null = null;

async function resolveTask(task: string): Promise<TaskFn | undefined> {
  const own: TaskFn | undefined = TASKS[task as keyof typeof TASKS];
  if (own) return own;
  if (!mathjsTasks) {
    const loaded = await import('./mathjs-tasks.js');
    mathjsTasks = loaded.MATHJS_TASKS;
  }
  return mathjsTasks[task];
}

interface TaskMessage {
  id: number;
  task: string;
  args: Record<string, unknown>;
}

process.on('message', (msg: TaskMessage) => {
  void (async () => {
    try {
      const run = await resolveTask(msg.task);
      if (!run) {
        send({ type: 'result', id: msg.id, error: `unknown task: ${String(msg.task)}` });
        return;
      }
      // Acked before the synchronous body runs, so the host charges the per-call
      // clock to execution rather than to time spent queued behind another call.
      // Resolving the task first is deliberate: a first-use mathjs import is
      // worker setup, not this caller's compute, so it must land before the ack
      // and outside the execution clock. host.ts is what keeps it from being
      // charged to the admission budget instead.
      send({ type: 'start', id: msg.id });
      send({ type: 'result', id: msg.id, value: run(msg.args as never) });
    } catch (e) {
      send({
        type: 'result',
        id: msg.id,
        error: e instanceof Error ? e.message : String(e),
        code: e instanceof JsComputeError ? e.code : undefined,
      });
    }
  })();
});

send({ type: 'ready' });
