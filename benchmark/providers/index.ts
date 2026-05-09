import type { LLMProvider } from './types.js';
import { AnthropicProvider } from './anthropic.js';
import { createZaiProvider } from './zai.js';
import { createOpenRouterProvider } from './openrouter.js';
import { createLocalProvider } from './local.js';

export type ProviderName = 'anthropic' | 'zai' | 'openrouter' | 'local';

export { type LLMProvider };

export function createProvider(provider: ProviderName, model: string): LLMProvider {
  switch (provider) {
    case 'anthropic': {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error('ANTHROPIC_API_KEY environment variable is not set');
      return new AnthropicProvider(model, apiKey);
    }
    case 'zai':
      return createZaiProvider(model);
    case 'openrouter':
      return createOpenRouterProvider(model);
    case 'local':
      return createLocalProvider(model);
    default:
      throw new Error(`Unknown provider: ${provider as string}`);
  }
}
