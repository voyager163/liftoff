import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App.vue";
import { createItem, isReady, listItems } from "../api";

vi.mock("../api", () => ({
  isReady: vi.fn(),
  listItems: vi.fn(),
  createItem: vi.fn(),
}));

const item = (id: number, name: string) => ({
  id,
  name,
  created_at: "2026-01-01T00:00:00Z",
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isReady).mockResolvedValue(true);
  vi.mocked(listItems).mockResolvedValue([item(1, "first")]);
});

describe("App", () => {
  it("checks the API before showing anything else", () => {
    vi.mocked(isReady).mockReturnValue(new Promise(() => {}));
    expect(mount(App).text()).toContain("Checking the API");
  });

  it("shows the items when the API is ready", async () => {
    const app = mount(App);
    await flushPromises();
    expect(app.text()).toContain("API ready");
    expect(app.findAll("li").map((li) => li.text())).toEqual(["first"]);
  });

  it("says when there are no items yet", async () => {
    vi.mocked(listItems).mockResolvedValue([]);
    const app = mount(App);
    await flushPromises();
    expect(app.text()).toContain("No items yet.");
  });

  it("says the API is unavailable and disables the form", async () => {
    vi.mocked(isReady).mockResolvedValue(false);
    const app = mount(App);
    await flushPromises();
    expect(app.text()).toContain("API unavailable");
    expect(listItems).not.toHaveBeenCalled();
    expect(app.get("button").attributes("disabled")).toBeDefined();
  });

  it("reports items that cannot be loaded", async () => {
    vi.mocked(listItems).mockRejectedValue(
      new Error("GET /items answered 500"),
    );
    const app = mount(App);
    await flushPromises();
    expect(app.get("[role=alert]").text()).toBe(
      "Could not load the items: GET /items answered 500",
    );
  });

  it("adds an item and clears the field", async () => {
    vi.mocked(createItem).mockResolvedValue(item(2, "second"));
    const app = mount(App);
    await flushPromises();
    await app.get("input").setValue("  second  ");
    await app.get("form").trigger("submit");
    await flushPromises();
    expect(createItem).toHaveBeenCalledWith("second");
    expect(app.findAll("li").map((li) => li.text())).toEqual([
      "first",
      "second",
    ]);
    expect(app.get("input").element.value).toBe("");
  });

  it("ignores a blank name", async () => {
    const app = mount(App);
    await flushPromises();
    await app.get("input").setValue("   ");
    await app.get("form").trigger("submit");
    expect(createItem).not.toHaveBeenCalled();
  });

  it("reports an item that cannot be added", async () => {
    vi.mocked(createItem).mockRejectedValue(
      new Error("POST /items answered 422"),
    );
    const app = mount(App);
    await flushPromises();
    await app.get("input").setValue("third");
    await app.get("form").trigger("submit");
    await flushPromises();
    expect(app.get("[role=alert]").text()).toBe(
      "Could not add the item: POST /items answered 422",
    );
    expect(app.get("button").attributes("disabled")).toBeUndefined();
  });
});
