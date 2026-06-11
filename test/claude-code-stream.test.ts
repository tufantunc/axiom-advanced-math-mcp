import { describe, it, expect } from 'vitest';
import { parseClaudeCodeStream } from '../benchmark/providers/claude-code-stream.js';

const init = JSON.stringify({ type: 'system', subtype: 'init', tools: ['Bash'] });
const assistantText = (text: string) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const assistantToolUse = (id: string, name: string, input: Record<string, unknown>) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id: string, content: unknown, isError = false) =>
  JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
  });
const result = (text: string, opts: Partial<{ is_error: boolean; num_turns: number }> = {}) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: opts.is_error ?? false,
    num_turns: opts.num_turns ?? 1,
    result: text,
    usage: { input_tokens: 10, output_tokens: 20 },
  });

describe('parseClaudeCodeStream', () => {
  it('assembles text and usage from a tool-free run', () => {
    const r = parseClaudeCodeStream([init, assistantText('The answer is \\boxed{4}.'), result('The answer is \\boxed{4}.')]);
    expect(r.text).toContain('\\boxed{4}');
    expect(r.toolCalls).toEqual([]);
    expect(r.turns).toBe(1);
    expect(r.inputTokens).toBe(10);
    expect(r.outputTokens).toBe(20);
    expect(r.isError).toBe(false);
  });

  it('pairs tool_use with tool_result into ToolCallRecords (string and array content)', () => {
    const lines = [
      init,
      assistantToolUse('t1', 'mcp__axiom__compute', { problem: 'diff(x^3,x)' }),
      toolResult('t1', 'Result: 3*x^2'),
      assistantToolUse('t2', 'Bash', { command: 'python3 -c "print(1)"' }),
      toolResult('t2', [{ type: 'text', text: '1' }]),
      assistantText('Done: \\boxed{3x^2}'),
      result('Done: \\boxed{3x^2}', { num_turns: 3 }),
    ];
    const r = parseClaudeCodeStream(lines);
    expect(r.toolCalls).toHaveLength(2);
    expect(r.toolCalls[0]).toEqual({
      name: 'mcp__axiom__compute',
      args: { problem: 'diff(x^3,x)' },
      result: 'Result: 3*x^2',
      success: true,
    });
    expect(r.toolCalls[1].result).toBe('1');
    expect(r.turns).toBe(3);
  });

  it('marks failed tool calls and includes tool results in the text transcript', () => {
    const lines = [
      assistantToolUse('t1', 'Bash', { command: 'false' }),
      toolResult('t1', 'command failed', true),
      result('gave up'),
    ];
    const r = parseClaudeCodeStream(lines);
    expect(r.toolCalls[0].success).toBe(false);
    expect(r.text).toContain('[Tool result: command failed]');
  });

  it('propagates is_error and tolerates malformed/unknown lines', () => {
    const lines = ['not json', JSON.stringify({ type: 'rate_limit_event' }), result('boom', { is_error: true })];
    const r = parseClaudeCodeStream(lines);
    expect(r.isError).toBe(true);
    expect(r.text).toBe('boom');
  });

  it('reports a missing result event as an error', () => {
    const r = parseClaudeCodeStream([assistantText('partial')]);
    expect(r.isError).toBe(true);
  });
});
