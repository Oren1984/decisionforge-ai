import { loadScenarios } from '../evaluation/scenario.js';
import { createProviderRegistry, ollamaOptionsFromEnv } from '../providers/providerRegistry.js';
import { buildApp } from './app.js';
import { InMemoryAuditLog } from './auditLog.js';

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST ?? '0.0.0.0';

// The registry needs the app's logger and the app needs the registry, so the
// logger is reached through this late-bound reference.
let app: ReturnType<typeof buildApp>;

app = buildApp(
  {
    providers: createProviderRegistry({
      ...ollamaOptionsFromEnv(),
      logger: (message, details) => app.log.warn(details, message),
    }),
    auditLog: new InMemoryAuditLog((entry) => app.log.info({ audit: entry }, 'decision audit')),
    loadScenarios: () => loadScenarios(),
  },
  { logger: true },
);

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
