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
    computeTool
  );

  // --- verify: independent result verification ---
  server.tool(
    'verify',
    'Verify a mathematical claim using symbolic and/or numeric checks. ' +
      'Supports identity verification (e.g., "sin(x)^2+cos(x)^2 = 1"), ' +
      'solution checking (e.g., "x=2 satisfies x^2-4=0"), and computation assertions.',
    verifySchema.shape,
    verifyTool
  );

  // --- plot: mathjs only, never touches Giac, so no reset needed ---
  registerPlotTools(server);

  return server;
}
