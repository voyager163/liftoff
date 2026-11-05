import { describe, expect, it } from "vitest";
import { isPostgresUrl } from "./support.ts";

describe("integration test setup", () => {
  it("accepts both PostgreSQL URL schemes and nothing else", () => {
    expect(isPostgresUrl("postgres://app@localhost:5432/app")).toBe(true);
    expect(isPostgresUrl("postgresql://app@localhost:5432/app")).toBe(true);
    expect(isPostgresUrl("")).toBe(false);
    expect(isPostgresUrl("mysql://app@localhost/app")).toBe(false);
    expect(isPostgresUrl("postgresqlx://app@localhost/app")).toBe(false);
  });
});
