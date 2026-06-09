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
