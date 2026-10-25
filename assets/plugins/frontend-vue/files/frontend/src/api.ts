// The API, at /api on the page's own origin: the Vite dev server and the
// container's nginx both forward it to the API, so the browser needs no CORS.
const API = "/api";

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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
  });
  if (!response.ok) {
    const method = init.method ?? "GET";
    throw new ApiError(
      response.status,
      `${method} ${path} answered ${response.status}`,
    );
  }
  return (await response.json()) as T;
}

/** Whether the API can serve requests: false when it, or the way to it, is down. */
export async function isReady(): Promise<boolean> {
  try {
    return (await fetch(`${API}/health/ready`)).ok;
  } catch {
    return false;
  }
}

export const listItems = (): Promise<Item[]> => request<Item[]>("/items");

export const createItem = (name: string): Promise<Item> =>
  request<Item>("/items", { method: "POST", body: JSON.stringify({ name }) });
