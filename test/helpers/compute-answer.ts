import { expect } from 'vitest';
import { computeHandler } from '../../src/server/tools/compute/index.js';
import { allText } from './all-text.js';
import { resultLine } from './result-line.js';

/** `problem` is refused with a message containing `message`, and no Result line. */
export async function expectRefused(problem: string, message: string): Promise<string> {
  const r = await computeHandler({ problem });
  const text = allText(r);
  expect(r.isError, text).toBe(true);
  expect(text).toContain(message);
  expect(text).not.toMatch(/^Result:/m);
  return text;
}

/** `problem` answers exactly `expected` on its Result line. */
export async function expectAnswer(problem: string, expected: string): Promise<string> {
  const r = await computeHandler({ problem });
  const text = allText(r);
  expect(r.isError, text).toBe(false);
  expect(text).toMatch(resultLine(expected));
  return text;
}
