// Liveness and readiness.
//
// /health/live says the process is running and never touches dependencies.
// /health/ready checks each dependency the API needs to serve requests and
// answers 503 when one is unavailable, so traffic is only sent when it can be
// handled.
import type { FastifyInstance } from "fastify";
import pg from "pg";

/** Resolves when the database answers; rejects otherwise. */
export type DatabaseProbe = () => Promise<void>;

/**
 * Checks the database over a new connection every time. A pooled connection
 * to a database that stopped responding would leave the check waiting
 * forever; here the connection and the query are both bounded by the
 * timeout, and the connection is always closed.
 */
export function databaseProbe(url: string, timeoutSeconds: number): DatabaseProbe {
  const timeout = timeoutSeconds * 1000;
  return async () => {
    const client = new pg.Client({
      connectionString: url,
      connectionTimeoutMillis: timeout,
      query_timeout: timeout,
      statement_timeout: timeout,
    });
    try {
      await client.connect();
      await client.query("SELECT 1");
    } finally {
      // With a query still waiting, end() drops the connection instead of
      // waiting for a server that may never answer.
      await client.end().catch(() => undefined);
    }
  };
}

const status = {
  type: "object",
  required: ["status"],
  properties: { status: { type: "string" } },
} as const;

const readiness = {
  type: "object",
  required: ["status", "checks"],
  properties: {
    status: { type: "string", enum: ["ready", "not-ready"] },
    checks: {
      type: "object",
      required: ["database"],
      properties: { database: { type: "string", enum: ["ok", "unavailable"] } },
    },
  },
} as const;

export async function healthRoutes(
  app: FastifyInstance,
  { probe }: { probe: DatabaseProbe },
): Promise<void> {
  app.get("/health/live", { schema: { tags: ["health"], response: { 200: status } } }, () => ({
    status: "ok",
  }));

  app.get(
    "/health/ready",
    { schema: { tags: ["health"], response: { 200: readiness, 503: readiness } } },
    async (request, reply) => {
      let database: "ok" | "unavailable" = "ok";
      try {
        await probe();
      } catch (error) {
        // Any failure means not ready; the detail is logged, not returned.
        request.log.warn({ err: error }, "database readiness check failed");
        database = "unavailable";
      }
      const ready = database === "ok";
      return reply
        .code(ready ? 200 : 503)
        .send({ status: ready ? "ready" : "not-ready", checks: { database } });
    },
  );
}
