import { WasmGiacEngine } from './wasm-wrapper.js';

/**
 * Giac worker (run as a forked child process). Hosts the WASM engine off the
 * MCP server's event loop so a wedged synchronous caseval can never block the
 * server. Communicates with the host over Node's child-process IPC channel.
 */
const engine = new WasmGiacEngine();
const send = (m: unknown): void => {
  process.send?.(m);
};

// When the parent (MCP server / test runner) goes away, the IPC channel
// disconnects — exit so this child never lingers as an orphan.
process.on('disconnect', () => process.exit(0));

const ready = engine
  .initialize()
  .then(() => send({ type: 'ready' }))
  .catch((e) => send({ type: 'init-error', error: e instanceof Error ? e.message : String(e) }));

process.on('message', async (msg: { id: number; expr: string }) => {
  await ready;
  // Deterministic hang hook for watchdog tests — never sent by production code.
  if (msg.expr === '__AXIOM_TEST_HANG__') {
    for (;;) {
      /* block this worker process forever */
    }
  }
  try {
    const result = await engine.evaluate(msg.expr);
    send({ type: 'result', id: msg.id, result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    send({ type: 'result', id: msg.id, error: message });

    // A WASM trap is not recoverable: the instance stays trapped and every
    // later `_caseval` throws the same thing, so one bad expression silently
    // kills the CAS for the life of the process while isReady() keeps
    // reporting true. Exit instead — the host recycles on 'exit' and the next
    // call gets a clean engine. Per-call errors (a Giac syntax error) are
    // ordinary and must NOT take the worker down.
    if (isFatalWasmTrap(message)) {
      process.exit(1);
    }
  }
});

/** Whether an evaluation error left the WASM instance unusable. */
function isFatalWasmTrap(message: string): boolean {
  return (
    /memory access out of bounds/i.test(message) ||
    /unreachable/i.test(message) ||
    /RuntimeError/i.test(message) ||
    /table index is out of bounds/i.test(message)
  );
}
