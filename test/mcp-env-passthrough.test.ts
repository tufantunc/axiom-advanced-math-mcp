import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createMCPProxy } from '../benchmark/runners/mcp-proxy.js';

describe('MCP proxy — env var passthrough', () => {
  const PROJECT_ROOT = new URL('..', import.meta.url).pathname;
  let proxy: Awaited<ReturnType<typeof createMCPProxy>> | null = null;

  beforeAll(() => {
    process.env.AXIOM_OUTPUT_V2 = '1';
  });
  afterAll(async () => {
    delete process.env.AXIOM_OUTPUT_V2;
    if (proxy) await proxy.close();
  });

  it('child MCP server inherits AXIOM_OUTPUT_V2 and emits v2 envelope', async () => {
    proxy = await createMCPProxy(['tsx', PROJECT_ROOT + 'src/cli.ts']);
    const result = await proxy.callTool('compute', { problem: 'diff(x^3, x)' });
    // The v2 envelope is a single text block: JSON line + blank line + boxed line.
    // The proxy joins multiple text blocks with '\n', so the response should END
    // with the boxed trailer. v1 ends with "The answer is ..." instead.
    const lines = result.split('\n');
    const last = lines[lines.length - 1];
    expect(last).toMatch(/^\\boxed\{/);
    expect(last.endsWith('}')).toBe(true);
  }, 30000);
});
