/**
 * Failure causes at the js-compute boundary, as a closed set.
 *
 * Callers previously had only prose to branch on, and the prose interpolated
 * operator-tunable numbers ("exceeded its 512MB memory budget"), so any client
 * matching on it broke when an operator tuned the env. The code travels with the
 * error; the concrete figures go to the server log, not to the caller.
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

/** Narrows an unknown rejection to its code, for callers that branch on it. */
export function jsComputeErrorCode(e: unknown): JsComputeErrorCode | undefined {
  return e instanceof JsComputeError ? e.code : undefined;
}
