import { randomUUID } from 'node:crypto';
import type { DecisionResult } from '../contracts/decision.contract.js';
import { executeDecisionWithTrace } from '../providers/executeDecision.js';
import type { ProviderMode, ProviderRegistry } from '../providers/providerRegistry.js';
import type { AuditEntry, AuditLog } from './auditLog.js';

export interface OrchestratedDecision {
  result: DecisionResult;
  audit: AuditEntry;
}

/**
 * Input validation -> provider execution -> policy enforcement -> audit log.
 *
 * Each mode runs its own provider only. In particular a failing Ollama call is
 * not silently answered by the rules provider: it abstains to HUMAN_REVIEW.
 *
 * @throws ZodError when `rawRequest` is not a valid business request.
 */
export async function orchestrateDecision(
  providerMode: ProviderMode,
  rawRequest: unknown,
  providers: ProviderRegistry,
  auditLog: AuditLog,
): Promise<OrchestratedDecision> {
  const { request, result, trace } = await executeDecisionWithTrace(rawRequest, [providers[providerMode]]);

  const audit: AuditEntry = {
    auditId: randomUUID(),
    timestamp: new Date().toISOString(),
    requestId: request.requestId,
    providerMode,
    providerUsed: result.providerUsed,
    attempts: trace.attempts,
    providerDecision: trace.providerDecision,
    finalDecision: result.decision,
    policyOverridden: trace.policyOverridden,
    failsafe: trace.failsafe,
    violatedConstraints: trace.violatedConstraints,
    appliedPolicyRules: result.appliedPolicyRules,
    requiresHumanOversight: result.requiresHumanOversight,
    justificationLength: request.justification.length,
    executionTimeMs: result.executionTimeMs,
  };
  auditLog.record(audit);

  return { result, audit };
}
