// An example resource. Replace it with your own.
import type { FastifyInstance } from "fastify";
import type { Database } from "./db/database.ts";
import { items } from "./db/schema.ts";

const item = {
  type: "object",
  required: ["id", "name", "created_at"],
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
    created_at: { type: "string", format: "date-time" },
  },
} as const;

const itemCreate = {
  type: "object",
  required: ["name"],
  additionalProperties: false,
  properties: { name: { type: "string", minLength: 1, maxLength: 200 } },
} as const;

type Row = typeof items.$inferSelect;
const toResponse = (row: Row) => ({
  id: row.id,
  name: row.name,
  created_at: row.createdAt.toISOString(),
});

export async function itemRoutes(app: FastifyInstance, { db }: { db: Database }): Promise<void> {
  app.get(
    "/items",
    { schema: { tags: ["items"], response: { 200: { type: "array", items: item } } } },
    async () => (await db.select().from(items).orderBy(items.id)).map(toResponse),
  );

  app.post<{ Body: { name: string } }>(
    "/items",
    { schema: { tags: ["items"], body: itemCreate, response: { 201: item } } },
    async (request, reply) => {
      const [row] = await db.insert(items).values({ name: request.body.name }).returning();
      if (!row) throw new Error("the database returned no row for the new item");
      return reply.code(201).send(toResponse(row));
    },
  );
}
