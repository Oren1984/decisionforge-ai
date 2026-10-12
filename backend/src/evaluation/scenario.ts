import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { BusinessRequestSchema, DecisionSchema } from '../contracts/decision.contract.js';
import { HardConstraint } from '../policies/policyEngine.js';

export const DATASET_SIZE = 100;

/**
 * LOW: expected to be auto-approved. MEDIUM: escalated by a business rule only.
 * HIGH: at least one hard constraint applies.
 */
export const RiskTierSchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);

export const ScenarioSchema = z.strictObject({
  id: z.string().min(1),
  inputPayload: BusinessRequestSchema,
  expectedDecision: DecisionSchema,
  /** Hard constraints the request should trigger; empty when none apply. */
  expectedPolicyTriggered: z.array(z.enum(Object.values(HardConstraint))),
  riskTier: RiskTierSchema,
});

export const ScenarioDatasetSchema = z.array(ScenarioSchema).length(DATASET_SIZE);

export type Scenario = z.infer<typeof ScenarioSchema>;

/** Resolved from the working directory, so run the backend from the repository root. */
export const defaultDatasetPath = (): string =>
  process.env.DATASET_PATH ?? path.resolve(process.cwd(), 'data', 'synthetic_scenarios.json');

export async function loadScenarios(datasetPath: string = defaultDatasetPath()): Promise<Scenario[]> {
  return ScenarioDatasetSchema.parse(JSON.parse(await readFile(datasetPath, 'utf8')));
}
