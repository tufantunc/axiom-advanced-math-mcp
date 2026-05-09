import { OpenAICompatProvider } from './openai-compat.js';

export function createLocalProvider(model: string): OpenAICompatProvider {
  const baseURL = process.env.LOCAL_BASE_URL;
  if (!baseURL) throw new Error('LOCAL_BASE_URL environment variable is not set');

  const apiKey = process.env.LOCAL_API_KEY ?? 'not-needed';
  return new OpenAICompatProvider({ name: 'local', model, apiKey, baseURL });
}
