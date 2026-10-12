import type {
  BusinessRequest,
  ProviderRecommendation,
} from '../contracts/decision.contract.js';
import { evaluateHardConstraints } from '../policies/policyEngine.js';
import type { DecisionProvider } from './decisionProvider.js';

export const BusinessRule = {
  UNVALIDATED_HIGH_RISK_REJECTED: 'RULE_UNVALIDATED_HIGH_RISK_REJECTED',
  UNVALIDATED_MEDIUM_RISK_REVIEW: 'RULE_UNVALIDATED_MEDIUM_RISK_REVIEW',
  STANDARD_AUTO_APPROVAL: 'RULE_STANDARD_AUTO_APPROVAL',
} as const;

/** Pure deterministic decision logic over the structured fields. No model involved. */
export class RuleBasedProvider implements DecisionProvider {
  readonly name = 'DETERMINISTIC_RULES' as const;

  async decide(request: BusinessRequest): Promise<ProviderRecommendation> {
    const violations = evaluateHardConstraints(request);
    const violatedRules = violations.map((violation) => violation.rule);

    if (!request.securityValidationCompleted && request.riskLevel === 'HIGH') {
      return {
        decision: 'REJECTED',
        confidenceScore: 1,
        appliedPolicyRules: [...violatedRules, BusinessRule.UNVALIDATED_HIGH_RISK_REJECTED],
        rationale: 'High-risk request submitted without completed security validation.',
      };
    }

    if (violations.length > 0) {
      return {
        decision: 'HUMAN_REVIEW',
        confidenceScore: 1,
        appliedPolicyRules: violatedRules,
        rationale: `Escalated to human review: ${violations.map((violation) => violation.reason).join('; ')}.`,
      };
    }

    if (!request.securityValidationCompleted && request.riskLevel === 'MEDIUM') {
      return {
        decision: 'HUMAN_REVIEW',
        confidenceScore: 1,
        appliedPolicyRules: [BusinessRule.UNVALIDATED_MEDIUM_RISK_REVIEW],
        rationale: 'Medium-risk request submitted without completed security validation.',
      };
    }

    return {
      decision: 'APPROVED',
      confidenceScore: 1,
      appliedPolicyRules: [BusinessRule.STANDARD_AUTO_APPROVAL],
      rationale: 'Request is within risk, security and budget limits for automatic approval.',
    };
  }
}
