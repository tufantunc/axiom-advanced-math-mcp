import type { ToolCallRecord } from './types.js';

export interface ParsedClaudeCodeResult {
  /** Ordered transcript: assistant text blocks + "[Tool result: …]" snippets. */
  text: string;
  toolCalls: ToolCallRecord[];
  turns: number;
  inputTokens: number;
  outputTokens: number;
  isError: boolean;
}

const SNIPPET_LIMIT = 500;

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? (b as { text?: string }).text ?? '' : ''))
      .join('');
  }
  return '';
}

/**
 * Parse Claude Code's `--output-format stream-json --verbose` JSONL output.
 * Pure function — tolerates malformed lines and unknown event types. A run
 * with no final `result` event is reported as an error.
 */
export function parseClaudeCodeStream(lines: string[]): ParsedClaudeCodeResult {
  const parts: string[] = [];
  const toolCalls: ToolCallRecord[] = [];
  const pending = new Map<string, { name: string; args: Record<string, unknown> }>();
  let turns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let isError = true; // until a result event proves otherwise
  let resultText = '';

  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = event.type;

    if (type === 'assistant' || type === 'user') {
      const message = event.message as { content?: unknown } | undefined;
      const content = Array.isArray(message?.content) ? (message.content as Record<string, unknown>[]) : [];
      for (const block of content) {
        if (type === 'assistant' && block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text);
        } else if (type === 'assistant' && block.type === 'tool_use') {
          pending.set(String(block.id), {
            name: String(block.name),
            args: (block.input as Record<string, unknown>) ?? {},
          });
        } else if (type === 'user' && block.type === 'tool_result') {
          const call = pending.get(String(block.tool_use_id));
          if (!call) continue;
          pending.delete(String(block.tool_use_id));
          const resultStr = contentToText(block.content);
          toolCalls.push({
            name: call.name,
            args: call.args,
            result: resultStr,
            success: block.is_error !== true,
          });
          parts.push(`[Tool result: ${resultStr.slice(0, SNIPPET_LIMIT)}]`);
        }
      }
    } else if (type === 'result') {
      isError = event.is_error === true;
      turns = typeof event.num_turns === 'number' ? event.num_turns : 0;
      resultText = typeof event.result === 'string' ? event.result : '';
      const usage = event.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      inputTokens = usage?.input_tokens ?? 0;
      outputTokens = usage?.output_tokens ?? 0;
    }
  }

  // The final result text is normally the last assistant text; if the
  // transcript missed it (e.g. text-free run), fall back to result text.
  const text = parts.length > 0 ? parts.join('\n') : resultText;
  return { text: text || resultText, toolCalls, turns, inputTokens, outputTokens, isError };
}
