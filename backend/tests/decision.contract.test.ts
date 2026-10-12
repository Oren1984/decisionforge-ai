import { describe, expect, it } from 'vitest';
import {
  BusinessRequestSchema,
  DecisionResultSchema,
  JUSTIFICATION_MAX_LENGTH,
  ProviderRecommendationSchema,
  type DecisionResult,
} from '../src/contracts/decision.contract.js';
import { buildRecommendation, buildRequest } from './helpers.js';

const validResult: DecisionResult = {
  decision: 'APPROVED',
  confidenceScore: 0.9,
  appliedPolicyRules: ['RULE_STANDARD_AUTO_APPROVAL'],
  requiresHumanOversight: false,
  rationale: 'Within limits.',
  providerUsed: 'DETERMINISTIC_RULES',
  executionTimeMs: 1.5,
};

describe('BusinessRequestSchema', () => {
  it('accepts a valid payload and returns it unchanged', () => {
    const request = buildRequest();
    expect(BusinessRequestSchema.parse(request)).toEqual(request);
  });

  it.each([
    'requestId',
    'category',
    'justification',
    'urgency',
    'riskLevel',
    'securityValidationCompleted',
    'budgetImpactUsd',
  ] as const)('rejects a payload missing %s', (field) => {
    const { [field]: _removed, ...payload } = buildRequest();
    const result = BusinessRequestSchema.safeParse(payload);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual([field]);
  });

  it('rejects a requestId that is not a UUID', () => {
    expect(BusinessRequestSchema.safeParse(buildRequest({ requestId: 'REQ-42' })).success).toBe(false);
  });

  it.each([
    ['category', 'PAYROLL'],
    ['urgency', 'URGENT'],
    // CRITICAL is a valid urgency but not a valid risk level.
    ['riskLevel', 'CRITICAL'],
  ])('rejects an unknown %s value', (field, value) => {
    expect(BusinessRequestSchema.safeParse({ ...buildRequest(), [field]: value }).success).toBe(false);
  });

  it('enforces the justification length limit at the boundary', () => {
    const atLimit = buildRequest({ justification: 'a'.repeat(JUSTIFICATION_MAX_LENGTH) });
    const overLimit = buildRequest({ justification: 'a'.repeat(JUSTIFICATION_MAX_LENGTH + 1) });
    expect(BusinessRequestSchema.safeParse(atLimit).success).toBe(true);
    expect(BusinessRequestSchema.safeParse(overLimit).success).toBe(false);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects budgetImpactUsd of %s',
    (budgetImpactUsd) => {
      expect(BusinessRequestSchema.safeParse(buildRequest({ budgetImpactUsd })).success).toBe(false);
    },
  );

  it.each([
    ['securityValidationCompleted', 'true'],
    ['securityValidationCompleted', 1],
    ['budgetImpactUsd', '500'],
  ])('does not coerce %s from %j', (field, value) => {
    expect(BusinessRequestSchema.safeParse({ ...buildRequest(), [field]: value }).success).toBe(false);
  });

  it('rejects unknown keys', () => {
    const payload = { ...buildRequest(), decision: 'APPROVED' };
    expect(BusinessRequestSchema.safeParse(payload).success).toBe(false);
  });
});

describe('ProviderRecommendationSchema', () => {
  it('accepts a valid recommendation', () => {
    expect(ProviderRecommendationSchema.safeParse(buildRecommendation()).success).toBe(true);
  });

  it.each([-0.01, 1.01])('rejects confidenceScore of %s', (confidenceScore) => {
    expect(
      ProviderRecommendationSchema.safeParse(buildRecommendation({ confidenceScore })).success,
    ).toBe(false);
  });

  it('rejects a decision outside the enum', () => {
    const payload = { ...buildRecommendation(), decision: 'MAYBE' };
    expect(ProviderRecommendationSchema.safeParse(payload).success).toBe(false);
  });
});

describe('DecisionResultSchema', () => {
  it('accepts a valid result', () => {
    expect(DecisionResultSchema.parse(validResult)).toEqual(validResult);
  });

  it.each([0, 1])('accepts the confidenceScore bound %s', (confidenceScore) => {
    expect(DecisionResultSchema.safeParse({ ...validResult, confidenceScore }).success).toBe(true);
  });

  it.each([-0.1, 1.1])('rejects confidenceScore of %s', (confidenceScore) => {
    expect(DecisionResultSchema.safeParse({ ...validResult, confidenceScore }).success).toBe(false);
  });

  it('rejects a negative executionTimeMs', () => {
    expect(DecisionResultSchema.safeParse({ ...validResult, executionTimeMs: -1 }).success).toBe(false);
  });

  it('rejects an unknown providerUsed', () => {
    expect(DecisionResultSchema.safeParse({ ...validResult, providerUsed: 'OPENAI' }).success).toBe(false);
  });

  it('rejects appliedPolicyRules containing non-strings', () => {
    expect(DecisionResultSchema.safeParse({ ...validResult, appliedPolicyRules: [1] }).success).toBe(false);
  });

  it('rejects HUMAN_REVIEW that does not require human oversight', () => {
    const payload = { ...validResult, decision: 'HUMAN_REVIEW', requiresHumanOversight: false };
    expect(DecisionResultSchema.safeParse(payload).success).toBe(false);
  });
});
