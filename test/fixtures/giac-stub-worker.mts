import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Protocol-speaking stand-in for the Giac worker, forked through the host's
 * workerPath test seam. Serves one marker input as a fatal trap — answers
 * first, then exits, the shape worker.ts gives a real trap — and, on its
 * SECOND fork only, exits before the handshake.
 *
 * That second-fork death is the compound case the real worker cannot be made
 * to produce: a replacement dying before `ready` while a previous
 * generation's survivors are still in flight. Which fork this is lives in a
 * counter file named by AXIOM_GIAC_STUB_COUNTER (created and removed by the
 * test that sets it).
 */
const counterPath = process.env.AXIOM_GIAC_STUB_COUNTER ?? '/tmp/axiom-giac-stub-counter';
const forkNumber = (existsSync(counterPath) ? Number(readFileSync(counterPath, 'utf8')) : 0) + 1;
writeFileSync(counterPath, String(forkNumber));
if (forkNumber === 2) process.exit(9);

const send = (m: unknown): void => {
  process.send?.(m);
};
process.on('disconnect', () => process.exit(0));
send({ type: 'ready' });
process.on('message', (msg: { id: number; expr: string }) => {
  if (msg.expr === '__STUB_TRAP__') {
    send({
      type: 'result',
      id: msg.id,
      error: 'Giac WASM evaluation error: RuntimeError: memory access out of bounds',
    });
    process.exit(1);
  }
  send({ type: 'result', id: msg.id, result: `stub:${msg.expr}` });
});
