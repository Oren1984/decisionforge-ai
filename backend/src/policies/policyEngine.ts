import type {
  BusinessRequest,
  Decision,
  ProviderRecommendation,
} from '../contracts/decision.contract.js';

export const BUDGET_REVIEW_THRESHOLD_USD = 10_000;

export const HardConstraint = {
  /** Constraint A: no automatic approval without security validation on high-stakes requests. */
  SECURITY_VALIDATION_REQUIRED: 'HC_A_SECURITY_VALIDATION_REQUIRED',
  /** Constraint B: spend above the threshold needs a human. */
  BUDGET_THRESHOLD_REVIEW: 'HC_B_BUDGET_THRESHOLD_REVIEW',
  /** Constraint C: free text that tries to steer the decision is escalated, never obeyed. */
  UNTRUSTED_TEXT_OVERRIDE_ATTEMPT: 'HC_C_UNTRUSTED_TEXT_OVERRIDE_ATTEMPT',
  /** Constraint D: high risk is never approved automatically, even with security validation. */
  HIGH_RISK_HUMAN_REVIEW: 'HC_D_HIGH_RISK_HUMAN_REVIEW',
} as const;

export type HardConstraintId = (typeof HardConstraint)[keyof typeof HardConstraint];

/** Human-readable statement of each constraint, served to clients by GET /api/contract. */
export const HARD_CONSTRAINT_DESCRIPTIONS: Record<HardConstraintId, string> = {
  [HardConstraint.SECURITY_VALIDATION_REQUIRED]:
    'securityValidationCompleted is false and riskLevel is HIGH or urgency is CRITICAL: never approved automatically.',
  [HardConstraint.BUDGET_THRESHOLD_REVIEW]: `budgetImpactUsd is above ${BUDGET_REVIEW_THRESHOLD_USD} USD: requires human review.`,
  [HardConstraint.UNTRUSTED_TEXT_OVERRIDE_ATTEMPT]:
    'justification text tries to steer the decision or assert pre-approval: escalated, never obeyed.',
  [HardConstraint.HIGH_RISK_HUMAN_REVIEW]:
    'riskLevel is HIGH: requires human review, even when security validation is complete.',
};

export const POLICY_OVERRIDE_RULE = 'POLICY_OVERRIDE_APPLIED';

export interface ConstraintViolation {
  rule: HardConstraintId;
  reason: string;
}

export interface EnforcedDecision {
  decision: Decision;
  confidenceScore: number;
  appliedPolicyRules: string[];
  requiresHumanOversight: boolean;
  rationale: string;
  /** True when the provider's recommendation was replaced by the policy engine. */
  overridden: boolean;
}

// Phrases that try to instruct the decision-maker or assert pre-approval. A match
// can only make the outcome stricter (see enforcePolicy); it never relaxes anything.
const OVERRIDE_ATTEMPT_PATTERNS: readonly RegExp[] = [
  /\b(skip|bypass|ignore|override|disable|waive|suppress)\b.{0,40}\b(checks?|validations?|reviews?|polic(y|ies)|rules?|constraints?|security|approvals?|oversight)\b/i,
  /\b(pre-?approved|already approved|approved by|auto-?approve)\b/i,
  /\b(ignore|disregard|forget)\b.{0,40}\b(previous|prior|above|all)\b.{0,20}\b(instructions?|rules?|polic(y|ies))\b/i,
  /\b(securityValidationCompleted|riskLevel|budgetImpactUsd)\b\s*["']?\s*[:=]/i,
  /\b(system|assistant)\s*(prompt|message|:)/i,
];

export function detectOverrideAttempt(text: string): boolean {
  const normalized = text.normalize('NFKC').replace(/\s+/g, ' ');
  return OVERRIDE_ATTEMPT_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Evaluates the hard constraints from the validated, structured fields only.
 * `justification` is read solely by detectOverrideAttempt, which can add a
 * violation but can never remove one.
 */
export function evaluateHardConstraints(request: BusinessRequest): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];

  if (
    !request.securityValidationCompleted &&
    (request.riskLevel === 'HIGH' || request.urgency === 'CRITICAL')
  ) {
    violations.push({
      rule: HardConstraint.SECURITY_VALIDATION_REQUIRED,
      reason: `security validation is incomplete for a request with riskLevel=${request.riskLevel}, urgency=${request.urgency}`,
    });
  }

  if (request.budgetImpactUsd > BUDGET_REVIEW_THRESHOLD_USD) {
    violations.push({
      rule: HardConstraint.BUDGET_THRESHOLD_REVIEW,
      reason: `budget impact of ${request.budgetImpactUsd} USD exceeds the ${BUDGET_REVIEW_THRESHOLD_USD} USD review threshold`,
    });
  }

  if (detectOverrideAttempt(request.justification)) {
    violations.push({
      rule: HardConstraint.UNTRUSTED_TEXT_OVERRIDE_ATTEMPT,
      reason: 'justification text attempts to influence the decision or assert pre-approval',
    });
  }

  if (request.riskLevel === 'HIGH') {
    violations.push({
      rule: HardConstraint.HIGH_RISK_HUMAN_REVIEW,
      reason: 'riskLevel=HIGH requires human review',
    });
  }

  return violations;
}

/**
 * Post-execution gate applied to every provider recommendation. When any hard
 * constraint is violated an APPROVED recommendation is downgraded to
 * HUMAN_REVIEW; REJECTED and HUMAN_REVIEW recommendations are left as they are,
 * since the engine only ever tightens a decision.
 */
export function enforcePolicy(
  request: BusinessRequest,
  recommendation: ProviderRecommendation,
): EnforcedDecision {
  const violations = evaluateHardConstraints(request);
  const overridden = violations.length > 0 && recommendation.decision === 'APPROVED';
  const decision: Decision = overridden ? 'HUMAN_REVIEW' : recommendation.decision;

  const appliedPolicyRules = [
    ...new Set([
      ...recommendation.appliedPolicyRules,
      ...violations.map((violation) => violation.rule),
      ...(overridden ? [POLICY_OVERRIDE_RULE] : []),
    ]),
  ];

  const rationale = overridden
    ? `Policy override: provider recommended APPROVED, but ${violations
        .map((violation) => violation.reason)
        .join('; ')}. Provider rationale: ${recommendation.rationale}`
    : recommendation.rationale;

  return {
    decision,
    // An override is a deterministic policy outcome, not the provider's estimate.
    confidenceScore: overridden ? 1 : recommendation.confidenceScore,
    appliedPolicyRules,
    requiresHumanOversight: decision === 'HUMAN_REVIEW' || violations.length > 0,
    rationale,
    overridden,
  };
}
