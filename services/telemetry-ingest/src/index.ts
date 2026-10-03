import {
  createAzureTelemetryIngestionDependencies,
  readAzureTelemetryIngestionConfig
} from './handler.js';
import {
  closeTelemetryServer,
  createTelemetryServer,
  listenTelemetryServer
} from './server.js';

const dependencies = createAzureTelemetryIngestionDependencies(
  readAzureTelemetryIngestionConfig()
);
await dependencies.warmUp();
const server = createTelemetryServer(() => dependencies);
await listenTelemetryServer(server);

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  const forceClose = setTimeout(() => {
    // Forcing connections closed abandons in-flight requests, so it is not a clean exit.
    process.exitCode = 1;
    server.closeAllConnections();
  }, 25_000);
  forceClose.unref();
  void closeTelemetryServer(server)
    .catch(() => {
      process.exitCode = 1;
    })
    .finally(() => clearTimeout(forceClose));
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
