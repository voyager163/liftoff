import { flushPromises } from "@vue/test-utils";
import { expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  isReady: vi.fn(async () => false),
  listItems: vi.fn(),
  createItem: vi.fn(),
}));

it("mounts the application on #app", async () => {
  document.body.innerHTML = '<div id="app"></div>';
  await import("../main");
  await flushPromises();
  expect(document.querySelector("h1")?.textContent).toBe("{{liftoff.name}}");
});
