import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { computeSchema, computeHandler } from './tools/compute/index.js';
import { verifySchema, verifyHandler } from './tools/verify/index.js';
import { registerPlotTools } from './tools/plot/index.js';
import { registerPrompts } from './prompts/index.js';
import { giacEngine } from './giac/index.js';
import { VERSION } from '../version.js';

/**
 * Giac keeps global session state: `sto(7,qq)` and `assume(bb>0)` executed by
 * one tool call are still in effect for the next one. Left alone, that leaks
 * across MCP tool calls — and, over the stateless HTTP transport, across
 * *different clients*: one caller's `assume(bb>0)` silently turns another's
 * `integrate(sqrt(bb^2),bb)` into `bb^2/2` instead of `1/2*bb^2*sign(bb)`,
 * answered with a 200. An LLM has no way to know state persisted.
 *
 * So the tool-call boundary is where the engine is wiped — not `evaluate()`,
 * because a single `compute` legitimately makes several Giac calls (result,
 * latex, verification pass) that must share one session. Measured cost of the
 * `restart`: ~1 ms.
 */
function withGiacReset<A, R>(handler: (args: A) => Promise<R>): (args: A) => Promise<R> {
  return async (args: A): Promise<R> => {
    await giacEngine.reset();
    return handler(args);
  };
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
    withGiacReset(async (args) => computeHandler(args))
  );

  // --- verify: independent result verification ---
  server.tool(
    'verify',
    'Verify a mathematical claim using symbolic and/or numeric checks. ' +
      'Supports identity verification (e.g., "sin(x)^2+cos(x)^2 = 1"), ' +
      'solution checking (e.g., "x=2 satisfies x^2-4=0"), and computation assertions.',
    verifySchema.shape,
    withGiacReset(async (args) => verifyHandler(args as Record<string, unknown>))
  );

  // --- plot: mathjs only, never touches Giac, so no reset needed ---
  registerPlotTools(server);

  return server;
}
