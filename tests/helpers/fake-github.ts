import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakePullRequest {
  files: { filename: string; previous_filename?: string; additions: number; deletions: number }[];
  reviews: {
    user: { login: string; type: string } | null;
    state: string;
    commit_id: string;
    submitted_at?: string;
  }[];
  permissions: Record<string, string>;
  /** Served for GET /repos/:repo/pulls/:number (workflow_dispatch runs). */
  pull?: {
    number: number;
    state: string;
    head: { sha: string };
    base: { ref: string };
    user: { login: string };
  };
}

export interface PostedStatus {
  sha: string;
  body: { state: string; context: string; description: string; target_url?: string };
}

/**
 * A local HTTP server answering the few GitHub REST routes the review-policy
 * check reads. Lists are served in pages of `pageSize` with Link headers.
 */
export async function startFakeGitHub(
  repository: string,
  number: number,
  pr: FakePullRequest,
  pageSize = 100,
): Promise<{
  url: string;
  requests: string[];
  statuses: PostedStatus[];
  close: () => Promise<void>;
}> {
  const requests: string[] = [];
  const statuses: PostedStatus[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    requests.push(`${req.headers.authorization ?? ""} ${url.pathname}${url.search}`);
    const base = `/repos/${repository}/pulls/${number}`;
    const send = (status: number, body: unknown, link?: string) => {
      res.writeHead(status, { "content-type": "application/json", ...(link ? { link } : {}) });
      res.end(JSON.stringify(body));
    };
    const page = (items: unknown[]) => {
      const current = Number(url.searchParams.get("page") ?? "1");
      const slice = items.slice((current - 1) * pageSize, current * pageSize);
      const hasNext = current * pageSize < items.length;
      const next = new URL(url);
      next.searchParams.set("page", String(current + 1));
      const address = server.address() as AddressInfo;
      send(
        200,
        slice,
        hasNext
          ? `<http://127.0.0.1:${address.port}${next.pathname}${next.search}>; rel="next"`
          : undefined,
      );
    };

    const status = new RegExp(`^/repos/${repository}/statuses/([0-9a-z]+)$`).exec(url.pathname);
    if (req.method === "POST" && status) {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        statuses.push({
          sha: status[1] ?? "",
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
        send(201, { id: statuses.length });
      });
      return;
    }
    if (url.pathname === base && pr.pull) return send(200, pr.pull);
    if (url.pathname === `${base}/files`) return page(pr.files);
    if (url.pathname === `${base}/reviews`) return page(pr.reviews);
    const permission = new RegExp(`^/repos/${repository}/collaborators/([^/]+)/permission$`).exec(
      url.pathname,
    );
    if (permission) {
      const login = decodeURIComponent(permission[1] ?? "");
      const role = pr.permissions[login] ?? "read";
      return send(200, { permission: role === "maintain" ? "write" : role, role_name: role });
    }
    send(404, { message: "Not Found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    statuses,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
