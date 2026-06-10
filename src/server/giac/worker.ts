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
    send({ type: 'result', id: msg.id, error: e instanceof Error ? e.message : String(e) });
  }
});
