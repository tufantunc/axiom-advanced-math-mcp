/**
 * OpenRouter provider — unified gateway to hundreds of models.
 * Uses OpenAI-compatible API at https://openrouter.ai/api/v1
 *
 * Required env vars:
 *   OPENROUTER_API_KEY — your OpenRouter API key
 *
 * Optional env vars:
 *   OPENROUTER_BASE_URL  — defaults to https://openrouter.ai/api/v1
 *   OPENROUTER_SITE_URL  — sent as HTTP-Referer header (for rankings)
 *   OPENROUTER_APP_NAME  — sent as X-Title header (for rankings)
 *
 * Model examples:
 *   meta-llama/llama-3.3-70b-instruct
 *   deepseek/deepseek-r1
 *   google/gemini-2.0-flash-001
 *   openai/gpt-4o-mini
 *   anthropic/claude-3-5-sonnet
 *   mistralai/mistral-large
 */
import { OpenAICompatProvider } from './openai-compat.js';

export function createOpenRouterProvider(model: string): OpenAICompatProvider {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY environment variable is not set');

  const baseURL = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';

  const defaultHeaders: Record<string, string> = {
    'HTTP-Referer': process.env.OPENROUTER_SITE_URL ?? 'https://github.com/axiom-advanced-math-mcp',
    'X-Title': process.env.OPENROUTER_APP_NAME ?? 'Axiom MCP Benchmark',
  };

  return new OpenAICompatProvider({ name: 'openrouter', model, apiKey, baseURL, defaultHeaders });
}
