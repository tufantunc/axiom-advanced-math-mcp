import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../../src/server/giac/wrapper.js';
import { TOOL_CASES } from './fixtures.js';

describe('golden tool corpus (real Giac)', () => {
  beforeAll(async () => {
    await giacEngine.initialize();
  }, 30000);

  for (const c of TOOL_CASES) {
    it(c.description, async () => {
      const result = await giacEngine.evaluate(c.giacInput);
      for (const expected of c.expectedContains) {
        expect(result).toContain(expected);
      }
    }, 15000);
  }
});
