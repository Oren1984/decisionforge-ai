import {
  BusinessRequestSchema,
  DecisionResultSchema,
  ProviderRecommendationSchema,
  type BusinessRequest,
  type Decision,
  type DecisionResult,
  type ProviderName,
  type ProviderRecommendation,
} from '../contracts/decision.contract.js';
import {
  enforcePolicy,
  evaluateHardConstraints,
  type HardConstraintId,
} from '../policies/policyEngine.js';
import { ProviderOutputError, type DecisionProvider } from './decisionProvider.js';

export const FAILSAFE_RULE = 'FAILSAFE_NO_PROVIDER_AVAILABLE';

export const fallbackRule = (provider: ProviderName): string => `FALLBACK_FROM_${provider}`;

export interface ExecuteDecisionOptions {
  /** Millisecond clock, injectable for reproducible timings in tests. */
  now?: () => number;
}

export interface ProviderAttempt {
  provider: ProviderName;
  /** `invalid_output`: the provider answered, but not with a contract-valid recommendation. */
  outcome: 'success' | 'error' | 'invalid_output';
  reason: string | null;
}

export interface DecisionTrace {
  attempts: ProviderAttempt[];
  /** What the provider proposed before policy enforcement; null when the fail-safe was used. */
  providerDecision: Decision | null;
  violatedConstraints: HardConstraintId[];
  policyOverridden: boolean;
  /** True when no provider produced a usable recommendation. */
  failsafe: boolean;
}

export interface DecisionExecution {
  request: BusinessRequest;
  result: DecisionResult;
  trace: DecisionTrace;
}

/**
 * Runs a request through input validation, the provider chain and the policy gate.
 *
 * Providers are tried in order. A provider that throws or returns output that
 * does not match the recommendation contract is skipped in favour of the next
 * one. If every provider fails, the result is HUMAN_REVIEW — a provider failure
 * is never converted into an approval.
 *
 * @throws ZodError when `rawRequest` does not satisfy BusinessRequestSchema.
 */
export async function executeDecisionWithTrace(
  rawRequest: unknown,
  providers: readonly DecisionProvider[],
  options: ExecuteDecisionOptions = {},
): Promise<DecisionExecution> {
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const request = BusinessRequestSchema.parse(rawRequest);

  const attempts: ProviderAttempt[] = [];
  let recommendation: ProviderRecommendation | undefined;
  let providerUsed: ProviderName | undefined;

  for (const provider of providers) {
    try {
      const parsed = ProviderRecommendationSchema.safeParse(await provider.decide(request));
      if (parsed.success) {
        attempts.push({ provider: provider.name, outcome: 'success', reason: null });
        recommendation = parsed.data;
        providerUsed = provider.name;
        break;
      }
      attempts.push({
        provider: provider.name,
        outcome: 'invalid_output',
        reason: 'output did not match the recommendation contract',
      });
    } catch (error) {
      attempts.push({
        provider: provider.name,
        outcome: error instanceof ProviderOutputError ? 'invalid_output' : 'error',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const failures = attempts.filter((attempt) => attempt.outcome !== 'success');
  const fallbackRules = failures.map((failure) => fallbackRule(failure.provider));
  const providerDecision = recommendation?.decision ?? null;

  if (!recommendation || !providerUsed) {
    const detail = failures.map((failure) => `${failure.provider}: ${failure.reason}`).join('; ');
    recommendation = {
      decision: 'HUMAN_REVIEW',
      confidenceScore: 0,
      appliedPolicyRules: [FAILSAFE_RULE],
      rationale: `No provider produced a valid recommendation; deferring to human review.${detail ? ` Failures: ${detail}.` : ''}`,
    };
    providerUsed = 'FAILSAFE';
  }

  const { overridden, ...enforced } = enforcePolicy(request, {
    ...recommendation,
    appliedPolicyRules: [...fallbackRules, ...recommendation.appliedPolicyRules],
  });

  const result = DecisionResultSchema.parse({
    ...enforced,
    providerUsed,
    executionTimeMs: Math.max(0, now() - startedAt),
  });

  return {
    request,
    result,
    trace: {
      attempts,
      providerDecision,
      violatedConstraints: evaluateHardConstraints(request).map((violation) => violation.rule),
      policyOverridden: overridden,
      failsafe: providerDecision === null,
    },
  };
}

/** Convenience wrapper returning only the final decision. */
export async function executeDecision(
  rawRequest: unknown,
  providers: readonly DecisionProvider[],
  options: ExecuteDecisionOptions = {},
): Promise<DecisionResult> {
  return (await executeDecisionWithTrace(rawRequest, providers, options)).result;
}
