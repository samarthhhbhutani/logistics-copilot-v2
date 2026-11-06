import { loadConfig } from '@lc/core';
import { createAppInstance } from './createAppInstance.js';

// Composition root: the only place in the API that reads process.env.
const config = loadConfig(process.env);
const expressApp = createAppInstance({ config });

const httpServer = expressApp.listen(config.PORT, () => {
  console.log(`api listening on :${config.PORT} (${config.STAGE})`);
});

// Railway sends SIGTERM on deploy; finish in-flight requests first, then exit.
const DRAIN_TIMEOUT_MS = 30_000;
function shutdown(signal: NodeJS.Signals): void {
  console.log(`${signal} received, draining`);
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), DRAIN_TIMEOUT_MS).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
