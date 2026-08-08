import { withGiacSession } from './giac/session-lock.js';
import { evaluationCache } from './tools/symbolic/cache.js';
import { computeHandler } from './tools/compute/index.js';
import { verifyHandler } from './tools/verify/index.js';

/**
 * Runs one Giac-backed tool call as an isolated CAS session.
 *
 * Giac keeps global session state: `sto(7,qq)` and `assume(bb>0)` executed by
 * one tool call are still in effect for the next one. Left alone, that leaks
 * across MCP tool calls — and, over the stateless HTTP transport, across
 * *different clients*: one caller's `assume(bb>0)` silently turns another's
 * `integrate(sqrt(bb^2),bb)` into `bb^2/2` instead of `1/2*bb^2*sign(bb)`,
 * answered with a 200. An LLM has no way to know state persisted.
 *
 * `withGiacSession` (giac/session-lock.ts) closes that by resetting the
 * *engine* at the tool-call boundary (not per-`evaluate()` — one `compute`
 * legitimately makes several Giac calls that must share a session) and
 * holding a mutex for the whole handler, so a concurrent tool call cannot
 * interleave its own evaluations between this one's reset and its result.
 * See that file's comment for why both the reset and the mutex are needed.
 *
 * Clearing `evaluationCache` here drops the memoized *results* computed under
 * the session being discarded — the reset alone isn't enough, because the
 * cache is a second, structurally separate state-leak channel. It is keyed on
 * the Giac expression string alone (see `isCacheable` in
 * tools/symbolic/cache.ts), so an entry computed while `sto(7,qq)` was in
 * effect would otherwise be served to a later caller running against a
 * pristine engine — the same silent wrong answer the reset exists to
 * prevent, arriving through the cache instead of the worker.
 *
 * Cost, measured: a repeated identical expression goes from a 0.016 ms cache
 * hit to a 0.405 ms recompute. Caching within a call — the computation, its
 * LaTeX, its verification pass — is unaffected.
 *
 * This lives here rather than in index.ts so the CLI can wrap the same way the
 * MCP registration does. If the two surfaces wrapped differently, CAS isolation
 * would silently depend on which one you came in through.
 */
function withIsolatedCasSession<A, R>(handler: (args: A) => Promise<R>): (args: A) => Promise<R> {
  return withGiacSession(async (args: A) => {
    evaluationCache.clear();
    return handler(args);
  });
}

export const computeTool = withIsolatedCasSession(
  async (args: Parameters<typeof computeHandler>[0]) => computeHandler(args)
);

export const verifyTool = withIsolatedCasSession(async (args: Record<string, unknown>) =>
  verifyHandler(args)
);
