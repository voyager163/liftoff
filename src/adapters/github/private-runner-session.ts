import {
  createAuthenticatedGitHubTransport, GitHubActivationClient, GitHubActivationError,
  positiveId, type GitHubActivationTransport, type GitHubResponse
} from './activation-rest.js';
import type { CommandRunner } from '../../process-runner.js';
import { commandSucceeded } from '../../governance-activation/transition-process.js';

function privateReportTransport(credential: Uint8Array, fetcher: typeof globalThis.fetch): GitHubActivationTransport {
  return {
    async request(request): Promise<GitHubResponse> {
      const signal = AbortSignal.timeout(30_000);
      let active: Response | undefined;
      try {
        let response = await fetcher(`https://api.github.com${request.path}`, {
          method: 'GET', redirect: 'manual', signal,
          headers: { Authorization: `Bearer ${Buffer.from(credential).toString('utf8')}`,
            Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' }
        });
        active = response;
        const requestId = response.headers.get('x-github-request-id');
        if (response.status === 302) {
          const location = response.headers.get('location');
          if (!location) throw new Error('missing location');
          const url = new URL(location);
          if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
            url.port && url.port !== '443' ||
            !/^[A-Za-z0-9-]+\.(?:blob\.core\.windows\.net|(?:[A-Za-z0-9-]+\.)*actions\.githubusercontent\.com)$/u.test(url.hostname)) {
            throw new Error('unexpected artifact origin');
          }
          await response.body?.cancel();
          response = await fetcher(url.href, {
            method: 'GET', redirect: 'error', signal, headers: { Accept: 'application/octet-stream' }
          });
          active = response;
        }
        if (response.status !== 200) {
          await response.body?.cancel();
          return { status: response.status, headers: {}, data: null };
        }
        const size = response.headers.get('content-length');
        if (size !== null && (!/^\d+$/u.test(size) || Number(size) > 512 * 1024)) throw new Error('artifact limit');
        const chunks: Uint8Array[] = [];
        let total = 0;
        if (response.body) for await (const bytes of response.body) {
          total += bytes.length;
          if (total > 512 * 1024) throw new Error('artifact limit');
          chunks.push(bytes);
        }
        return { status: 200, headers: requestId ? { 'x-github-request-id': requestId } : {}, data: Buffer.concat(chunks) };
      } catch {
        await active?.body?.cancel().catch(() => undefined);
        throw new GitHubActivationError('private-runner-artifact', 'The exact report archive could not be read within its approved HTTPS/size bounds; credential-bearing locations and diagnostics were withheld.');
      }
    }
  };
}

export async function openPrivateRunnerGitHubSession(
  runner: CommandRunner, projectRoot: string, actorId: number,
  options: { fetch?: typeof globalThis.fetch; binaryTransport?: GitHubActivationTransport } = {}
): Promise<{ client: GitHubActivationClient; close(): void }> {
  positiveId(actorId);
  const result = await runner.run({
    executable: 'gh', args: ['auth', 'token', '--hostname', 'github.com']
  }, {
    cwd: projectRoot, timeoutMs: 15_000, maxOutputBytes: 16 * 1024, stream: false,
    env: { GH_DEBUG: '', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' }
  }).catch(() => { throw new GitHubActivationError('private-runner-credential', 'The exact runner administrator credential could not be read privately; diagnostics were withheld.'); });
  let credential: Buffer;
  try {
    if (!commandSucceeded(result) || result.aborted || result.outputLimitExceeded ||
      !/^(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{40,255})$/u.test(result.stdout.trim())) {
      throw new GitHubActivationError('private-runner-credential', 'A supported private owner-controlled GitHub credential is required for the exact runner administrator.');
    }
    credential = Buffer.from(result.stdout.trim(), 'utf8');
  } finally { result.stdout = ''; result.stderr = ''; }
  const authenticated = createAuthenticatedGitHubTransport(credential, options.fetch);
  const binary = options.binaryTransport ?? privateReportTransport(credential, options.fetch ?? globalThis.fetch);
  let closed = false;
  const client = new GitHubActivationClient({
    async request(request) {
      if (closed) throw new GitHubActivationError('private-runner-session', 'The bound private runner credential session has been closed.');
      if (!request.binary) return authenticated.request(request);
      if (request.method !== 'GET' || request.body !== undefined ||
        !/^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/artifacts\/[1-9][0-9]*\/zip$/u.test(request.path)) {
        throw new GitHubActivationError('private-runner-artifact', 'The private runner session downloads only its exact read-only report artifact.');
      }
      return binary.request(request);
    }
  });
  const close = () => { closed = true; credential.fill(0); };
  try {
    const actor = await client.get('/user');
    if (actor.id !== actorId) throw new GitHubActivationError('private-runner-actor', 'The pinned credential does not belong to the exact approved runner administrator.');
    return { client, close };
  } catch (error) { close(); throw error; }
}
