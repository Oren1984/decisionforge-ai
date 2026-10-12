import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { z, ZodError } from 'zod';
import { BusinessRequestSchema, DecisionResultSchema } from '../contracts/decision.contract.js';
import { evaluateDataset } from '../evaluation/evaluateDataset.js';
import { DATASET_SIZE, type Scenario } from '../evaluation/scenario.js';
import {
  BUDGET_REVIEW_THRESHOLD_USD,
  HARD_CONSTRAINT_DESCRIPTIONS,
} from '../policies/policyEngine.js';
import type { DecisionProvider } from '../providers/decisionProvider.js';
import {
  ProviderModeSchema,
  type ProviderMode,
  type ProviderRegistry,
} from '../providers/providerRegistry.js';
import type { AuditLog } from './auditLog.js';
import { orchestrateDecision } from './decisionOrchestrator.js';

export interface AppDependencies {
  providers: ProviderRegistry;
  auditLog: AuditLog;
  loadScenarios: () => Promise<Scenario[]>;
}

// `request` is validated by the orchestrator, so it stays unknown here.
const DecisionBodySchema = z.strictObject({
  providerMode: ProviderModeSchema.default('rules'),
  request: z.unknown(),
});

const EvaluateBodySchema = z
  .strictObject({
    modes: z.array(ProviderModeSchema).min(1).default(['rules', 'mock']),
    /** Evaluate only the first N scenarios, e.g. for a quick Ollama run. */
    limit: z.number().int().min(1).max(DATASET_SIZE).optional(),
  })
  .default({ modes: ['rules', 'mock'] });

const AuditQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(1_000).default(50),
});

// Static description of the contract and policy, derived from the live schemas.
const CONTRACT_DESCRIPTION = {
  requestSchema: z.toJSONSchema(BusinessRequestSchema),
  resultSchema: z.toJSONSchema(DecisionResultSchema),
  budgetReviewThresholdUsd: BUDGET_REVIEW_THRESHOLD_USD,
  hardConstraints: Object.entries(HARD_CONSTRAINT_DESCRIPTIONS).map(([id, description]) => ({
    id,
    description,
  })),
};

export function buildApp(deps: AppDependencies, options: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify(options);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: 'VALIDATION_ERROR',
        issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      });
    }
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    if (statusCode >= 500) app.log.error(error);
    return reply.status(statusCode).send({
      error: statusCode >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST',
      message: statusCode >= 500 ? 'Unexpected server error' : (error as Error).message,
    });
  });

  app.post('/api/decision', async (request) => {
    const body = DecisionBodySchema.parse(request.body);
    return orchestrateDecision(body.providerMode, body.request, deps.providers, deps.auditLog);
  });

  app.get('/api/health', async () => ({
    status: 'ok',
    backend: { uptimeSeconds: Math.round(process.uptime()) },
    ollama: await deps.providers.ollama.checkHealth(),
  }));

  app.get('/api/contract', async () => CONTRACT_DESCRIPTION);

  app.get('/api/scenarios', async () => deps.loadScenarios());

  app.get('/api/audit', async (request) => {
    const { limit } = AuditQuerySchema.parse(request.query);
    return { entries: deps.auditLog.recent(limit) };
  });

  app.post('/api/evaluate', async (request) => {
    const body = EvaluateBodySchema.parse(request.body ?? undefined);
    const modes = [...new Set(body.modes)];
    const scenarios = (await deps.loadScenarios()).slice(0, body.limit);

    const selected: Partial<Record<ProviderMode, DecisionProvider>> = {};
    const skipped: { mode: ProviderMode; reason: string }[] = [];
    for (const mode of modes) {
      if (mode === 'ollama') {
        const health = await deps.providers.ollama.checkHealth();
        if (!health.reachable || !health.modelAvailable) {
          skipped.push({ mode, reason: health.error ?? 'Ollama is not available' });
          continue;
        }
      }
      selected[mode] = deps.providers[mode];
    }

    return {
      datasetSize: scenarios.length,
      results: await evaluateDataset(scenarios, selected),
      skipped,
    };
  });

  return app;
}
