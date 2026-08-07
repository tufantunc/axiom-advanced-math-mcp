import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { computeSchema, computeHandler } from './tools/compute/index.js';
import { verifySchema, verifyHandler } from './tools/verify/index.js';
import { registerPlotTools } from './tools/plot/index.js';
import { registerPrompts } from './prompts/index.js';
import { withGiacSession } from './giac/session-lock.js';
import { evaluationCache } from './tools/symbolic/cache.js';
import { VERSION } from '../version.js';

/**
 * Giac keeps global session state: `sto(7,qq)` and `assume(bb>0)` executed by
 * one tool call are still in effect for the next one. Left alone, that leaks
 * across MCP tool calls — and, over the stateless HTTP transport, across
 * *different clients*: one caller's `assume(bb>0)` silently turns another's
 * `integrate(sqrt(bb^2),bb)` into `bb^2/2` instead of `1/2*bb^2*sign(bb)`,
 * answered with a 200. An LLM has no way to know state persisted.
 *
 * `withGiacSession` closes both halves of that: it resets the engine at the
 * tool-call boundary (not per-`evaluate()` — one `compute` legitimately makes
 * several Giac calls that must share a session) AND holds a mutex for the
 * whole handler, so a concurrent tool call cannot interleave its own
 * evaluations between this one's reset and its result. See session-lock.ts.
 */

/**
 * Runs one Giac-backed tool call as an isolated CAS session.
 *
 * `withGiacSession` resets the *engine*; this also drops the memoized *results*
 * computed under the session being discarded. The two belong together: the
 * evaluation cache is keyed on the Giac expression string alone, so an entry
 * computed while `sto(7,qq)` was in effect would otherwise be served to a later
 * caller running against a pristine engine — the same silent wrong answer the
 * reset exists to prevent, arriving through the cache instead of the worker.
 *
 * `isCacheable()` in tools/symbolic/cache.ts already refuses to store results
 * for expressions containing `sto(`/`:=`/`assume(`/`purge(`, but that is a
 * denylist: it cannot know about `angle_radian(`, `approx_mode(`, `srand(` or
 * whatever a future Giac call introduces. Scoping the cache to the session it
 * was computed in removes the channel structurally instead of enumerating it.
 * The denylist stays as defence in depth for reuse *within* a single call.
 *
 * Cost, measured: a repeated identical expression goes from a 0.016 ms cache
 * hit to a 0.405 ms recompute. Caching within a call — the computation, its
 * LaTeX, its verification pass — is unaffected.
 */
function withIsolatedCasSession<A, R>(handler: (args: A) => Promise<R>): (args: A) => Promise<R> {
  return withGiacSession(async (args: A) => {
    evaluationCache.clear();
    return handler(args);
  });
}

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: 'axiom-advanced-math-mcp',
      version: VERSION,
    },
    {
      instructions: `Axiom — Advanced Math MCP Server

TOOL SELECTION GUIDE:
  Any math computation    → compute
  Graph / visualization   → plot
  Verify a result         → verify

The "compute" tool accepts a problem string using CAS-style function calls:
  solve(x^2-4=0, x)         — solve equation
  diff(x^3, x)              — differentiate
  int(x^2, x, 0, 1)         — definite integral
  limit(sin(x)/x, x, 0)     — limit
  taylor(exp(x), x=0, 5)    — Taylor series
  factor(x^2-4)              — factorize
  simplify((x^2-1)/(x-1))   — simplify
  expand((x+1)^3)            — expand
  det([[1,2],[3,4]])          — matrix determinant
  eigenvals([[2,1],[1,2]])    — eigenvalues
  C(10,3)                     — combinations
  ifactor(2310)               — prime factorization
  2+3*sin(pi/4)              — arithmetic
  Or any valid Giac/Xcas expression.

Optional parameters:
  domain: "complex" for complex solutions, "numeric" to force numerical methods
  precision: decimal places (1-50)
  format: "text" (default), "latex", or "json" (structured envelope)

The "verify" tool checks mathematical claims:
  "sin(x)^2 + cos(x)^2 = 1"     — identity check
  "x=2 satisfies x^2-4=0"        — solution check

The "plot" tool renders function graphs as SVG images.`,
    }
  );

  registerPrompts(server);

  // --- compute: single gateway for ALL math computations ---
  server.tool(
    'compute',
    'Solve any math problem: equations, calculus, algebra, matrices, combinatorics, ' +
      'probability, statistics, geometry, number theory, and more. ' +
      'Pass a CAS-style problem string (e.g., "solve(x^2-4=0, x)", "diff(x^3, x)", ' +
      '"det([[1,2],[3,4]])", "C(10,3)", "2+3*sin(pi/4)") or any Giac/Xcas expression.',
    computeSchema.shape,
    withIsolatedCasSession(async (args) => computeHandler(args))
  );

  // --- verify: independent result verification ---
  server.tool(
    'verify',
    'Verify a mathematical claim using symbolic and/or numeric checks. ' +
      'Supports identity verification (e.g., "sin(x)^2+cos(x)^2 = 1"), ' +
      'solution checking (e.g., "x=2 satisfies x^2-4=0"), and computation assertions.',
    verifySchema.shape,
    withIsolatedCasSession(async (args) => verifyHandler(args as Record<string, unknown>))
  );

  // --- plot: mathjs only, never touches Giac, so no reset needed ---
  registerPlotTools(server);

  return server;
}
