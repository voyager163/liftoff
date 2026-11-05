import type { GitHubApiPort } from "../application/ports.ts";
import { ProcessError, run } from "./process.ts";

/** A GitHub request that failed, with the HTTP status when GitHub gave one. */
export class GitHubApiError extends Error {
  override readonly name = "GitHubApiError";
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** owner/name from a GitHub remote URL, over HTTPS or SSH. */
export function githubRepository(url: string): string | undefined {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(
      url.trim(),
    );
  return match?.[1];
}

/**
 * GitHub's REST API through `gh api`, so every request uses the person's own
 * GitHub CLI login and Liftoff never handles a token.
 */
export class GhCli implements GitHubApiPort {
  private readonly cwd: string;
  private readonly command: string;
  private readonly prefix: readonly string[];

  constructor(cwd: string, command = "gh", prefix: readonly string[] = []) {
    this.cwd = cwd;
    this.command = command;
    this.prefix = prefix;
  }

  async repositoryOf(directory: string): Promise<string | undefined> {
    try {
      const result = await run("git", ["remote", "get-url", "origin"], {
        cwd: directory,
        timeoutMs: 10_000,
      });
      return result.exitCode === 0 ? githubRepository(result.stdout) : undefined;
    } catch (error) {
      if (error instanceof ProcessError) return undefined;
      throw error;
    }
  }

  get<T>(route: string): Promise<T> {
    return this.call<T>("GET", route);
  }

  async find<T>(route: string): Promise<T | undefined> {
    try {
      return await this.call<T>("GET", route);
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  send<T>(method: "POST" | "PATCH" | "PUT" | "DELETE", route: string, body?: unknown): Promise<T> {
    return this.call<T>(method, route, body);
  }

  async attempt(method: "PATCH" | "DELETE", route: string, body?: unknown) {
    try {
      await this.call(method, route, body);
      return { ok: true } as const;
    } catch (error) {
      if (!(error instanceof GitHubApiError)) throw error;
      return {
        ok: false,
        message: error.message,
        ...(error.status === undefined ? {} : { status: error.status }),
      } as const;
    }
  }

  private async call<T>(method: string, route: string, body?: unknown): Promise<T> {
    let result: Awaited<ReturnType<typeof run>>;
    try {
      result = await run(
        this.command,
        [
          ...this.prefix,
          "api",
          "--method",
          method,
          "--header",
          "X-GitHub-Api-Version: 2022-11-28",
          route,
          ...(body === undefined ? [] : ["--input", "-"]),
        ],
        {
          cwd: this.cwd,
          timeoutMs: 30_000,
          maxOutputBytes: 16 * 1024 * 1024,
          ...(body === undefined ? {} : { input: JSON.stringify(body) }),
        },
      );
    } catch (error) {
      if (error instanceof ProcessError) {
        throw new GitHubApiError(
          `the GitHub CLI could not run (${error.message}); install it from https://cli.github.com/ and sign in with gh auth login`,
        );
      }
      throw error;
    }
    if (result.timedOut)
      throw new GitHubApiError(`GitHub did not answer ${method} ${route} in time`);
    if (result.exitCode !== 0) {
      const status = Number(/HTTP (\d{3})/.exec(result.stderr)?.[1]) || undefined;
      throw new GitHubApiError(
        `${method} ${route} failed: ${result.stderr.trim().split("\n")[0] ?? "no output"}`,
        status,
      );
    }
    return (result.stdout.trim() === "" ? undefined : JSON.parse(result.stdout)) as T;
  }
}
