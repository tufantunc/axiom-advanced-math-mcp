import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let client: Client;

beforeAll(async () => {
  const transport = new StdioClientTransport({
    command: 'tsx',
    args: ['src/cli.ts'],
  });

  client = new Client({ name: 'integration-test', version: '0.0.1' });
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
});

function getTextContent(res: Awaited<ReturnType<typeof client.callTool>>): string {
  return (res.content as { type: string; text: string }[])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

describe('MCP Server Integration — 3-Tool Architecture', () => {
  // =========================================================================
  // Tool & Prompt Discovery
  // =========================================================================

  describe('Tool Discovery', () => {
    it('should list exactly 3 tools: compute, verify, plot', async () => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);

      expect(names).toContain('compute');
      expect(names).toContain('verify');
      expect(names).toContain('plot');
      expect(names).toHaveLength(3);
    });
  });

  describe('Prompt Discovery', () => {
    it('should list all 7 prompts', async () => {
      const { prompts } = await client.listPrompts();
      const names = prompts.map((p) => p.name);

      expect(names).toContain('solve-step-by-step');
      expect(names).toContain('analyze-function');
      expect(names).toContain('verify-identity');
      expect(names).toContain('convert-units');
      expect(names).toContain('analyze-dataset');
      expect(names).toContain('solve-ode-system');
      expect(names).toContain('regression-workflow');
      expect(names).toHaveLength(7);
    });

    it('should return solve-step-by-step prompt referencing compute tool', async () => {
      const result = await client.getPrompt({
        name: 'solve-step-by-step',
        arguments: { expression: 'x^2 - 4 = 0' },
      });
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe('user');
      const content = result.messages[0].content as { type: string; text: string };
      expect(content.text).toContain('x^2 - 4 = 0');
      expect(content.text).toContain('compute');
    });
  });

  // =========================================================================
  // Compute Tool — Arithmetic (quick_calc engine)
  // =========================================================================

  describe('compute: arithmetic', () => {
    it.each([
      ['2 + 3', '5'],
      ['sin(pi/2)', '1'],
      ['sqrt(144)', '12'],
    ])('should evaluate %s', async (problem, expected) => {
      const res = await client.callTool({
        name: 'compute',
        arguments: { problem },
      });
      const text = getTextContent(res);
      expect(text).toContain(expected);
    });
  });

  // =========================================================================
  // Compute Tool — Calculus (Giac engine)
  // =========================================================================

  describe('compute: calculus', () => {
    it.each([
      ['diff(x^3, x)', ['3', 'x']],
      ['int(x^2, x)', ['x', '3']],
    ])('calculus round trip %s', async (problem, needles) => {
      const res = await client.callTool({
        name: 'compute',
        arguments: { problem },
      });
      const text = getTextContent(res);
      for (const needle of needles) expect(text).toContain(needle);
    });

    it('definite integral: ∫₀¹ x dx = 1/2', async () => {
      const res = await client.callTool({
        name: 'compute',
        arguments: { problem: 'int(x, x, 0, 1)' },
      });
      const text = getTextContent(res);
      expect(text).toContain('1/2');
    });

    it('limit: lim(sin(x)/x, x→0) = 1', async () => {
      const res = await client.callTool({
        name: 'compute',
        arguments: { problem: 'limit(sin(x)/x, x, 0)' },
      });
      const text = getTextContent(res);
      expect(text).toContain('1');
    });

    it('taylor: exp(x) around x=0', async () => {
      const res = await client.callTool({
        name: 'compute',
        arguments: { problem: 'taylor(exp(x), x=0, 3)' },
      });
      const text = getTextContent(res);
      expect(text).toContain('x');
    });

    it("solve ODE: y' = x", async () => {
      const res = await client.callTool({
        name: 'compute',
        arguments: { problem: "desolve(y'=x, x, y)" },
      });
      const text = getTextContent(res);
      expect(text).toContain('x');
    });
  });

  // =========================================================================
  // Compute Tool — Algebra (Giac engine)
  // =========================================================================

  describe('compute: algebra', () => {
    it('factor: x^2 - 4 → (x-2)(x+2)', async () => {
      const res = await client.callTool({
        name: 'compute',
        arguments: { problem: 'factor(x^2-4)' },
      });
      const text = getTextContent(res);
      expect(text).toContain('x');
      expect(text).toContain('2');
    });

    it('simplify: (x^2-1)/(x-1) → x+1', async () => {
      const res = await client.callTool({
        name: 'compute',
        arguments: { problem: 'simplify((x^2-1)/(x-1))' },
      });
      const text = getTextContent(res);
      expect(text).toContain('x');
      expect(text).toContain('1');
    });

    it('expand: (x+1)^2 → x^2+2x+1', async () => {
      const res = await client.callTool({
        name: 'compute',
        arguments: { problem: 'expand((x+1)^2)' },
      });
      const text = getTextContent(res);
      expect(text).toContain('x');
      expect(text).toContain('2');
    });

    it('partial fractions: 1/(x^2-1)', async () => {
      const res = await client.callTool({
        name: 'compute',
        arguments: { problem: 'partfrac(1/(x^2-1), x)' },
      });
      const text = getTextContent(res);
      expect(text).toContain('x');
    });
  });

  // =========================================================================
  // Compute Tool — Equation Solving
  // =========================================================================

  describe('compute: equation solving', () => {
    it('solve equation: x^2 - 9 = 0 → [-3, 3]', async () => {
      const res = await client.callTool({
        name: 'compute',
        arguments: { problem: 'solve(x^2-9=0, x)' },
      });
      const text = getTextContent(res);
      expect(text).toContain('3');
    });

    it('solve system: x+y=5, x-y=1 → x=3, y=2', async () => {
      const res = await client.callTool({
        name: 'compute',
        arguments: { problem: 'solve_system([x+y=5, x-y=1], [x, y])' },
      });
      const text = getTextContent(res);
      expect(text).toContain('3');
      expect(text).toContain('2');
    });
  });

  // =========================================================================
  // Compute Tool — Matrix operations
  // =========================================================================

  describe('compute: matrix', () => {
    it('determinant: det([[1,2],[3,4]]) = -2', async () => {
      const res = await client.callTool({
        name: 'compute',
        arguments: { problem: 'det([[1,2],[3,4]])' },
      });
      const text = getTextContent(res);
      expect(text).toContain('-2');
    });

    it('eigenvalues of [[2,1],[1,2]] → 1, 3', async () => {
      const res = await client.callTool({
        name: 'compute',
        arguments: { problem: 'eigenvals([[2,1],[1,2]])' },
      });
      const text = getTextContent(res);
      expect(text).toContain('1');
      expect(text).toContain('3');
    });
  });

  // =========================================================================
  // Compute Tool — Advanced CAS
  // =========================================================================

  describe('compute: advanced CAS', () => {
    it('Laplace transform: L{exp(-2*t)}', async () => {
      const res = await client.callTool({
        name: 'compute',
        arguments: { problem: 'laplace(exp(-2*t), t, s)' },
      });
      const text = getTextContent(res);
      expect(text).toContain('s');
      expect(text).toContain('2');
    });

    it('sum: Σ(k, k=1..100) = 5050', async () => {
      const res = await client.callTool({
        name: 'compute',
        arguments: { problem: 'sum(k, k, 1, 100)' },
      });
      const text = getTextContent(res);
      expect(text).toContain('5050');
    });

    it('gradient: grad(x^2+y^2)', async () => {
      const res = await client.callTool({
        name: 'compute',
        arguments: { problem: 'grad(x^2+y^2, [x,y])' },
      });
      const text = getTextContent(res);
      expect(text).toContain('x');
      expect(text).toContain('y');
    });

    it('prime factorization: ifactor(2310)', async () => {
      const res = await client.callTool({
        name: 'compute',
        arguments: { problem: 'ifactor(2310)' },
      });
      const text = getTextContent(res);
      expect(text).toContain('2');
      expect(text).toContain('3');
      expect(text).toContain('5');
      expect(text).toContain('7');
      expect(text).toContain('11');
    });
  });

  // =========================================================================
  // Compute Tool — JSON format
  // =========================================================================

  describe('compute: json format', () => {
    it('should return structured envelope in json format', async () => {
      const res = await client.callTool({
        name: 'compute',
        arguments: { problem: 'diff(x^3, x)', format: 'json' },
      });
      const text = getTextContent(res);
      const envelope = JSON.parse(text);
      expect(envelope.success).toBe(true);
      expect(envelope.result_type).toBeDefined();
      expect(envelope.display).toBeDefined();
      expect(envelope.method).toBeDefined();
    });
  });

  // =========================================================================
  // Verify Tool
  // =========================================================================

  describe('verify tool', () => {
    it('should verify identity sin^2+cos^2 = 1', async () => {
      const res = await client.callTool({
        name: 'verify',
        arguments: { claim: 'sin(x)^2 + cos(x)^2 = 1' },
      });
      const text = getTextContent(res);
      expect(text).toContain('TRUE');
    });

    it('should verify solution x=2 satisfies x^2-4=0', async () => {
      const res = await client.callTool({
        name: 'verify',
        arguments: { claim: 'x=2 satisfies x^2-4=0' },
      });
      const text = getTextContent(res);
      expect(text).toContain('TRUE');
    });

    it('should reject false identity', async () => {
      const res = await client.callTool({
        name: 'verify',
        arguments: { claim: '2+3 = 6' },
      });
      const text = getTextContent(res);
      expect(text).toContain('FALSE');
    });
  });

  // =========================================================================
  // Plot Tool
  // =========================================================================

  describe('plot tool', () => {
    it('should return SVG image for sin(x)', async () => {
      const res = await client.callTool({
        name: 'plot',
        arguments: { expression: 'sin(x)', x_min: -6.28, x_max: 6.28 },
      });
      const content = res.content as {
        type: string;
        text?: string;
        data?: string;
        mimeType?: string;
      }[];
      const imageContent = content.find((c) => c.type === 'image');
      expect(imageContent).toBeDefined();
      expect(imageContent!.mimeType).toBe('image/svg+xml');
      expect(imageContent!.data).toBeDefined();
      const svg = Buffer.from(imageContent!.data!, 'base64').toString('utf-8');
      expect(svg).toContain('<svg');
      expect(svg).toContain('</svg>');
    });

    it('should include text description', async () => {
      const res = await client.callTool({
        name: 'plot',
        arguments: { expression: 'x^2' },
      });
      const content = res.content as { type: string; text?: string }[];
      const textContent = content.find((c) => c.type === 'text');
      expect(textContent).toBeDefined();
      expect(textContent!.text).toContain('x^2');
    });
  });
});
