import { z } from 'zod';

export const JUSTIFICATION_MAX_LENGTH = 500;

export const RequestCategorySchema = z.enum([
  'DEPLOYMENT',
  'ACCESS_GRANT',
  'INFRASTRUCTURE_CHANGE',
  'VENDOR_PAYMENT',
]);
export const UrgencySchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export const RiskLevelSchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);
export const DecisionSchema = z.enum(['APPROVED', 'REJECTED', 'HUMAN_REVIEW']);
/** FAILSAFE marks a decision made because no provider produced a usable recommendation. */
export const ProviderNameSchema = z.enum([
  'DETERMINISTIC_RULES',
  'CONTRACT_MOCK',
  'LOCAL_OLLAMA',
  'FAILSAFE',
]);

/**
 * Structured business request. Strict: unknown keys are rejected, so a caller
 * cannot smuggle extra fields past validation.
 */
export const BusinessRequestSchema = z.strictObject({
  requestId: z.uuid(),
  category: RequestCategorySchema,
  justification: z.string().max(JUSTIFICATION_MAX_LENGTH),
  urgency: UrgencySchema,
  riskLevel: RiskLevelSchema,
  securityValidationCompleted: z.boolean(),
  budgetImpactUsd: z.number().positive(),
});

const decisionFields = {
  decision: DecisionSchema,
  confidenceScore: z.number().min(0).max(1),
  appliedPolicyRules: z.array(z.string()),
  rationale: z.string().min(1),
};

/**
 * What a provider (rules, mock or model) proposes. It is untrusted until it has
 * been validated against this schema and passed through the policy engine.
 */
export const ProviderRecommendationSchema = z.strictObject(decisionFields);

/** Final, policy-enforced decision returned to callers. */
export const DecisionResultSchema = z
  .strictObject({
    ...decisionFields,
    requiresHumanOversight: z.boolean(),
    providerUsed: ProviderNameSchema,
    executionTimeMs: z.number().nonnegative(),
  })
  .refine((result) => result.decision !== 'HUMAN_REVIEW' || result.requiresHumanOversight, {
    path: ['requiresHumanOversight'],
    message: 'A HUMAN_REVIEW decision must set requiresHumanOversight to true',
  });

export type RequestCategory = z.infer<typeof RequestCategorySchema>;
export type Urgency = z.infer<typeof UrgencySchema>;
export type RiskLevel = z.infer<typeof RiskLevelSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
export type ProviderName = z.infer<typeof ProviderNameSchema>;
export type BusinessRequest = z.infer<typeof BusinessRequestSchema>;
export type ProviderRecommendation = z.infer<typeof ProviderRecommendationSchema>;
export type DecisionResult = z.infer<typeof DecisionResultSchema>;
