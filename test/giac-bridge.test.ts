import { describe, it, expect, vi } from 'vitest';
import { createGiacBridge } from '../benchmark/graders/giac-bridge.js';

describe('giac-bridge', () => {
  it('caches identical calls', async () => {
    const fake = vi.fn().mockResolvedValue('0');
    const bridge = createGiacBridge({ engine: { evaluate: fake }, timeoutMs: 100 });
    const a = await bridge.evaluate('simplify(x - x)');
    const b = await bridge.evaluate('simplify(x - x)');
    expect(a).toBe('0');
    expect(b).toBe('0');
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it('returns null on timeout', async () => {
    const slow = () => new Promise<string>((resolve) => setTimeout(() => resolve('0'), 200));
    const bridge = createGiacBridge({ engine: { evaluate: slow }, timeoutMs: 50 });
    const result = await bridge.evaluate('simplify(huge_expr)');
    expect(result).toBeNull();
  });

  it('returns null on engine error', async () => {
    const bridge = createGiacBridge({
      engine: { evaluate: () => Promise.reject(new Error('boom')) },
      timeoutMs: 100,
    });
    expect(await bridge.evaluate('bad')).toBeNull();
  });

  it('caches distinct expressions independently', async () => {
    const fake = vi.fn(async (e: string) => `result:${e}`);
    const bridge = createGiacBridge({ engine: { evaluate: fake } });
    const a = await bridge.evaluate('expr_a');
    const b = await bridge.evaluate('expr_b');
    expect(a).toBe('result:expr_a');
    expect(b).toBe('result:expr_b');
    expect(fake).toHaveBeenCalledTimes(2);
  });

  it('treats whitespace-trimmed keys as equal', async () => {
    const fake = vi.fn().mockResolvedValue('42');
    const bridge = createGiacBridge({ engine: { evaluate: fake } });
    await bridge.evaluate('foo');
    await bridge.evaluate('  foo  ');
    expect(fake).toHaveBeenCalledTimes(1);
  });
});
