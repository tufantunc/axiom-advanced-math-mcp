import { describe, it, expect } from 'vitest';
import {
  BASELINE_SYSTEM_PROMPT,
  TOOL_SYSTEM_PROMPT,
  getToolPromptForProblem,
} from '../benchmark/providers/prompts.js';

describe('prompts — boxed final-answer format', () => {
  it('baseline and tool system prompts request \\boxed', () => {
    expect(BASELINE_SYSTEM_PROMPT).toContain('\\boxed');
    expect(TOOL_SYSTEM_PROMPT).toContain('\\boxed');
  });
  it('no prompt still uses the old number format', () => {
    expect(BASELINE_SYSTEM_PROMPT).not.toContain('The answer is <number>');
    expect(TOOL_SYSTEM_PROMPT).not.toContain('The answer is <number>');
    expect(getToolPromptForProblem('find the integral of x^2')).not.toContain('The answer is <number>');
  });
  it('category prompts (via selector) request \\boxed', () => {
    expect(getToolPromptForProblem('find the integral of x^2')).toContain('\\boxed');
    expect(getToolPromptForProblem('solve the quadratic equation')).toContain('\\boxed');
  });
});

describe('boxed extraction still works (regression guard)', () => {
  it('extracts a symbolic boxed answer', async () => {
    const { extractModelAnswer } = await import('../benchmark/graders/answer-parser.js');
    expect(extractModelAnswer('Reasoning... \\boxed{3x^2}')).toBe('3x^2');
    expect(extractModelAnswer('So \\boxed{42}.')).toBe('42');
  });
});

describe('prompts — bare-value boxing directive', () => {
  it('all prompts tell the model to box only the value, not assignments', () => {
    expect(BASELINE_SYSTEM_PROMPT).toContain('not \\boxed{n=4}');
    expect(TOOL_SYSTEM_PROMPT).toContain('not \\boxed{n=4}');
    expect(getToolPromptForProblem('Find the derivative of x^2.')).toContain('not \\boxed{n=4}');
  });

  it('all prompts tell the model to box the answer immediately', () => {
    expect(BASELINE_SYSTEM_PROMPT).toContain('as soon as');
    expect(TOOL_SYSTEM_PROMPT).toContain('as soon as');
  });
});
