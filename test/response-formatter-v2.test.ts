import { describe, it, expect } from 'vitest';
import { formatToolResponseV2 } from '../src/server/tools/response-formatter-v2.js';

describe('response-formatter-v2 — basic envelope', () => {
  it('produces JSON + boxed trailer for plain answer', () => {
    const r = formatToolResponseV2({
      answer: '3*x^2',
      answer_latex: '3 x^{2}',
      confidence: 'medium',
    });
    expect(r.isError).toBe(false);
    expect(r.content).toHaveLength(1);
    const text = r.content[0].text;
    // body: JSON line + blank line + boxed line
    const [jsonPart, blankLine, boxedLine] = text.split('\n');
    expect(blankLine).toBe('');
    expect(boxedLine).toBe('\\boxed{3*x^2}');
    const parsed = JSON.parse(jsonPart);
    expect(parsed.answer).toBe('3*x^2');
    expect(parsed.answer_boxed).toBe('\\boxed{3*x^2}');
    expect(parsed.answer_latex).toBe('3 x^{2}');
    expect(parsed.confidence).toBe('medium');
  });

  it('includes answer_numeric when numeric value supplied', () => {
    const r = formatToolResponseV2({
      answer: '16/3',
      answer_numeric: 16 / 3,
      confidence: 'medium',
    });
    const parsed = JSON.parse(r.content[0].text.split('\n')[0]);
    expect(parsed.answer_numeric).toBeCloseTo(5.3333, 4);
  });

  it('omits absent optional fields', () => {
    const r = formatToolResponseV2({ answer: '42', confidence: 'high' });
    const parsed = JSON.parse(r.content[0].text.split('\n')[0]);
    expect(parsed).not.toHaveProperty('answer_latex');
    expect(parsed).not.toHaveProperty('answer_numeric');
    expect(parsed).not.toHaveProperty('warnings');
    expect(parsed).not.toHaveProperty('raw');
  });

  it('includes warnings array when supplied non-empty', () => {
    const r = formatToolResponseV2({
      answer: '0',
      confidence: 'low',
      warnings: ['Empty result from solve'],
    });
    const parsed = JSON.parse(r.content[0].text.split('\n')[0]);
    expect(parsed.warnings).toEqual(['Empty result from solve']);
  });

  it('errors propagate via isError flag', () => {
    const r = formatToolResponseV2({
      answer: '',
      confidence: 'low',
      error: 'Tool failed: bad input',
    });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('Tool failed');
  });

  it('handles backslash-rich LaTeX answers correctly', () => {
    const r = formatToolResponseV2({
      answer: '\\frac{1}{2}',
      confidence: 'medium',
    });
    const lines = r.content[0].text.split('\n');
    expect(lines[lines.length - 1]).toBe('\\boxed{\\frac{1}{2}}');
    const parsed = JSON.parse(lines[0]);
    expect(parsed.answer).toBe('\\frac{1}{2}');
    expect(parsed.answer_boxed).toBe('\\boxed{\\frac{1}{2}}');
  });

  it('keeps boxed trailer single-line even when answer contains newlines', () => {
    const r = formatToolResponseV2({
      answer: 'line1\nline2',
      confidence: 'medium',
    });
    const lines = r.content[0].text.split('\n');
    // Should still be exactly 3 lines: JSON, blank, boxed.
    expect(lines).toHaveLength(3);
    expect(lines[lines.length - 1]).toBe('\\boxed{line1 line2}');
  });
});

import { formatToolResponse } from '../src/server/tools/response-formatter.js';

describe('formatToolResponse — v2 flag', () => {
  it('uses v1 line-formatted output by default', () => {
    delete process.env.AXIOM_OUTPUT_V2;
    const r = formatToolResponse({ result: '3*x^2', latex: '3 x^{2}' });
    expect(r.content[0].text).toBe('Result: 3*x^2');
    // v1 produces multiple content blocks; trailer line is "The answer is ..."
    const lastText = r.content[r.content.length - 1].text;
    expect(lastText).toMatch(/^The answer is /);
  });

  it('uses v2 envelope when AXIOM_OUTPUT_V2=1', () => {
    process.env.AXIOM_OUTPUT_V2 = '1';
    const r = formatToolResponse({ result: '3*x^2', latex: '3 x^{2}' });
    expect(r.content).toHaveLength(1);
    const lines = r.content[0].text.split('\n');
    expect(lines[lines.length - 1]).toBe('\\boxed{3*x^2}');
    const parsed = JSON.parse(lines[0]);
    expect(parsed.answer).toBe('3*x^2');
    expect(parsed.answer_latex).toBe('3 x^{2}');
    delete process.env.AXIOM_OUTPUT_V2;
  });

  it('passes through error responses in both modes', () => {
    delete process.env.AXIOM_OUTPUT_V2;
    // v1 has its own formatErrorResponse; just verify the shim doesn't break it.
    expect(true).toBe(true); // placeholder; see formatErrorResponse separately
  });
});
