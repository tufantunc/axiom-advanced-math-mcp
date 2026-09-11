import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkerHost } from '../src/server/giac/worker-host.js';
import { isFatalWasmTrap } from '../src/server/giac/fatal-trap.js';

describe('giac worker host — watchdog + recycle', () => {
  const host = createWorkerHost({ timeoutMs: 3000 });
  afterAll(async () => {
    await host.dispose();
  });

  it('evaluates normally through the worker', async () => {
    expect(await host.evaluate('diff(x^3, x)')).toBe('3*x^2');
  }, 60000);

  it('times out a wedged evaluation and recovers on the next call', async () => {
    await expect(host.evaluate('__AXIOM_TEST_HANG__')).rejects.toThrow('Giac evaluation timed out');
    // Recycle proof: a fresh worker serves the next call.
    expect(await host.evaluate('1+1')).toBe('2');
  }, 60000);
});

describe('giac worker host — a timeout fails only the call that timed out', () => {
  it('re-dispatches other in-flight calls to the fresh worker instead of failing them', async () => {
    const h = createWorkerHost({ timeoutMs: 6000 });
    try {
      await h.warmup();

      const wedged = h.evaluate('__AXIOM_TEST_HANG__');

      // Enqueue the innocent call well after the wedged one so its own
      // deadline (enqueue + 6 s) sits comfortably past the recycle, which
      // has to fork and initialize a fresh worker before it can be served.
      await new Promise((r) => setTimeout(r, 4000));
      const innocent = h.evaluate('diff(x^3, x)');

      await expect(wedged).rejects.toThrow('Giac evaluation timed out');
      // Pre-fix this rejected too: the timeout called failAllPending(), which
      // rejected every entry in the pending map, not just the offender.
      expect(await innocent).toBe('3*x^2');
    } finally {
      await h.dispose();
    }
  }, 60000);
});

describe('giac worker host — a fatal trap fails only the call that caused it', () => {
  it('the trap call gets its own error; the next call reaches the fresh worker', async () => {
    const h = createWorkerHost({ timeoutMs: 30000 });
    try {
      await h.warmup();

      // Measured: a huge-exponent initial condition traps the WASM engine
      // fatally, so worker.ts answers THIS call with the trap text and only
      // then exits on purpose.
      let trapMessage = '';
      await h.evaluate("desolve([y'=y,y(0)=(2^1000)^1000],x,y)").then(
        () => {
          throw new Error('expected the trap input to throw');
        },
        (e: Error) => {
          trapMessage = e.message;
        }
      );
      // Precondition, pinned: the error must be one the worker treats as
      // fatal, or it stays alive and the exit path below is never exercised.
      // A bare /Giac WASM evaluation error/ match would also accept
      // recoverable throws isFatalWasmTrap exists to keep alive.
      expect(isFatalWasmTrap(trapMessage)).toBe(true);

      // This call is dispatched in the gap between the trap answer and the
      // 'exit' event — a promise continuation always beats the event loop —
      // so on the old exit path it sat in `pending` when failAllPending ran.
      // Pre-fix it was rejected with "Giac worker exited (code 1)", a reason
      // that was not this caller's; it is now re-sent to the fresh worker.
      await expect(h.evaluate("desolve([y'=y,y(0)=1],x,y)")).resolves.toBe('exp(x)');
    } finally {
      await h.dispose();
    }
  }, 60000);
});

describe('giac worker host — a worker that dies before its handshake', () => {
  it('settles waiting calls promptly with the exit it observed, not a 30s init timeout', async () => {
    // workerPath is the seam: a path that cannot start makes the child exit
    // before 'ready', which the real worker cannot be made to do. The two
    // calls share one init (ensureWorker reuses the in-flight promise), so
    // both are awaiting it when the exit lands.
    const h = createWorkerHost({ timeoutMs: 5000, workerPath: '/nonexistent/axiom-worker.ts' });
    try {
      const first = h.evaluate('1+1');
      const second = h.evaluate('2+2');
      // Pre-fix these waited out the 30s init timer ("Giac worker init timed
      // out"); the exit path now settles them with what actually happened.
      // The vitest timeout below is what catches a regression to the 30s
      // wait — the assertions alone never get to run there. The child's
      // module-not-found stack on stderr is the expected noise of the seam.
      await expect(first).rejects.toThrow(/Giac worker exited \(code \d+\)/);
      await expect(second).rejects.toThrow(/Giac worker exited \(code \d+\)/);
    } finally {
      await h.dispose();
    }
  }, 10000);
});

describe('giac worker host — a replacement that dies before its handshake', () => {
  it('keeps the survivors an earlier recycle already re-queued', async () => {
    // Two consecutive deaths with an innocent in flight — the compound case
    // behind the generation-aware stand-down in recycleAndRedispatch's
    // rejection handler. The trap answers, then kills W1; the innocent is
    // dispatched in the gap (a continuation beats the 'exit' event), so W1's
    // exit re-queues it onto W2; W2 dies before ITS handshake, so its exit
    // re-queues the same call onto W3. Without the stand-down, rejecting W2's
    // ready promise also fired the FIRST generation's failSurvivors, which
    // rejected the innocent with "Giac worker exited (code 9)" — a reason
    // that was neither its caller's nor W3's. The real worker cannot be made
    // to die on its second fork; the stub can.
    const dir = mkdtempSync(join(tmpdir(), 'axiom-stub-'));
    process.env.AXIOM_GIAC_STUB_COUNTER = join(dir, 'counter');
    try {
      const h = createWorkerHost({
        timeoutMs: 15000,
        workerPath: fileURLToPath(new URL('fixtures/giac-stub-worker.mts', import.meta.url)),
      });
      try {
        await h.evaluate('__STUB_TRAP__').then(
          () => {
            throw new Error('expected the stub trap to throw');
          },
          () => undefined
        );
        // Dispatched after the trap settled but before 'exit' is processed.
        const innocent = h.evaluate('ping');
        await expect(innocent).resolves.toBe('stub:ping');
      } finally {
        await h.dispose();
      }
    } finally {
      delete process.env.AXIOM_GIAC_STUB_COUNTER;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
