import {
  createPrismaMailboxCredentialsRepository,
  createPrismaTenantRepository,
  initializePrismaClient,
  loadConfig,
} from '@lc/core';
import { createAppInstance } from './createAppInstance.js';
import { shutdownTelemetry } from './instrumentation.js';

// Composition root: the only place in the API that reads process.env and builds singletons.
const config = loadConfig(process.env);
if (!config.SESSION_SECRET) throw new Error('SESSION_SECRET is required for the API');
const prismaClient = initializePrismaClient(config, { maxConnections: 4 });
const expressApp = createAppInstance({
  config,
  tenantRepository: createPrismaTenantRepository(prismaClient),
  mailboxCredentialsRepository: createPrismaMailboxCredentialsRepository(prismaClient),
  sessionSecret: config.SESSION_SECRET,
});

const httpServer = expressApp.listen(config.PORT, () => {
  console.log(`api listening on :${config.PORT} (${config.STAGE})`);
});

// Railway sends SIGTERM on deploy; finish in-flight requests, flush telemetry, then exit.
const DRAIN_TIMEOUT_MS = 30_000;
function shutdown(signal: NodeJS.Signals): void {
  console.log(`${signal} received, draining`);
  httpServer.close(() => {
    Promise.all([shutdownTelemetry(), prismaClient.$disconnect()]).then(
      () => process.exit(0),
      (error: unknown) => {
        console.error('telemetry shutdown failed', error);
        process.exit(1);
      },
    );
  });
  setTimeout(() => process.exit(1), DRAIN_TIMEOUT_MS).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
