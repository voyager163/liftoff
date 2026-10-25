// Runs the API with the configured host and port: node src/server.ts
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.ts";
import { type Config, loadConfig } from "./config.ts";
import { connect } from "./db/database.ts";
import { databaseProbe } from "./health.ts";

export async function start(config: Config): Promise<FastifyInstance> {
  // Pool connections open only for requests, so app exists before any can fail.
  const { db, close } = connect(config.databaseUrl, config.databaseTimeoutSeconds, (error) =>
    app.log.warn({ err: error }, "an idle database connection failed; it will be replaced"),
  );
  const app = await buildApp({
    config,
    db,
    probe: databaseProbe(config.databaseUrl, config.databaseTimeoutSeconds),
  });
  app.addHook("onClose", close);
  await app.listen({ host: config.host, port: config.port });
  return app;
}

if (import.meta.main) {
  const app = await start(loadConfig());
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void app.close());
  }
}
