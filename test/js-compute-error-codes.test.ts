import { describe, it, expect } from 'vitest';
import {
  createJsComputeHost,
  JsComputeError,
  type JsComputeErrorCode,
} from '../src/server/js-compute/index.js';

/**
 * The js-compute failure taxonomy, pinned.
 *
 * `JsComputeErrorCode` shipped with no consumer outside its own directory:
 * nothing in `src/` read a code except js-compute's own relay (host.ts reads
 * `msg.code`, worker.ts reads `e.code` to put it on the message), and no test read
 * one at all. Every existing failure-path test matched the prose instead — some of
 * it deliberately loose (`/memory budget|stopped unexpectedly/`, `/budget|response
 * limit/`), which cannot tell one failure mode from another. So the codes asserted
 * nothing, and the one place that branches on a code (that relay) was unguarded.
 *
 * The caller-facing narrowing helper was deleted — the tool boundary is text and
 * cannot carry a code, see errors.ts. These rows exercise the field that stayed:
 * every one of the six codes is produced by a real path and read back off the
 * rejection, so a reworded message no longer changes what a test proves.
 *
 * NOT every construction site, and the gap is worth naming rather than implying
 * that any mislabelled failure fails here. host.ts builds a `JsComputeError` at
 * ten sites. These rows observe the code from six of them — seven outcomes, since
 * the relay ternary has two arms, which is how six sites cover all six codes. The
 * remaining four never have their code observed, so relabelling any of them
 * leaves the suite green. One is `busy` and three are `worker_failed`:
 *
 *   - the admission timer's `busy`. This one needs no seam: its message says
 *     "was busy" where site 407 says "is busy", so the public API already tells
 *     the two apart. What is missing is a way to TRIGGER it — two calls landing
 *     inside one ack latency — and host.ts documents that site as blaming the
 *     wrong caller anyway, so a row pinning it would pin a known defect;
 *   - the protocol-mismatch `worker_failed` — needs a worker that answers with no
 *     value, and the host forks a fixed path;
 *   - `c.on('error')`'s `worker_failed` — needs the fork or the IPC channel to
 *     fail;
 *   - the non-OOM exit `worker_failed`, which is the odd one: it EXECUTES three
 *     times on the MAX_REDISPATCHES row below, but its error is never delivered.
 *     A child that dies before its `start` ack leaves `runningEntry()` undefined,
 *     so recycleAndRedispatch has no culprit to settle and requeues instead. Not,
 *     as an earlier version of this comment said, because `handleFault` returned
 *     early — that happens on the timeout and dispose routes, where the culprit is
 *     already settled by the time the kill's own `exit` arrives.
 *
 * Only the middle two need an injectable worker, which would change host.ts's
 * production shape to guard a label nothing branches on — so it waits for the day
 * a code becomes caller-facing. The admission `busy` needs a scheduling lever
 * instead, and the non-OOM exit needs the host to keep an error it currently has
 * no one to blame for.
 */

/** The code on a rejection, or the reason it has none. */
async function codeOf(run: Promise<unknown>): Promise<JsComputeErrorCode | string> {
  try {
    await run;
    return 'resolved-without-error';
  } catch (e) {
    if (!(e instanceof JsComputeError)) {
      return `not-a-JsComputeError: ${e instanceof Error ? e.name : typeof e}`;
    }
    return e.code;
  }
}

describe('every failure the worker host reports carries the right code', () => {
  it('refuses past the queue depth as `busy`', async () => {
    // maxQueueDepth 0 makes run() refuse synchronously on the first call, which
    // is the `busy` site in run() itself. The other `busy` site (the admission
    // timer in armAdmission) is deliberately not covered: host.ts documents it
    // as blaming the wrong caller, and reproducing it needs two calls to land
    // inside one ack latency of each other.
    const host = createJsComputeHost({ maxQueueDepth: 0 });
    try {
      await expect(codeOf(host.run('bell_number', { n: 5 }))).resolves.toBe('busy');
    } finally {
      await host.dispose();
    }
  });

  it('labels a computation that outlives its budget `timeout`', async () => {
    const host = createJsComputeHost({ timeoutMs: 50 });
    try {
      await expect(codeOf(host.run('bell_number', { n: 100000 }))).resolves.toBe('timeout');
    } finally {
      await host.dispose();
    }
  }, 30_000);

  it('labels a shutdown with a call in flight `worker_failed`', async () => {
    const host = createJsComputeHost({ timeoutMs: 30_000 });
    // bell_number(100000) takes minutes, so it is still pending when dispose
    // fails everything outstanding. Nothing here depends on how long the fork
    // takes: dispose() settles queued entries as well as running ones.
    const inFlight = host.run('bell_number', { n: 100000 });
    const code = codeOf(inFlight);
    await host.dispose();
    await expect(code).resolves.toBe('worker_failed');
  }, 60_000);

  it('labels a worker that will not start at all `worker_failed`, after retrying', async () => {
    // Reaches MAX_REDISPATCHES, which needs three consecutive worker deaths with
    // the call still queued. A non-integer heapMb is the lever: Node rejects
    // `--max-old-space-size=NaN` outright, so the child exits code 9 before its
    // `start` ack, leaving no culprit to blame — the call is requeued, dies twice
    // more, and the third death abandons it. 49ms, and the message is unique to
    // that site.
    //
    // The lever is a pre-existing validation gap, not a feature: `defaultHeapMb`
    // accepts any finite positive number, so `AXIOM_JS_COMPUTE_HEAP_MB=1.5` fails
    // every computation in ~50ms and blames the worker rather than the operator's
    // env. If that gets validated — it should be — this row needs a new lever, and
    // whoever validates it should expect to land here.
    const host = createJsComputeHost({ heapMb: Number.NaN, timeoutMs: 30_000 });
    try {
      const run = host.run('bell_number', { n: 5 });
      await expect(codeOf(run)).resolves.toBe('worker_failed');
      await expect(run).rejects.toThrow(/restarted repeatedly/);
    } finally {
      await host.dispose();
    }
  }, 60_000);

  it('labels a heap death `out_of_memory`, not a bare worker fault', async () => {
    // The axis no input ceiling expressed: cost is the WIDTH of the BigInts.
    // Under a 32MB heap the child aborts, and host.ts maps SIGABRT (or exit 134)
    // to `out_of_memory` — the mapping this row exists to pin. A death by any
    // other signal would arrive as `worker_failed`, which is why the existing
    // prose test for this path had to accept either message.
    //
    // timeoutMs is deliberately far above what the heap death needs (~8s idle),
    // because the two bounds RACE: whichever fires first names the failure, and
    // this row is about the memory one. The sibling test in input-bounds.test.ts
    // uses 30s and loses that race under a loaded machine — three agents running
    // suites at once was enough — reporting `the computation exceeded its time
    // budget` instead. Widening the budget removes the race rather than
    // weakening the assertion; a genuinely wedged child still fails on the
    // per-test timeout below.
    const host = createJsComputeHost({ timeoutMs: 150_000, heapMb: 32 });
    try {
      await expect(codeOf(host.run('stirling_first', { n: 60000, k: 20000 }))).resolves.toBe(
        'out_of_memory'
      );
    } finally {
      await host.dispose();
    }
  }, 300_000);
});

