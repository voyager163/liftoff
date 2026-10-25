// Database tables. After changing them, run `npm run db:generate` and commit
// the new migration in drizzle/.
import { integer, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";

export const items = pgTable("items", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  name: varchar({ length: 200 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
