import { z } from 'zod';
import { ContractMockProvider } from './contractMockProvider.js';
import type { DecisionProvider } from './decisionProvider.js';
import { OllamaProvider, type OllamaProviderOptions } from './ollamaProvider.js';
import { RuleBasedProvider } from './ruleBasedProvider.js';

export const ProviderModeSchema = z.enum(['rules', 'mock', 'ollama']);
export type ProviderMode = z.infer<typeof ProviderModeSchema>;

export interface ProviderRegistry {
  rules: DecisionProvider;
  mock: DecisionProvider;
  ollama: OllamaProvider;
}

export function createProviderRegistry(ollamaOptions: OllamaProviderOptions = {}): ProviderRegistry {
  return {
    rules: new RuleBasedProvider(),
    mock: new ContractMockProvider(),
    ollama: new OllamaProvider(ollamaOptions),
  };
}

/** Ollama settings from the environment; unset or invalid values fall back to the defaults. */
export function ollamaOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): OllamaProviderOptions {
  const timeoutMs = Number(env.OLLAMA_TIMEOUT_MS);
  return {
    ...(env.OLLAMA_BASE_URL ? { baseUrl: env.OLLAMA_BASE_URL } : {}),
    ...(env.OLLAMA_MODEL ? { model: env.OLLAMA_MODEL } : {}),
    ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
  };
}
