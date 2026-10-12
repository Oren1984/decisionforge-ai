import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { BusinessRequestSchema } from '../src/contracts/decision.contract.js';
import { evaluateDataset, evaluateMode } from '../src/evaluation/evaluateDataset.js';
import { generateScenarios, serializeScenarios } from '../src/evaluation/generateScenarios.js';
import {
  DATASET_SIZE,
  ScenarioDatasetSchema,
  defaultDatasetPath,
  loadScenarios,
  type Scenario,
} from '../src/evaluation/scenario.js';
import { evaluateHardConstraints } from '../src/policies/policyEngine.js';
import { ContractMockProvider } from '../src/providers/contractMockProvider.js';
import { RuleBasedProvider } from '../src/providers/ruleBasedProvider.js';
import { buildRecommendation, buildRequest, failingProvider, stubProvider } from './helpers.js';

const scenarios = generateScenarios();

const scenario = (overrides: Partial<Scenario> = {}): Scenario => ({
  id: 'TEST-001',
  inputPayload: buildRequest(),
  expectedDecision: 'APPROVED',
  expectedPolicyTriggered: [],
  riskTier: 'LOW',
  ...overrides,
});

describe('synthetic scenario dataset', () => {
  it('has exactly 100 schema-valid scenarios', () => {
    expect(scenarios).toHaveLength(DATASET_SIZE);
    expect(ScenarioDatasetSchema.safeParse(scenarios).success).toBe(true);
  });

  it('has unique scenario and request ids', () => {
    expect(new Set(scenarios.map((entry) => entry.id)).size).toBe(DATASET_SIZE);
    expect(new Set(scenarios.map((entry) => entry.inputPayload.requestId)).size).toBe(DATASET_SIZE);
  });

  it('is generated deterministically', () => {
    expect(generateScenarios()).toEqual(scenarios);
  });

  it('matches the committed data/synthetic_scenarios.json', async () => {
    expect(await readFile(defaultDatasetPath(), 'utf8')).toBe(serializeScenarios(scenarios));
    expect(await loadScenarios()).toEqual(scenarios);
  });

  it('covers approvals, rejections, escalations and edge cases', () => {
    const countByPrefix = (prefix: string) => scenarios.filter((entry) => entry.id.startsWith(prefix)).length;
    expect({
      approvals: countByPrefix('APR'),
      rejections: countByPrefix('REJ'),
      escalations: countByPrefix('ESC'),
      edgeCases: countByPrefix('EDGE'),
    }).toEqual({ approvals: 35, rejections: 20, escalations: 25, edgeCases: 20 });

    const decisions = new Set(scenarios.map((entry) => entry.expectedDecision));
    expect(decisions).toEqual(new Set(['APPROVED', 'REJECTED', 'HUMAN_REVIEW']));
  });

  it('exercises every category, urgency and risk level', () => {
    const values = (field: 'category' | 'urgency' | 'riskLevel') =>
      new Set(scenarios.map((entry) => entry.inputPayload[field]));
    expect(values('category').size).toBe(BusinessRequestSchema.shape.category.options.length);
    expect(values('urgency').size).toBe(BusinessRequestSchema.shape.urgency.options.length);
    expect(values('riskLevel').size).toBe(BusinessRequestSchema.shape.riskLevel.options.length);
  });

  it('has hand-written policy labels that agree with the policy engine', () => {
    for (const entry of scenarios) {
      const triggered = evaluateHardConstraints(entry.inputPayload).map((violation) => violation.rule);
      expect(triggered, entry.id).toEqual(entry.expectedPolicyTriggered);
    }
  });

  it('never expects approval where a hard constraint applies', () => {
    const contradictory = scenarios.filter(
      (entry) => entry.expectedPolicyTriggered.length > 0 && entry.expectedDecision === 'APPROVED',
    );
    expect(contradictory).toEqual([]);
  });
});

