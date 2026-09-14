import { JsComputeError, type JsComputeErrorCode } from '../../src/server/js-compute/index.js';

/**
 * The code on a rejection, or the reason it has none.
 *
 * Asserting the code rather than the prose is what lets a heap death be told
 * from a worker that never started: both used to be matched by the same loose
 * message regexes.
 */
export async function codeOf(run: Promise<unknown>): Promise<JsComputeErrorCode | string> {
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
