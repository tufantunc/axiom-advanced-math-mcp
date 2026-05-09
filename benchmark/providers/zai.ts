/**
 * z.ai provider — OpenAI-compatible API (GLM models).
 *
 * Required env vars:
 *   ZAI_API_KEY   — your z.ai API key
 *   ZAI_BASE_URL  — optional, defaults to https://api.z.ai/api/coding/paas/v4
 */
import { OpenAICompatProvider } from './openai-compat.js';

export function createZaiProvider(model: string): OpenAICompatProvider {
  const apiKey = process.env.ZAI_API_KEY;
  if (!apiKey) throw new Error('ZAI_API_KEY environment variable is not set');

  const baseURL = process.env.ZAI_BASE_URL ?? 'https://api.z.ai/api/coding/paas/v4';
  return new OpenAICompatProvider({ name: 'zai', model, apiKey, baseURL });
}
