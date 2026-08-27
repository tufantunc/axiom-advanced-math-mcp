import { TASKS, type TaskName } from './tasks.js';

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
 * `require('mathjs')` costs ~143ms and tens of MB, and most tasks here do not
 * need it — a `bell_number` call must not pay for it.
 */
type TaskRegistry = Record<string, (args: Record<string, never>) => string>;

let mathjsTasks: TaskRegistry | null = null;

async function resolveTask(task: string): Promise<TaskRegistry[string] | undefined> {
  const own = (TASKS as unknown as TaskRegistry)[task];
  if (own) return own;
  if (!mathjsTasks) {
    const loaded = await import('./mathjs-tasks.js');
    mathjsTasks = loaded.MATHJS_TASKS as unknown as TaskRegistry;
  }
  return mathjsTasks[task];
}

process.on('message', (msg: { id: number; task: TaskName; args: Record<string, unknown> }) => {
  void (async () => {
    try {
      const run = await resolveTask(msg.task);
      if (!run) {
        send({ type: 'result', id: msg.id, error: `unknown task: ${String(msg.task)}` });
        return;
      }
      send({ type: 'result', id: msg.id, value: run(msg.args as Record<string, never>) });
    } catch (e) {
      send({ type: 'result', id: msg.id, error: e instanceof Error ? e.message : String(e) });
    }
  })();
});

send({ type: 'ready' });
