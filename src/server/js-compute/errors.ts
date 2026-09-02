/**
 * Failure causes at the js-compute boundary, as a closed set.
 *
 * An INTERNAL taxonomy, not a caller-facing contract, and the type no longer
 * claims otherwise.
 *
 * Nothing outside this directory branches on a code today, and the tool boundary
 * cannot carry one. Every tool reports a failure as text plus `isError`, and no
 * tool declares an outputSchema, so there is no structured error channel; the
 * compute envelope carries a failure only as prose in `data.error`. Nor does the
 * instance get that far: quick-calc-service.ts re-wraps the rejection in a plain
 * `Error`, combinatorics.ts turns it straight into a text tool response, and the
 * third call site (plot/evaluator.ts, via `runJsComputeJson`) lets it propagate to
 * catches that read `.message`. Either way the code is gone.
 *
 * A `jsComputeErrorCode` narrowing helper for "callers that branch on it" lived
 * here with zero callers from the commit that introduced it, and was deleted
 * rather than left implying a contract the boundary does not carry.
 *
 * Wiring a code out to a client is a `ComputeEnvelope` field for the TWO call
 * sites that route through `compute` — combinatorics and quick_calc are both
 * dispatcher cases, and `format: 'json'` serializes the envelope whole, so no
 * outputSchema is needed. `plot` is not: it is its own registered tool and never
 * reaches `computeHandler`, so plot/evaluator.ts's code would need a structured
 * channel of its own. Do that when a client needs it, and add the field, not the
 * helper. `JsComputeError` and this type stay exported, so nothing is foreclosed.
 *
 * Exactly one place in the product code branches on a code: worker.ts puts
 * `e.code` on the IPC result, and host.ts honours `result_too_large` — a result a
 * task refused on purpose — and nothing else. Any other worker-originated code,
 * and a throw carrying no code at all, arrives as `evaluation_failed`, because
 * only the host can know a timeout or a heap abort. So a task labelling its own
 * refusal `evaluation_failed` states intent and is observable only in-process.
 *
 * Everywhere else the code is simply the label attached where the error is built,
 * so that which failure occurred can be asserted without matching prose.
 * test/js-compute-error-codes.test.ts produces all six that way, and lists the
 * four host construction sites whose code it never observes — one `busy`, three
 * `worker_failed`. Before it no test read a code at all,
 * and the loosest of them accepted either of two messages and so could not tell a
 * heap death from a crash.
 *
 * What did get fixed, and is worth not regressing: the caller-facing prose used
 * to interpolate operator-tunable numbers ("exceeded its 512MB memory budget"),
 * so it moved with the env. The concrete timeout and heap figures now go to the
 * server log (`logFault` in host.ts) and the messages name the budget without its
 * value.
 */
export type JsComputeErrorCode =
  /** The computation ran past its wall-clock budget. */
  | 'timeout'
  /** The child hit its heap ceiling. */
  | 'out_of_memory'
  /** The answer was too large to return. */
  | 'result_too_large'
  /** The expression itself failed. The worker is healthy; the input was bad. */
  | 'evaluation_failed'
  /** The worker died or misbehaved. Not the caller's fault. */
  | 'worker_failed'
  /** Too many computations queued ahead of this one. */
  | 'busy';

export class JsComputeError extends Error {
  readonly code: JsComputeErrorCode;

  constructor(message: string, code: JsComputeErrorCode) {
    super(message);
    this.name = 'JsComputeError';
    this.code = code;
  }
}
