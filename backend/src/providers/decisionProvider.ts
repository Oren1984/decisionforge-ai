import type {
  BusinessRequest,
  ProviderName,
  ProviderRecommendation,
} from '../contracts/decision.contract.js';

/**
 * A source of decision recommendations. Implementations return a proposal only;
 * validation, policy enforcement and timing are owned by executeDecision.
 */
export interface DecisionProvider {
  readonly name: ProviderName;
  decide(request: BusinessRequest): Promise<ProviderRecommendation>;
}

/**
 * Thrown by a provider that received output it could not turn into a valid
 * recommendation (unparseable JSON, contract mismatch). Distinguished from
 * availability errors so schema failures can be measured separately.
 */
export class ProviderOutputError extends Error {
  override readonly name = 'ProviderOutputError';
}