describe("the worker's own code survives the relay to the host", () => {
  // host.ts reads `result_too_large` off the IPC result and collapses everything
  // else to `evaluation_failed`. Both directions are pinned: pinning the ternary
  // to either constant fails the rows on the other side — two of them one way,
  // three the other, counting the unknown-task row below.
  it.each<[string, string, JsComputeErrorCode]>([
    // Refused by refuseIfTooManyElements before anything is stringified.
    ['an oversized range', '1:200000', 'result_too_large'],
    // Refused by the LaTeX depth check — a different throw site, same code.
    [
      'an expression nested too deeply to render',
      'sqrt('.repeat(40) + '2' + ')'.repeat(40),
      'result_too_large',
    ],
    // The task's own JsComputeError, already labelled `evaluation_failed`. The
    // host reaches the same answer via its fallback, so this row alone cannot
    // tell the task's label from the host's — the in-process rows below are what
    // pin the label the task actually attaches.
    ['a NaN result', '0/0', 'evaluation_failed'],
    // A plain mathjs SyntaxError: it reaches the host with NO code, and the
    // host's fallback is what supplies one.
    ['a parse error', '2+*3', 'evaluation_failed'],
  ])(
    'reports %s as `%s` -> %s',
    async (_what, expression, expected) => {
      const host = createJsComputeHost({ timeoutMs: 30_000 });
      try {
        await expect(
          codeOf(host.run('mathjs_evaluate', { expression, latex: true }))
        ).resolves.toBe(expected);
      } finally {
        await host.dispose();
      }
    },
    60_000
  );

  it('reports an unknown task as `evaluation_failed`, not as a worker fault', async () => {
    // The worker answers with a result-shaped error and no code. It is not a
    // worker fault: the child is healthy and still serving the next call.
    const host = createJsComputeHost({ timeoutMs: 30_000 });
    try {
      const run = host.run('not_a_task' as Parameters<typeof host.run>[0], {});
      await expect(codeOf(run)).resolves.toBe('evaluation_failed');
      await expect(host.run('bell_number', { n: 5 })).resolves.toBe('52');
    } finally {
      await host.dispose();
    }
  }, 60_000);
});

describe('the codes stay an internal label', () => {
  it('does not escape the module: the js-compute barrel exports no narrowing helper', async () => {
    // The deleted helper existed for "callers that branch on it" and had none.
    // This row refuses re-adding it UNDER THIS NAME — it pins one string, not the
    // shape, so a rename with no caller would still slip past. It is a signpost
    // for the next reader: a code reaches a client through a ComputeEnvelope
    // field, not through a predicate no boundary can call.
    const barrel: Record<string, unknown> = await import('../src/server/js-compute/index.js');
    expect(Object.keys(barrel)).not.toContain('jsComputeErrorCode');
    // Asserted against the same key set as the line above, not as
    // `barrel.JsComputeError === JsComputeError`: this file imports the class
    // FROM that barrel, so comparing it to itself cannot fail — and if the export
    // were dropped, vite's SSR transform yields `undefined` on the property
    // access, so the comparison would pass as undefined === undefined.
    expect(Object.keys(barrel)).toContain('JsComputeError');
  });
});

describe('a task labels its own refusal, in-process', () => {
  // Needed because the host re-decides: its relay honours only
  // `result_too_large` and collapses every other worker code to
  // `evaluation_failed`, so across IPC a task's own `evaluation_failed` label is
  // indistinguishable from having sent no code at all. Mutating that label to
  // `worker_failed` left the whole cross-process suite green. Calling the task
  // directly is the only place the label it attaches is observable.
  it.each<[string, string, JsComputeErrorCode]>([
    ['a NaN result', '0/0', 'evaluation_failed'],
    ['an oversized range', '1:200000', 'result_too_large'],
  ])('labels %s `%s` -> %s', async (_what, expression, expected) => {
    const { MATHJS_TASKS } = await import('../src/server/js-compute/mathjs-tasks.js');
    let thrown: unknown;
    try {
      MATHJS_TASKS.mathjs_evaluate({ expression });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(JsComputeError);
    expect((thrown as JsComputeError).code).toBe(expected);
  });
});
