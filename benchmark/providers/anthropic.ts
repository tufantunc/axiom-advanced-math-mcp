import Anthropic from '@anthropic-ai/sdk';
import type {
  LLMProvider,
  NeutralTool,
  ToolCallRecord,
  BaselineResult,
  ToolAugmentedResult,
} from './types.js';
import { BASELINE_SYSTEM_PROMPT, getToolPromptForProblem } from './prompts.js';

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private client: Anthropic;

  constructor(model: string, apiKey: string) {
    this.model = model;
    this.client = new Anthropic({ apiKey });
  }

  async runBaseline(
    problem: string,
    maxTokens: number,
    temperature?: number
  ): Promise<BaselineResult> {
    const start = Date.now();

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      temperature: temperature ?? 0,
      system: BASELINE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: problem }],
    });

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as Anthropic.TextBlock).text)
      .join('\n');

    return {
      text,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
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

    const anthropicTools: Anthropic.Tool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
    }));

    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: problem }];

    const toolCalls: ToolCallRecord[] = [];
    let totalInput = 0;
    let totalOutput = 0;
    const allTextParts: string[] = []; // accumulate text from ALL turns
    let turns = 0;

    for (turns = 0; turns < maxTurns; turns++) {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: maxTokens,
        temperature: temperature ?? 0,
        system: getToolPromptForProblem(problem),
        tools: anthropicTools,
        messages,
      });

      totalInput += response.usage.input_tokens;
      totalOutput += response.usage.output_tokens;

      const textBlocks = response.content.filter((b) => b.type === 'text');
      if (textBlocks.length > 0) {
        allTextParts.push(textBlocks.map((b) => (b as Anthropic.TextBlock).text).join('\n'));
      }

      if (response.stop_reason !== 'tool_use') break;

      const toolUseBlocks = response.content.filter(
        (b) => b.type === 'tool_use'
      ) as Anthropic.ToolUseBlock[];
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of toolUseBlocks) {
        let result: string;
        let success = true;
        try {
          result = await callTool(block.name, block.input as Record<string, unknown>);
        } catch (err) {
          result = `Error: ${err instanceof Error ? err.message : String(err)}`;
          success = false;
        }
        toolCalls.push({
          name: block.name,
          args: block.input as Record<string, unknown>,
          result,
          success,
        });
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
        // Include successful tool results in text so the extractor can see computed values
        // (without this, only expression text like "90/7.5" is visible, not the result "12")
        if (success) allTextParts.push(`[Tool result: ${result}]`);
      }

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
    }

    // If the loop exhausted maxTurns while the model still had pending tool results,
    // give it one final turn (without tools) to state its answer.
    if (turns >= maxTurns && messages.length >= 2) {
      const lastMsg = messages[messages.length - 1];
      const lastWasToolResult =
        lastMsg.role === 'user' &&
        Array.isArray(lastMsg.content) &&
        (lastMsg.content as Anthropic.ToolResultBlockParam[]).some((c) => c.type === 'tool_result');

      if (lastWasToolResult) {
        const finalResponse = await this.client.messages.create({
          model: this.model,
          max_tokens: maxTokens,
          temperature: temperature ?? 0,
          system: getToolPromptForProblem(problem),
          messages,
          // No tools — force a text-only response with the final answer
        });
        totalInput += finalResponse.usage.input_tokens;
        totalOutput += finalResponse.usage.output_tokens;

        const textBlocks = finalResponse.content.filter((b) => b.type === 'text');
        if (textBlocks.length > 0) {
          allTextParts.push(textBlocks.map((b) => (b as Anthropic.TextBlock).text).join('\n'));
        }
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
