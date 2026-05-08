/**
 * Generic OpenAI-compatible provider.
 * Used by z.ai, OpenRouter, and any other OpenAI-compatible API.
 */
import OpenAI from 'openai';
import type {
  LLMProvider,
  NeutralTool,
  ToolCallRecord,
  BaselineResult,
  ToolAugmentedResult,
} from './types.js';
import { BASELINE_SYSTEM_PROMPT, getToolPromptForProblem } from './prompts.js';

export interface OpenAICompatOptions {
  name: string;
  model: string;
  apiKey: string;
  baseURL: string;
  defaultHeaders?: Record<string, string>;
}

export class OpenAICompatProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  private client: OpenAI;

  constructor(opts: OpenAICompatOptions) {
    this.name = opts.name;
    this.model = opts.model;
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      defaultHeaders: opts.defaultHeaders,
    });
  }

  async runBaseline(
    problem: string,
    maxTokens: number,
    temperature?: number
  ): Promise<BaselineResult> {
    const start = Date.now();

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: maxTokens,
      temperature: temperature ?? 0,
      messages: [
        { role: 'system', content: BASELINE_SYSTEM_PROMPT },
        { role: 'user', content: problem },
      ],
    });

    const choice = response.choices[0];
    return {
      text: choice.message.content ?? '',
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      durationMs: Date.now() - start,
    };
  }

  async runWithTools(
    problem: string,
    tools: NeutralTool[],
    callTool: (name: string, args: Record<string, unknown>) => Promise<string>,
    maxTokens: number,
    maxTurns: number,
    temperature?: number
  ): Promise<ToolAugmentedResult> {
    const start = Date.now();

    const openaiTools: OpenAI.ChatCompletionTool[] = tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as Record<string, unknown>,
      },
    }));

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: getToolPromptForProblem(problem) },
      { role: 'user', content: problem },
    ];

    const toolCalls: ToolCallRecord[] = [];
    let totalInput = 0;
    let totalOutput = 0;
    const allTextParts: string[] = []; // accumulate text from ALL turns
    let turns = 0;

    for (turns = 0; turns < maxTurns; turns++) {
      const response = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: maxTokens,
        temperature: temperature ?? 0,
        tools: openaiTools,
        messages,
      });

      totalInput += response.usage?.prompt_tokens ?? 0;
      totalOutput += response.usage?.completion_tokens ?? 0;

      const choice = response.choices[0];
      if (choice.message.content) allTextParts.push(choice.message.content);

      if (choice.finish_reason !== 'tool_calls' || !choice.message.tool_calls?.length) break;

      // Append assistant turn with tool_calls
      messages.push({
        role: 'assistant',
        content: choice.message.content ?? null,
        tool_calls: choice.message.tool_calls,
      });

      // Execute each tool and append results
      for (const tc of choice.message.tool_calls) {
        let result: string;
        let success = true;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          result = await callTool(tc.function.name, args);
        } catch (err) {
          result = `Error: ${err instanceof Error ? err.message : String(err)}`;
          success = false;
        }
        toolCalls.push({ name: tc.function.name, args, result, success });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
        // Include successful tool results in text so the extractor can see computed values
        // (without this, only expression text like "90/7.5" is visible, not the result "12")
        if (success) allTextParts.push(`[Tool result: ${result}]`);
      }
    }

    // If the loop exhausted maxTurns while the model still had pending tool results,
    // give it one final turn (without tools) to state its answer.
    if (turns >= maxTurns && messages.length >= 2) {
      const lastMsg = messages[messages.length - 1];
      if ((lastMsg as { role: string }).role === 'tool') {
        const finalResponse = await this.client.chat.completions.create({
          model: this.model,
          max_tokens: maxTokens,
          temperature: temperature ?? 0,
          messages,
          // No tools — force a text-only response with the final answer
        });
        totalInput += finalResponse.usage?.prompt_tokens ?? 0;
        totalOutput += finalResponse.usage?.completion_tokens ?? 0;

        const choice = finalResponse.choices[0];
        if (choice.message.content) allTextParts.push(choice.message.content);
      }
    }

    return {
      text: allTextParts.join('\n\n'),
      toolCalls,
      turns: turns + 1,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      durationMs: Date.now() - start,
    };
  }
}
