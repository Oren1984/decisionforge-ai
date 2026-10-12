import type { Decision, ProviderName } from '../contracts/decision.contract.js';
import type { HardConstraintId } from '../policies/policyEngine.js';
import type { ProviderAttempt } from '../providers/executeDecision.js';
import type { ProviderMode } from '../providers/providerRegistry.js';

/**
 * One record per decision. The justification text is not stored — it is
 * untrusted and may hold sensitive detail — only its length.
 */
export interface AuditEntry {
  auditId: string;
  timestamp: string;
  requestId: string;
  providerMode: ProviderMode;
  providerUsed: ProviderName;
  attempts: ProviderAttempt[];
  providerDecision: Decision | null;
  finalDecision: Decision;
  policyOverridden: boolean;
  failsafe: boolean;
  violatedConstraints: HardConstraintId[];
  appliedPolicyRules: string[];
  requiresHumanOversight: boolean;
  justificationLength: number;
  executionTimeMs: number;
}

export interface AuditLog {
  record(entry: AuditEntry): void;
  /** Most recent entries, oldest first. */
  recent(limit?: number): AuditEntry[];
}

/** Keeps the most recent entries in memory and forwards each one to an optional sink. */
export class InMemoryAuditLog implements AuditLog {
  private readonly entries: AuditEntry[] = [];

  constructor(
    private readonly sink: (entry: AuditEntry) => void = () => {},
    private readonly capacity = 1_000,
  ) {}

  record(entry: AuditEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.shift();
    this.sink(entry);
  }

  recent(limit = this.capacity): AuditEntry[] {
    return this.entries.slice(-limit);
  }
}
