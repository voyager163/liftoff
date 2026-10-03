import type { GitHubActivationTransport, GitHubRequest, GitHubResponse } from '../../../src/adapters/github/activation-rest.js';
import type { CommandResult, CommandRunner, RunCommandOptions } from '../../../src/process-runner.js';
import type { ExternalCommand } from '../../../src/types.js';

export interface FakeRepository {
  id: number;
  full_name: string;
  private: boolean;
  archived: boolean;
  disabled?: boolean;
  fork: boolean;
  default_branch: string;
  refs: Record<string, string>;
  owner?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  security_and_analysis?: Record<string, unknown>;
}

const response = (status: number, data: unknown = null): GitHubResponse => ({ status, headers: {}, data });

/** In-memory GitHub REST provider. Every request is recorded; nothing leaves the process. */
export class FakeGitHub implements GitHubActivationTransport {
  readonly requests: GitHubRequest[] = [];
  readonly repositories = new Map<string, FakeRepository>();
  readonly ownerTypes = new Map<string, string>();
  readonly memberships = new Map<string, string>();
  readonly overrides = new Map<string, GitHubResponse | Error | ((request: GitHubRequest) => GitHubResponse)>();
  actor = 'owner';
  nextId = 4200;

  repository(fullName: string, overrides: Partial<FakeRepository> = {}): FakeRepository {
    const repository: FakeRepository = {
      id: this.nextId++, full_name: fullName, private: true, archived: false, fork: false, default_branch: 'develop', refs: {}, ...overrides
    };
    this.repositories.set(fullName.toLowerCase(), repository);
    return repository;
  }

  writes(): string[] {
    return this.requests.filter((request) => request.method !== 'GET').map((request) => `${request.method} ${request.path}`);
  }

  async request(request: GitHubRequest): Promise<GitHubResponse> {
    this.requests.push(request);
    const key = `${request.method} ${request.path}`;
    const override = this.overrides.get(key);
    if (override instanceof Error) throw override;
    if (typeof override === 'function') return override(request);
    if (override) return override;
    const repoMatch = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/u.exec(request.path);
    if (repoMatch) {
      const repository = this.repositories.get(repoMatch[1]!.toLowerCase());
      const rest = repoMatch[2] ?? '';
      if (!repository) return response(404, { message: 'Not Found' });
      if (rest === '' && request.method === 'GET') return response(200, { ...repository });
      if (rest === '' && request.method === 'PATCH') {
        Object.assign(repository, request.body as object);
        return response(200, { ...repository });
      }
      const ref = /^\/git\/ref\/heads\/(.+)$/u.exec(rest);
      if (ref && request.method === 'GET') {
        const sha = repository.refs[ref[1]!];
        return sha ? response(200, { ref: `refs/heads/${ref[1]}`, object: { sha, type: 'commit' } }) : response(404, { message: 'Not Found' });
      }
      return response(404, { message: 'Not Found' });
    }
    const user = /^\/users\/([^/]+)$/u.exec(request.path);
    if (user && request.method === 'GET') {
      const type = this.ownerTypes.get(user[1]!);
      return type ? response(200, { login: user[1], type }) : response(404, { message: 'Not Found' });
    }
    if (request.path === '/user' && request.method === 'GET') return response(200, { login: this.actor, id: 1, type: 'User' });
    const membership = /^\/user\/memberships\/orgs\/([^/]+)$/u.exec(request.path);
    if (membership && request.method === 'GET') {
      const state = this.memberships.get(membership[1]!);
      return state ? response(200, { state, role: 'admin' }) : response(404, { message: 'Not Found' });
    }
    const create = /^\/(?:orgs\/([^/]+)|user)\/repos$/u.exec(request.path);
    if (create && request.method === 'POST') {
      const body = request.body as { name: string; private: boolean };
      const owner = create[1] ?? this.actor;
      const created = this.repository(`${owner}/${body.name}`, { private: body.private, default_branch: 'main' });
      return response(201, { ...created });
    }
    return response(404, { message: 'Not Found' });
  }
}

export interface FakeRemote {
  name: string;
  url: string;
  pushUrls: string[];
}

/** Deterministic local Git emulation; pushes update the fake provider only when allowed. */
export class FakeGitRunner implements CommandRunner {
  readonly calls: string[][] = [];
  branch: string | null = 'develop';
  head: string | null = 'a'.repeat(40);
  status: string[] = [];
  remotes: FakeRemote[] = [];
  ancestor = true;
  pushStatus = 0;
  remoteAddStatus = 0;
  topLevel?: string;

