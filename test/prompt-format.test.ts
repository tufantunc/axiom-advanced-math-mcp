import { describe, it, expect } from 'vitest';
import {
  BASELINE_SYSTEM_PROMPT,
  TOOL_SYSTEM_PROMPT,
  getToolPromptForProblem,
  ANSWER_FORMAT,
  PROMPT_MAP,
} from '../benchmark/providers/prompts.js';
import { extractModelAnswer } from '../benchmark/graders/answer-parser.js';

describe('boxed extraction still works (regression guard)', () => {
  it('extracts a symbolic boxed answer', async () => {
    const { extractModelAnswer } = await import('../benchmark/graders/answer-parser.js');
    expect(extractModelAnswer('Reasoning... \\boxed{3x^2}')).toBe('3x^2');
    expect(extractModelAnswer('So \\boxed{42}.')).toBe('42');
  });
});

describe('prompts — ANSWER_FORMAT is the single grader contract', () => {
  // The old "all prompts" tests above sample three prompts. These cover every
  // prompt the module can emit, which is what the grader actually depends on:
  // answer-parser.ts extracts \boxed{...}, so one prompt missing the block
  // silently makes that category's answers unparseable, and the report shows
  // it as the model doing worse rather than as a prompt defect.
  // The two top-level prompts are named explicitly; the category prompts come
  // from PROMPT_MAP, so a new category is covered with no edit here. A new
  // top-level prompt DOES need a line — the orphan guard below is what makes
  // that omission fail instead of passing silently.
  const everyPrompt = (): [string, string][] => [
    ['BASELINE_SYSTEM_PROMPT', BASELINE_SYSTEM_PROMPT],
    ['TOOL_SYSTEM_PROMPT', TOOL_SYSTEM_PROMPT],
    ...Object.entries(PROMPT_MAP).map(([k, v]): [string, string] => [`PROMPT_MAP.${k}`, v]),
  ];

  it('no exported prompt escapes the covered set', async () => {
    // Catches the case the list cannot: a prompt exported from the module and
    // handed to a provider without being registered in PROMPT_MAP. Matches both
    // naming conventions the module uses — TOOL_SYSTEM_PROMPT (suffix) and
    // TOOL_PROMPT_ALGEBRA (prefix).
    const mod: Record<string, unknown> = await import('../benchmark/providers/prompts.js');
    const covered = new Set(everyPrompt().map(([, prompt]) => prompt));
    const exported = Object.entries(mod).filter(
      (e): e is [string, string] => typeof e[1] === 'string' && /(^|_)PROMPT(_|$)/.test(e[0])
    );
    expect(exported.length, 'no prompt-shaped exports found').toBeGreaterThanOrEqual(2);
    for (const [name, prompt] of exported) {
      expect(covered.has(prompt), `${name} is exported but not covered`).toBe(true);
    }
  });

  it('ANSWER_FORMAT states the actual contract the grader depends on', () => {
    // The endsWith check below only proves all nine prompts share ONE block; it
    // says nothing about what that block SAYS. Without these, replacing the
    // block's body with "state your result at the end" keeps the whole suite
    // green while making every answer unparseable by answer-parser.ts — which
    // then reads as the model scoring worse, not as a prompt defect.
    expect(ANSWER_FORMAT).toContain('\\boxed');
    expect(ANSWER_FORMAT).toContain('not \\boxed{n=4}');
    expect(ANSWER_FORMAT).toContain('as soon as');
    expect(ANSWER_FORMAT).not.toContain('The answer is <number>');
  });

  it('the format ANSWER_FORMAT asks for is the format the grader extracts', () => {
    // Crosses the prompt/parser seam: a reply shaped the way ANSWER_FORMAT
    // demands must round-trip through the real extractor. Pins the two sides to
    // each other instead of each to itself.
    expect(extractModelAnswer('Working... \\boxed{3x^2}')).toBe('3x^2');
  });

  it('every prompt ends with the exact ANSWER_FORMAT block', () => {
    for (const [name, prompt] of everyPrompt()) {
      expect(prompt.endsWith(ANSWER_FORMAT), name).toBe(true);
    }
  });

  it('states the block exactly once per prompt', () => {
    for (const [name, prompt] of everyPrompt()) {
      expect(prompt.split(ANSWER_FORMAT).length - 1, name).toBe(1);
    }
  });

  // One keyword per category that no EARLIER category also claims — routing is
  // a first-match loop over CATEGORY_KEYWORDS, so e.g. "derivative" resolves to
  // `cas`, not `calculus`, and a naive calculus probe never reaches the calculus
  // prompt at all.
  const categoryProbes: [string, string][] = [
    ['cas', 'find the integral of x^2'],
    ['algebra', 'this is an algebra problem'],
    ['counting', 'a combinatoric question'],
    ['calculus', 'the rate of change of f'],
    ['number_theory', 'is 91 a prime'],
    ['geometry', 'area of a triangle'],
    ['probability', 'probability of rolling a six'],
  ];

  it.each(categoryProbes)("routes a %s probe to that category's own prompt", (category, probe) => {
    // Asserting identity, not just "carries the block" — every prompt carries
    // the block, so a containment check here could not detect a routing defect
    // (all categories collapsing to one prompt, or a PROMPT_MAP key that stops
    // matching a CATEGORY_KEYWORDS key and silently falls through).
    expect(getToolPromptForProblem(probe)).toBe(PROMPT_MAP[category]);
  });

  it('the probes actually distinguish the prompts', () => {
    const reached = new Set(categoryProbes.map(([, p]) => getToolPromptForProblem(p)));
    expect(reached.size).toBe(categoryProbes.length);
  });

  it('an unmatched problem falls back to the tool prompt, which carries the block', () => {
    const fallback = getToolPromptForProblem('no keyword here at all');
    expect(fallback).toBe(TOOL_SYSTEM_PROMPT);
    expect(fallback).toContain(ANSWER_FORMAT);
  });
});
