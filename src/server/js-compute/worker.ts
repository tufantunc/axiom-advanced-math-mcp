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

process.on('message', (msg: { id: number; task: TaskName; args: Record<string, unknown> }) => {
  const run = TASKS[msg.task] as ((args: Record<string, unknown>) => string) | undefined;
  if (!run) {
    send({ type: 'result', id: msg.id, error: `unknown task: ${String(msg.task)}` });
    return;
  }
  try {
    send({ type: 'result', id: msg.id, value: run(msg.args) });
  } catch (e) {
    send({ type: 'result', id: msg.id, error: e instanceof Error ? e.message : String(e) });
  }
});

send({ type: 'ready' });
