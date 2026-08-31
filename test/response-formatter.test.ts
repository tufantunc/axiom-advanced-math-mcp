import { describe, it, expect } from 'vitest';
import { formatToolResponse } from '../src/server/tools/response-formatter.js';

function allText(r: { content: { text: string }[] }): string {
  return r.content.map((c) => c.text).join('\n');
}

describe('formatToolResponse — verification rendering', () => {
  it('renders a verified line (always, even when true)', () => {
    const r = formatToolResponse({
      result: '{-2, 2}',
      verification: { verified: true, method: 'substitution', detail: '2/2 roots satisfy the equation' },
    });
    expect(allText(r)).toContain('Verified: ✓ (substitution: 2/2 roots satisfy the equation)');
  });
  it('renders an unverified line and a method note', () => {
    const r = formatToolResponse({
      result: '{i, -i}',
      methodNote: 'csolve (escalated — no real solution verified)',
      verification: { verified: false, method: 'substitution', detail: '0/2 roots satisfy the equation' },
    });
    const text = allText(r);
    expect(text).toContain('Method: csolve (escalated — no real solution verified)');
    expect(text).toContain('Verified: ✗ (substitution: 0/2 roots satisfy the equation)');
  });
  it('omits both lines when not provided', () => {
    const text = allText(formatToolResponse({ result: '5' }));
    expect(text).not.toContain('Verified:');
    expect(text).not.toContain('Method:');
  });
});

describe('formatToolResponse — decimal rendering', () => {
  it('renders the decimal approximation of an exact result', () => {
    const text = allText(formatToolResponse({ result: '1/3', decimal: '0.3333333333' }));
    expect(text).toContain('Result: 1/3');
    expect(text).toContain('Decimal: 0.3333333333');
    expect(text).toContain('The answer is 1/3 (≈ 0.3333333333)');
  });

  it('renders an integer decimal without trailing noise', () => {
    const text = allText(formatToolResponse({ result: '5', decimal: '5.0' }));
    expect(text).toContain('The answer is 5 (≈ 5)');
  });

  it('drops the approximation when the decimal is not finite', () => {
    const text = allText(formatToolResponse({ result: '1/3', decimal: 'Infinity' }));
    expect(text).toContain('The answer is 1/3');
    expect(text).not.toContain('≈');
  });

  it('drops the approximation when the decimal is unparseable', () => {
    const text = allText(formatToolResponse({ result: '1/3', decimal: 'abc' }));
    expect(text).toContain('The answer is 1/3');
    expect(text).not.toContain('≈');
  });
});
