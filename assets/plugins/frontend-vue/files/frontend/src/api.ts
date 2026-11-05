// The API, at /api on the page's own origin: the Vite dev server and the
// container's nginx both forward it to the API, so the browser needs no CORS.
const API = "/api";

/** How long a request, answer included, may take before it is given up. */
export const TIMEOUT_MS = 10_000;

/** An example resource. Replace it with your own. */
export interface Item {
  id: number;
  name: string;
  created_at: string;
}

/** The API answered with an error status. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Runs a request that is aborted after TIMEOUT_MS, so a stalled API cannot leave the page waiting. */
async function withDeadline<T>(
  what: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await run(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `${what} did not answer within ${TIMEOUT_MS / 1000} seconds`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method ?? "GET";
  return withDeadline(`${method} ${path}`, async (signal) => {
    const response = await fetch(`${API}${path}`, {
      ...init,
      signal,
      headers: {
        accept: "application/json",
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
    });
    if (!response.ok) {
      throw new ApiError(
        response.status,
        `${method} ${path} answered ${response.status}`,
      );
    }
    return (await response.json()) as T;
  });
}

/** Whether the API can serve requests: false when it, or the way to it, is down or too slow. */
export async function isReady(): Promise<boolean> {
  try {
    return await withDeadline(
      "GET /health/ready",
      async (signal) => (await fetch(`${API}/health/ready`, { signal })).ok,
    );
  } catch {
    return false;
  }
}

export const listItems = (): Promise<Item[]> => request<Item[]>("/items");

export const createItem = (name: string): Promise<Item> =>
  request<Item>("/items", { method: "POST", body: JSON.stringify({ name }) });
