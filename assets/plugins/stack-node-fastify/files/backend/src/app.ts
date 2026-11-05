// Application factory: the API with its routes and documentation.
import swagger from "@fastify/swagger";
import scalar from "@scalar/fastify-api-reference";
import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.ts";
import type { Database } from "./db/database.ts";
import { type DatabaseProbe, healthRoutes } from "./health.ts";
import { itemRoutes } from "./items.ts";

export interface AppDependencies {
  readonly config: Config;
  readonly db: Database;
  readonly probe: DatabaseProbe;
}

export async function buildApp({ config, db, probe }: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: config.logLevel } });
  if (config.docsEnabled) {
    // Registered first, so it documents every route added after it.
    await app.register(swagger, {
      openapi: { openapi: "3.1.0", info: { title: "{{liftoff.name}} API", version: "0.1.0" } },
    });
    app.get("/openapi.json", { schema: { hide: true } }, () => app.swagger());
    await app.register(scalar, { routePrefix: "/docs", configuration: { url: "/openapi.json" } });
  }
  await app.register(healthRoutes, { probe });
  await app.register(itemRoutes, { db });
  return app;
}
