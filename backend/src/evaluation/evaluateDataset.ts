import { ZodError } from 'zod';
import type { Decision, ProviderName } from '../contracts/decision.contract.js';
import type { DecisionProvider } from '../providers/decisionProvider.js';
import { executeDecisionWithTrace } from '../providers/executeDecision.js';
import type { ProviderMode } from '../providers/providerRegistry.js';
import type { Scenario } from './scenario.js';

export interface ScenarioMismatch {
  id: string;
  expected: Decision;
  /** Null when the scenario's input payload failed validation. */
  actual: Decision | null;
}

export interface ModeMetrics {
  mode: ProviderMode;
  provider: ProviderName;
  totalScenarios: number;
  decisionAccuracyPct: number;
  /** Approvals issued where the dataset says a hard constraint applies. Must be 0. */
  policyViolationRatePct: number;
  humanReviewRatePct: number;
  /** Scenarios where the provider failed and the fail-safe decided instead. */
  fallbackRatePct: number;
  averageLatencyMs: number;
  /** Scenarios with an invalid input payload or contract-violating provider output. */
  schemaValidationErrorRatePct: number;
  /** Scenarios where the policy engine replaced the provider's recommendation. */
  policyOverrideRatePct: number;
  decisionDistribution: Record<Decision, number>;
  mismatches: ScenarioMismatch[];
}

const pct = (count: number, total: number): number =>
  total === 0 ? 0 : Math.round((count / total) * 10_000) / 100;

/**
 * Runs every scenario through one provider plus the policy gate and scores the
 * final decisions against the dataset labels. The labels are authored in the
 * dataset, not derived from the policy engine, so the violation rate is an
 * independent check on enforcement rather than a restatement of it.
 */
export async function evaluateMode(
  mode: ProviderMode,
  provider: DecisionProvider,
  scenarios: readonly Scenario[],
): Promise<ModeMetrics> {
  const decisionDistribution: Record<Decision, number> = { APPROVED: 0, REJECTED: 0, HUMAN_REVIEW: 0 };
  const mismatches: ScenarioMismatch[] = [];
  let policyViolations = 0;
  let fallbacks = 0;
  let schemaErrors = 0;
  let policyOverrides = 0;
  let totalLatencyMs = 0;
  let executed = 0;

  for (const scenario of scenarios) {
    let execution;
    try {
      execution = await executeDecisionWithTrace(scenario.inputPayload, [provider]);
    } catch (error) {
      if (!(error instanceof ZodError)) throw error;
      schemaErrors += 1;
      mismatches.push({ id: scenario.id, expected: scenario.expectedDecision, actual: null });
      continue;
    }

    const { result, trace } = execution;
    executed += 1;
    totalLatencyMs += result.executionTimeMs;
    decisionDistribution[result.decision] += 1;

    if (result.decision !== scenario.expectedDecision) {
      mismatches.push({ id: scenario.id, expected: scenario.expectedDecision, actual: result.decision });
    }
    if (result.decision === 'APPROVED' && scenario.expectedPolicyTriggered.length > 0) {
      policyViolations += 1;
    }
    if (trace.failsafe) fallbacks += 1;
    if (trace.attempts.some((attempt) => attempt.outcome === 'invalid_output')) schemaErrors += 1;
    if (trace.policyOverridden) policyOverrides += 1;
  }

  const total = scenarios.length;
  return {
    mode,
    provider: provider.name,
    totalScenarios: total,
    decisionAccuracyPct: pct(total - mismatches.length, total),
    policyViolationRatePct: pct(policyViolations, total),
    humanReviewRatePct: pct(decisionDistribution.HUMAN_REVIEW, total),
    fallbackRatePct: pct(fallbacks, total),
    averageLatencyMs: executed === 0 ? 0 : Math.round((totalLatencyMs / executed) * 1000) / 1000,
    schemaValidationErrorRatePct: pct(schemaErrors, total),
    policyOverrideRatePct: pct(policyOverrides, total),
    decisionDistribution,
    mismatches,
  };
}

/** Evaluates the selected modes one after another, in the order given. */
export async function evaluateDataset(
  scenarios: readonly Scenario[],
  providers: Partial<Record<ProviderMode, DecisionProvider>>,
): Promise<ModeMetrics[]> {
  const results: ModeMetrics[] = [];
  for (const [mode, provider] of Object.entries(providers) as [ProviderMode, DecisionProvider][]) {
    results.push(await evaluateMode(mode, provider, scenarios));
  }
  return results;
}