describe('evaluateMode', () => {
  it('scores the rule-based provider at 100% with no violations', async () => {
    const metrics = await evaluateMode('rules', new RuleBasedProvider(), scenarios);

    expect(metrics).toMatchObject({
      mode: 'rules',
      provider: 'DETERMINISTIC_RULES',
      totalScenarios: 100,
      decisionAccuracyPct: 100,
      policyViolationRatePct: 0,
      fallbackRatePct: 0,
      schemaValidationErrorRatePct: 0,
      policyOverrideRatePct: 0,
      decisionDistribution: { APPROVED: 42, REJECTED: 25, HUMAN_REVIEW: 33 },
      mismatches: [],
    });
    expect(metrics.humanReviewRatePct).toBe(33);
    expect(metrics.averageLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('shows the mock as less accurate but still free of policy violations', async () => {
    const metrics = await evaluateMode('mock', new ContractMockProvider(), scenarios);

    expect(metrics.policyViolationRatePct).toBe(0);
    expect(metrics.decisionAccuracyPct).toBeLessThan(100);
    expect(metrics.decisionAccuracyPct).toBeGreaterThan(80);
    // The naive mock approves requests the policy engine then has to pull back.
    expect(metrics.policyOverrideRatePct).toBeGreaterThan(0);
    expect(metrics.mismatches).toHaveLength(Math.round(100 - metrics.decisionAccuracyPct));
  });

  it('keeps the violation rate at 0% for a provider that approves everything', async () => {
    const approveAll = stubProvider('LOCAL_OLLAMA', buildRecommendation({ decision: 'APPROVED' }));
    const metrics = await evaluateMode('ollama', approveAll, scenarios);

    expect(metrics.policyViolationRatePct).toBe(0);
    expect(metrics.decisionDistribution.REJECTED).toBe(0);
    expect(metrics.policyOverrideRatePct).toBeGreaterThan(0);
  });

  it('counts provider failures as fallbacks to human review', async () => {
    const metrics = await evaluateMode('ollama', failingProvider('LOCAL_OLLAMA', 'timeout'), scenarios);

    expect(metrics.fallbackRatePct).toBe(100);
    expect(metrics.humanReviewRatePct).toBe(100);
    expect(metrics.schemaValidationErrorRatePct).toBe(0);
    expect(metrics.policyViolationRatePct).toBe(0);
    expect(metrics.decisionDistribution).toEqual({ APPROVED: 0, REJECTED: 0, HUMAN_REVIEW: 100 });
  });

  it('counts contract-violating provider output as schema validation errors', async () => {
    const metrics = await evaluateMode('ollama', stubProvider('LOCAL_OLLAMA', { decision: 'APPROVED' }), scenarios);

    expect(metrics.schemaValidationErrorRatePct).toBe(100);
    expect(metrics.fallbackRatePct).toBe(100);
    expect(metrics.policyViolationRatePct).toBe(0);
  });

  it('counts an invalid input payload as a schema error and a mismatch', async () => {
    const invalid = scenario({ id: 'BAD-001', inputPayload: { ...buildRequest(), budgetImpactUsd: -1 } });
    const metrics = await evaluateMode('rules', new RuleBasedProvider(), [scenario(), invalid]);

    expect(metrics.schemaValidationErrorRatePct).toBe(50);
    expect(metrics.decisionAccuracyPct).toBe(50);
    expect(metrics.mismatches).toEqual([{ id: 'BAD-001', expected: 'APPROVED', actual: null }]);
  });

  it('detects a policy violation when one is present', async () => {
    // Mislabelled on purpose: the engine approves, but the label says a constraint applies.
    const mislabelled = scenario({ expectedPolicyTriggered: ['HC_B_BUDGET_THRESHOLD_REVIEW'] });
    const metrics = await evaluateMode('rules', new RuleBasedProvider(), [mislabelled]);
    expect(metrics.policyViolationRatePct).toBe(100);
  });

  it('returns zeroed metrics for an empty dataset', async () => {
    const metrics = await evaluateMode('rules', new RuleBasedProvider(), []);
    expect(metrics).toMatchObject({ totalScenarios: 0, decisionAccuracyPct: 0, averageLatencyMs: 0 });
  });
});

describe('evaluateDataset', () => {
  it('returns one result per selected mode, in order', async () => {
    const results = await evaluateDataset(scenarios, {
      mock: new ContractMockProvider(),
      rules: new RuleBasedProvider(),
    });
    expect(results.map((metrics) => metrics.mode)).toEqual(['mock', 'rules']);
  });
});
