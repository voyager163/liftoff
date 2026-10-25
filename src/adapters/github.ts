export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface GitHubClientOptions {
  readonly token: string;
  readonly apiUrl?: string;
  readonly fetch?: Fetch;
  /** Per-request time limit. Default 15 s. */
  readonly timeoutMs?: number;
}

export class GitHubError extends Error {
  override readonly name = "GitHubError";
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** A minimal GitHub REST client: JSON GETs with pagination and time limits. */
export class GitHubClient {
  private readonly token: string;
  private readonly apiUrl: string;
  private readonly fetchImpl: Fetch;
  private readonly timeoutMs: number;

  constructor(options: GitHubClientOptions) {
    if (!options.token) throw new GitHubError("a GitHub token is required");
    this.token = options.token;
    this.apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async get<T>(route: string): Promise<T> {
    const response = await this.request(`${this.apiUrl}${route}`);
    return (await response.json()) as T;
  }

  /** Sends a JSON body; resolves to undefined for a 204 No Content answer. */
  async post<T>(route: string, body: unknown): Promise<T> {
    const response = await this.request(`${this.apiUrl}${route}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  /** Fetches every page of a list endpoint, refusing to go past `maxItems`. */
  async list<T>(route: string, maxItems: number): Promise<T[]> {
    const items: T[] = [];
    const separator = route.includes("?") ? "&" : "?";
    let url: string | undefined = `${this.apiUrl}${route}${separator}per_page=100`;
    while (url !== undefined) {
      const response = await this.request(url);
      const page = (await response.json()) as T[];
      if (!Array.isArray(page)) throw new GitHubError(`expected a list from ${route}`);
      items.push(...page);
      if (items.length > maxItems) {
        throw new GitHubError(`${route} returned more than ${maxItems} items`);
      }
      url = nextLink(response.headers.get("link"));
    }
    return items;
  }

  private async request(url: string, write?: { method: "POST"; body: string }): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...(write ?? {}),
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "liftoff",
          ...(write ? { "content-type": "application/json" } : {}),
        },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new GitHubError(`GitHub request failed: ${(error as Error).message}`);
    }
    if (!response.ok) {
      const route = url.replace(this.apiUrl, "").replace(/[?&]per_page=100/, "");
      throw new GitHubError(`GitHub ${route} returned HTTP ${response.status}`, response.status);
    }
    return response;
  }
}

function nextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part);
    if (match) return match[1];
  }
  return undefined;
}
