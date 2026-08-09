import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { computeSchema } from './tools/compute/index.js';
import { verifySchema } from './tools/verify/index.js';
import { registerPlotTools } from './tools/plot/index.js';
import { registerPrompts } from './prompts/index.js';
import { computeTool, verifyTool } from './tools.js';
import { VERSION } from '../version.js';

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: 'axiom-math',
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
  Read "evaluated" before "verified": evaluated=false means the claim could not
  be checked at all, so verified=false there is "unknown", not "disproved".

The "plot" tool renders function graphs as SVG images.`,
    }
  );

  registerPrompts(server);

  // --- compute: single gateway for ALL math computations ---
  server.tool(
    'compute',
    'Compute an exact answer to a mathematics problem: equation solving, calculus, linear algebra, ' +
      'combinatorics, probability and statistics, number theory, geometry, differential equations, ' +
      'transforms and series. Runs a real computer algebra system (Giac/Xcas) in this process — ' +
      'answers are computed rather than recalled, with no network call and no API key.\n\n' +
      'Pass one CAS-style problem string; the `problem` parameter lists the verbs. Anything it does ' +
      'not recognise is evaluated as a raw Giac/Xcas expression, so valid Giac syntax always works.\n\n' +
      'Results are exact by default — fractions and radicals are kept rather than rounded. Ask for ' +
      'domain "numeric" or set `precision` when you want a decimal. Where it can, the tool re-checks ' +
      'its own answer and reports that check alongside the result.\n\n' +
      'When you already have an answer and want it confirmed, use `verify` instead: recomputing here ' +
      'and comparing is not an independent check.',
    computeSchema.shape,
    computeTool
  );

  // --- verify: independent result verification ---
  server.tool(
    'verify',
    'Independently check whether a mathematical claim is true. Use it to confirm an answer — yours or ' +
      'one from `compute` — instead of recomputing and hoping the second attempt agrees.\n\n' +
      'Handles identities ("sin(x)^2+cos(x)^2 = 1"), solution claims ("x=2 satisfies x^2-4=0") and ' +
      'computation assertions ("diff(x^3, x) = 3*x^2"), checked symbolically, numerically, or both.\n\n' +
      'The verdict has three outcomes, not two. Read `evaluated` before `verified`: when `evaluated` is ' +
      'false nothing could be checked — the claim did not parse, or the CAS could not evaluate it — so ' +
      '`verified: false` there means "unknown", not "disproved". Treating the two as the same turns a ' +
      'syntax error into a refutation.',
    verifySchema.shape,
    verifyTool
  );

  // --- plot: mathjs only, never touches Giac, so no reset needed ---
  registerPlotTools(server);

  return server;
}
