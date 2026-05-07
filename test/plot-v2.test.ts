import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { registerPlotTools } from '../src/server/tools/plot/index.js';

describe('plot tool — v2 envelope', () => {
  let captured: { name: string; description: string; schema: unknown; handler: Function } | null =
    null;
  const fakeServer = {
    tool(
      name: string,
      description: string,
      schema: unknown,
      handler: (args: Record<string, unknown>) => Promise<unknown>
    ) {
      captured = { name, description, schema, handler };
    },
  } as unknown as Parameters<typeof registerPlotTools>[0];

  beforeAll(() => {
    process.env.AXIOM_OUTPUT_V2 = '1';
    registerPlotTools(fakeServer);
  });
  afterAll(() => {
    delete process.env.AXIOM_OUTPUT_V2;
  });

  it('appends boxed-style summary line under v2', async () => {
    expect(captured).not.toBeNull();
    const result = (await captured!.handler({
      expression: 'x^2',
      x_min: -2,
      x_max: 2,
    })) as { content: ({ type: 'text'; text: string } | { type: 'image' })[]; isError: boolean };
    expect(result.isError).toBe(false);
    const textBlocks = result.content.filter((c) => c.type === 'text') as {
      type: 'text';
      text: string;
    }[];
    expect(textBlocks.some((b) => /^\\boxed\{plot:/.test(b.text))).toBe(true);
  });
});
