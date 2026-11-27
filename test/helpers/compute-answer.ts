import { expect } from 'vitest';
import { computeHandler } from '../../src/server/tools/compute/index.js';
import { allText } from './all-text.js';
import { resultLine } from './result-line.js';

/** `problem` is refused with a message containing `message`, and no Result line. */
export async function expectRefused(problem: string, message: string): Promise<void> {
  const r = await computeHandler({ problem });
  const text = allText(r);
  expect(r.isError, text).toBe(true);
  expect(text).toContain(message);
  expect(text).not.toMatch(/^Result:/m);
}

/** `problem` answers exactly `expected` on its Result line. */
export async function expectAnswer(problem: string, expected: string): Promise<void> {
  const r = await computeHandler({ problem });
  const text = allText(r);
  expect(r.isError, text).toBe(false);
  expect(text).toMatch(resultLine(expected));
}

/** The value on `problem`'s Result line, after asserting it is an answer. */
export async function answerOf(problem: string): Promise<string> {
  const r = await computeHandler({ problem });
  const text = allText(r);
  expect(r.isError, text).toBe(false);
  const result = /^Result: (.*)$/m.exec(text)?.[1];
  expect(result, text).toBeDefined();
  return result ?? '';
}