  constructor(protected readonly root: string, protected readonly github?: FakeGitHub) {}

  protected result(command: ExternalCommand, status: number, stdout = ''): CommandResult {
    return { command, displayCommand: [command.executable, ...command.args].join(' '), status, signal: null, stdout, stderr: '', timedOut: false };
  }

  async run(command: ExternalCommand, _options?: RunCommandOptions): Promise<CommandResult> {
    this.calls.push([command.executable, ...command.args]);
    if (command.executable !== 'git') throw new Error(`Unexpected ${command.executable} invocation in a Git-only fake.`);
    const args = command.args.join(' ');
    if (args === 'rev-parse --show-toplevel') return this.result(command, 0, `${this.topLevel ?? this.root}\n`);
    if (args === 'symbolic-ref --quiet --short HEAD') return this.branch ? this.result(command, 0, `${this.branch}\n`) : this.result(command, 1);
    if (args === 'rev-parse --verify HEAD') return this.head ? this.result(command, 0, `${this.head}\n`) : this.result(command, 128);
    if (args === 'rev-parse --abbrev-ref --symbolic-full-name @{u}') return this.result(command, 128);
    if (args === 'status --porcelain=v1 -z --untracked-files=all') return this.result(command, 0, this.status.map((entry) => `${entry}\0`).join(''));
    if (args === 'remote -v') {
      return this.result(command, 0, this.remotes.flatMap((remote) => [
        `${remote.name}\t${remote.url} (fetch)`, ...remote.pushUrls.map((url) => `${remote.name}\t${url} (push)`)
      ]).join('\n'));
    }
    const pushUrls = /^remote get-url --push --all (\S+)$/u.exec(args);
    if (pushUrls) {
      const remote = this.remotes.find((entry) => entry.name === pushUrls[1]);
      return remote ? this.result(command, 0, `${remote.pushUrls.join('\n')}\n`) : this.result(command, 2);
    }
    if (command.args[0] === 'merge-base') return this.result(command, this.ancestor ? 0 : 1);
    if (command.args[0] === 'remote' && command.args[1] === 'add') {
      if (this.remoteAddStatus !== 0) return this.result(command, this.remoteAddStatus);
      this.remotes.push({ name: command.args[2]!, url: command.args[3]!, pushUrls: [command.args[3]!] });
      return this.result(command, 0);
    }
    if (command.args[0] === 'push') {
      if (this.pushStatus !== 0) return this.result(command, this.pushStatus);
      const [sha, ref] = command.args[2]!.split(':');
      const target = /github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/u.exec(command.args[1]!)?.[1];
      const repository = target ? this.github?.repositories.get(target.toLowerCase()) : undefined;
      if (repository) repository.refs[ref!.replace('refs/heads/', '')] = sha!;
      return this.result(command, 0);
    }
    return this.result(command, 1);
  }
}

/**
 * Routes `gh api` through the same in-memory provider so reviewed planning (CLI transport) and execution observe
 * one deterministic GitHub state; `gh repo view` results are scripted for Phase 0 discovery.
 */
export class FakeProviderRunner extends FakeGitRunner {
  repoView?: Partial<CommandResult>;

  constructor(root: string, readonly provider: FakeGitHub) {
    super(root, provider);
  }

  override async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
    if (command.executable === 'gh' && command.args[0] === 'api') {
      this.calls.push([command.executable, ...command.args]);
      const method = command.args[command.args.indexOf('--method') + 1] as GitHubRequest['method'];
      const endpoint = command.args[command.args.indexOf('--include') + 1]!;
      const body = options?.stdin === undefined ? undefined : JSON.parse(Buffer.from(options.stdin).toString('utf8')) as unknown;
      const reply = await this.provider.request({ method, path: endpoint, ...(body === undefined ? {} : { body }) });
      return { ...this.result(command, reply.status < 400 ? 0 : 1),
        stdout: `HTTP/2.0 ${reply.status} Fake\r\n\r\n${reply.data === null ? '' : JSON.stringify(reply.data)}` };
    }
    if (command.executable === 'gh' && command.args[0] === 'repo' && this.repoView) {
      this.calls.push([command.executable, ...command.args]);
      return { ...this.result(command, 0), ...this.repoView };
    }
    return super.run(command, options);
  }
}
