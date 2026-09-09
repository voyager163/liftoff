import { lstat, realpath } from 'node:fs/promises';
import { devNull } from 'node:os';
import path from 'node:path';
import { NodeCommandRunner, type CommandRunner } from '../../process-runner.js';
import { containsSensitiveText, sanitizeAssessmentText } from '../../domain/governance/assessment/sanitize.js';
import type { LiveAssessmentScope } from '../../governance-assessment/types.js';

export type AssessmentBoundaryKind = 'liftoff' | 'git';

export interface AssessmentBoundary {
  kind: AssessmentBoundaryKind;
  root: string;
}

export interface AssessmentGitFacts {
  isRepository: boolean;
  repository: { owner: string; name: string; id: string | null } | null;
  pushUrls: string[];
  head: string | null;
  issues: string[];
  originState: 'none' | 'verified' | 'unavailable';
}

function code(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

async function markerExists(directory: string, name: string): Promise<boolean> {
  try {
    await lstat(path.join(directory, name));
    return true;
  } catch (error) {
    if (code(error) === 'ENOENT') return false;
    throw new Error(`Unable to inspect assessment boundary ${name}.`);
  }
}

export async function resolveAssessmentBoundary(start: string): Promise<AssessmentBoundary> {
  let current: string;
  try {
    const entry = await lstat(start);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('Assessment target must be a regular directory.');
    }
    current = await realpath(start);
  } catch (error) {
    throw new Error(
      error instanceof Error && error.message === 'Assessment target must be a regular directory.'
        ? error.message
        : 'Assessment target could not be resolved as a directory.'
    );
  }
  while (true) {
    if (await markerExists(current, 'liftoff.manifest.json')) {
      return { kind: 'liftoff', root: current };
    }
    if (await markerExists(current, '.git')) {
      return { kind: 'git', root: current };
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error('No Liftoff manifest or Git worktree boundary was found.');
    }
    current = parent;
  }
}

export function repositoryName(
  value: string,
  id: string | null = null
): LiveAssessmentScope['repository'] {
  const match = value.match(/^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]+)$/u);
  if (!match || match[2] === '.' || match[2] === '..' || containsSensitiveText(value)) return null;
  return { owner: match[1]!, name: match[2]!, id };
}

export async function inspectAssessmentGit(
  root: string,
  runner: CommandRunner = new NodeCommandRunner()
): Promise<AssessmentGitFacts> {
  let marker;
  try {
    marker = await lstat(path.join(root, '.git'));
  } catch (error) {
    if (code(error) === 'ENOENT') {
      return {
        isRepository: false,
        repository: null,
        pushUrls: [],
        head: null,
        issues: [],
        originState: 'none'
      };
    }
    throw new Error('Git boundary metadata could not be inspected.');
  }
  if (marker.isSymbolicLink() || (!marker.isDirectory() && !marker.isFile())) {
    throw new Error('Git boundary metadata must be a regular directory or linked-worktree file.');
  }
  const issues: string[] = [];
  const prefix = [
    '--no-pager',
    '--no-optional-locks',
    '-c', 'core.fsmonitor=false',
    '-c', `core.hooksPath=${devNull}`,
    '-c', 'diff.external=',
    '-c', 'core.pager=cat'
  ];
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    LANG: 'C',
    LANGUAGE: 'C',
    LC_ALL: 'C'
  };
  async function git(args: string[]): Promise<string | null> {
    const result = await runner.run(
      { executable: 'git', args: [...prefix, ...args] },
      { cwd: root, env: environment, timeoutMs: 10_000 }
    );
    if (result.status === 0 && !result.timedOut && !result.errorCode) {
      return result.stdout.trim();
    }
    issues.push(sanitizeAssessmentText(
      `Local Git ${args[0]} metadata was not observed (${result.timedOut
        ? 'timeout'
        : result.errorCode ?? `exit ${result.status}`}).`
    ));
    return null;
  }
  const toplevel = await git(['rev-parse', '--show-toplevel']);
  let exactRoot = false;
  if (toplevel) {
    try {
      exactRoot = await realpath(toplevel) === await realpath(root);
    } catch {
      exactRoot = false;
    }
  }
  if (!exactRoot) {
    return {
      isRepository: false,
      repository: null,
      pushUrls: [],
      head: null,
      issues: [...issues, 'Git root does not match the assessed boundary.'],
      originState: 'unavailable'
    };
  }
  const headText = await git(['rev-parse', '--verify', 'HEAD']);
  const remote = await git(['config', '--local', '--get', 'remote.origin.url']);
  const pushText = remote
    ? await git(['remote', 'get-url', '--push', '--all', 'origin'])
    : null;
  const pushUrls = pushText?.split(/\r?\n/).filter(Boolean) ?? [];
  let repository: AssessmentGitFacts['repository'] = null;
  if (remote) {
    const ssh = remote.match(/^git@github\.com:([^/\s]+\/[^/\s]+?)(?:\.git)?$/u);
    const https = remote.match(/^https:\/\/github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/u);
    const fetchRepository = repositoryName(ssh?.[1] ?? https?.[1] ?? '');
    const pushRepositories = pushUrls.map((value) => {
      const pushSsh = value.match(/^git@github\.com:([^/\s]+\/[^/\s]+?)(?:\.git)?$/u);
      const pushHttps = value.match(/^https:\/\/github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/u);
      return repositoryName(pushSsh?.[1] ?? pushHttps?.[1] ?? '');
    });
    if (
      fetchRepository &&
      pushRepositories.length === 1 &&
      pushRepositories[0] &&
      `${fetchRepository.owner}/${fetchRepository.name}`.toLowerCase() ===
        `${pushRepositories[0].owner}/${pushRepositories[0].name}`.toLowerCase()
    ) {
      repository = fetchRepository;
    } else {
      issues.push('Git origin does not have one matching credential-free GitHub fetch and push binding.');
    }
  }
  return {
    isRepository: true,
    repository,
    pushUrls,
    head: headText && /^[a-f0-9]{40,64}$/u.test(headText) ? headText : null,
    issues,
    originState: repository ? 'verified' : remote ? 'unavailable' : 'none'
  };
}
