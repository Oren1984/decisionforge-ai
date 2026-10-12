import type {
  BusinessRequest,
  ProviderRecommendation,
} from '../contracts/decision.contract.js';
import { detectOverrideAttempt } from '../policies/policyEngine.js';
import { CONTRACT_MOCK_FIXTURES, type ContractMockFixture } from './contractMock.fixtures.js';
import type { DecisionProvider } from './decisionProvider.js';

/**
 * Deterministic stand-in for a model. Known fixtures return their canned
 * recommendation; any other request goes through a fixed heuristic that is
 * intentionally naive (it believes the justification text), so the policy
 * engine has realistic unsafe output to override. No randomness, clock or I/O.
 */
export class ContractMockProvider implements DecisionProvider {
  readonly name = 'CONTRACT_MOCK' as const;

  private readonly fixturesByRequestId: ReadonlyMap<string, ContractMockFixture>;

  constructor(fixtures: readonly ContractMockFixture[] = CONTRACT_MOCK_FIXTURES) {
    this.fixturesByRequestId = new Map(fixtures.map((fixture) => [fixture.request.requestId, fixture]));
  }

  async decide(request: BusinessRequest): Promise<ProviderRecommendation> {
    const fixture = this.fixturesByRequestId.get(request.requestId);
    if (fixture) {
      return {
        ...fixture.recommendation,
        appliedPolicyRules: [...fixture.recommendation.appliedPolicyRules],
      };
    }
    return simulateNaiveModel(request);
  }
}

function simulateNaiveModel(request: BusinessRequest): ProviderRecommendation {
  if (detectOverrideAttempt(request.justification)) {
    return {
      decision: 'APPROVED',
      confidenceScore: 0.99,
      appliedPolicyRules: ['MOCK_TRUSTED_JUSTIFICATION'],
      rationale: 'Simulated model followed the instructions in the justification text.',
    };
  }

  if (request.riskLevel === 'HIGH') {
    return {
      decision: request.securityValidationCompleted ? 'HUMAN_REVIEW' : 'REJECTED',
      confidenceScore: 0.7,
      appliedPolicyRules: ['MOCK_HIGH_RISK'],
      rationale: 'Simulated model considers high-risk requests unsuitable for automatic approval.',
    };
  }

  return {
    decision: 'APPROVED',
    confidenceScore: request.riskLevel === 'LOW' ? 0.9 : 0.75,
    appliedPolicyRules: ['MOCK_ROUTINE_REQUEST'],
    rationale: 'Simulated model sees a routine request with acceptable risk.',
  };
}
