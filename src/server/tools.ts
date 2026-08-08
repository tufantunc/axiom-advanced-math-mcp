import { withGiacSession } from './giac/session-lock.js';
import { evaluationCache } from './tools/symbolic/cache.js';
import { computeHandler } from './tools/compute/index.js';
import { verifyHandler } from './tools/verify/index.js';

/**
 * Runs one Giac-backed tool call as an isolated CAS session.
 *
 * `withGiacSession` resets the *engine*; this also drops the memoized *results*
 * computed under the session being discarded. See the long comment in
 * giac/session-lock.ts for why both halves are needed.
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
