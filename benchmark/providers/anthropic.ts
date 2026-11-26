import Anthropic from '@anthropic-ai/sdk';
import type {
  LLMProvider,
  NeutralTool,
  ToolCallRecord,
  BaselineResult,
  ToolAugmentedResult,
} from './types.js';
import { BASELINE_SYSTEM_PROMPT, getToolPromptForProblem } from './prompts.js';

/**
 * Claude API version 2026-10-21, which @anthropic-ai/sdk 1.x sends, refuses
 * `temperature`, `top_p` and `top_k` on every model with a 400, so this provider
 * sends none and Claude samples at its defaults. Runs before the 1.x upgrade
 * sent `temperature: 0` and are not directly comparable with later ones.
 *
 * A caller-chosen temperature (self-consistency's, by default 0.7) is therefore
 * ignored here, and said so once on stderr rather than silently: the run's
 * provenance still records the value that was asked for.
 */
let warnedAboutTemperature = false;
function noteIgnoredTemperature(temperature: number | undefined): void {
  if (temperature === undefined || warnedAboutTemperature) return;
  warnedAboutTemperature = true;
  console.error(
    `[anthropic] temperature=${temperature} ignored: the Claude API no longer accepts ` +
      'sampling parameters, so Claude samples at its defaults'
  );
}

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
    noteIgnoredTemperature(temperature);
    const start = Date.now();

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
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
    noteIgnoredTemperature(temperature);
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
