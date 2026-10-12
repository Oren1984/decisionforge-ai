import type {
  BusinessRequest,
  ProviderName,
  ProviderRecommendation,
} from '../src/contracts/decision.contract.js';
import type { DecisionProvider } from '../src/providers/decisionProvider.js';

/** A request that every rule and constraint allows to be auto-approved. */
export function buildRequest(overrides: Partial<BusinessRequest> = {}): BusinessRequest {
  return {
    requestId: '20000000-0000-4000-8000-000000000001',
    category: 'DEPLOYMENT',
    justification: 'Routine patch release of the reporting service.',
    urgency: 'LOW',
    riskLevel: 'LOW',
    securityValidationCompleted: true,
    budgetImpactUsd: 500,
    ...overrides,
  };
}

export function buildRecommendation(
  overrides: Partial<ProviderRecommendation> = {},
): ProviderRecommendation {
  return {
    decision: 'APPROVED',
    confidenceScore: 0.95,
    appliedPolicyRules: ['STUB_RULE'],
    rationale: 'Stub provider recommendation.',
    ...overrides,
  };
}

/** Provider returning a fixed value, unvalidated, as an arbitrary model might. */
export function stubProvider(name: ProviderName, output: unknown): DecisionProvider {
  return {
    name,
    decide: async () => output as ProviderRecommendation,
  };
}

export function failingProvider(name: ProviderName, message: string): DecisionProvider {
  return {
    name,
    decide: async () => {
      throw new Error(message);
    },
  };
}
