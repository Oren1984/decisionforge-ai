import type { DecisionProvider } from '../providers/decisionProvider.js';
import {
  createProviderRegistry,
  ollamaOptionsFromEnv,
  type ProviderMode,
} from '../providers/providerRegistry.js';
import { evaluateDataset } from './evaluateDataset.js';
import { loadScenarios } from './scenario.js';

// Prints comparative metrics for the dataset. Ollama is included only when it is ready.
const registry = createProviderRegistry({ ...ollamaOptionsFromEnv(), logger: () => {} });
const scenarios = await loadScenarios();

const providers: Partial<Record<ProviderMode, DecisionProvider>> = {
  rules: registry.rules,
  mock: registry.mock,
};
const health = await registry.ollama.checkHealth();
if (health.reachable && health.modelAvailable) {
  providers.ollama = registry.ollama;
} else {
  console.log(`Skipping ollama: ${health.error}`);
}

const results = await evaluateDataset(scenarios, providers);
console.table(
  results.map(({ mismatches, decisionDistribution, ...metrics }) => ({
    ...metrics,
    ...decisionDistribution,
    mismatches: mismatches.length,
  })),
);

if (results.some((metrics) => metrics.policyViolationRatePct > 0)) {
  console.error('Policy violation rate is above 0%.');
  process.exitCode = 1;
}
