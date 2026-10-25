import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createItem, isReady, listItems, TIMEOUT_MS } from "../api";

const respond = (status: number, body: unknown = null) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

/** A fetch that never answers, until its request is aborted. */
const stalled = () =>
  vi.fn(
    (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
  );

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("isReady", () => {
  it("is true when readiness answers 200", async () => {
    const fetch = respond(200, { status: "ready" });
    vi.stubGlobal("fetch", fetch);
    expect(await isReady()).toBe(true);
    expect(fetch).toHaveBeenCalledWith("/api/health/ready", {
      signal: expect.any(AbortSignal),
    });
  });

  it("is false when the API is not ready", async () => {
    vi.stubGlobal("fetch", respond(503));
    expect(await isReady()).toBe(false);
  });

  it("is false when the API cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    expect(await isReady()).toBe(false);
  });
});

describe("items", () => {
  it("lists the items", async () => {
    const items = [
      { id: 1, name: "first", created_at: "2026-01-01T00:00:00Z" },
    ];
    const fetch = respond(200, items);
    vi.stubGlobal("fetch", fetch);
    expect(await listItems()).toEqual(items);
    expect(fetch).toHaveBeenCalledWith("/api/items", {
      signal: expect.any(AbortSignal),
      headers: { accept: "application/json" },
    });
  });

  it("creates an item with a JSON body", async () => {
    const item = { id: 2, name: "second", created_at: "2026-01-01T00:00:00Z" };
    const fetch = respond(201, item);
    vi.stubGlobal("fetch", fetch);
    expect(await createItem("second")).toEqual(item);
    expect(fetch).toHaveBeenCalledWith("/api/items", {
      method: "POST",
      body: JSON.stringify({ name: "second" }),
      signal: expect.any(AbortSignal),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
    });
  });

  it("reports an error status as an ApiError", async () => {
    vi.stubGlobal("fetch", respond(422, { detail: "invalid" }));
    const error = await createItem("").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 422,
      message: "POST /items answered 422",
    });
  });
});

describe("deadlines", () => {
  it("gives up on a request that does not answer in time", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", stalled());
    const result = expect(listItems()).rejects.toThrow(
      "GET /items did not answer within 10 seconds",
    );
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await result;
  });

  it("treats a readiness check that does not answer in time as not ready", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", stalled());
    const ready = isReady();
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    expect(await ready).toBe(false);
  });
});
