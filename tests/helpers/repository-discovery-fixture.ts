import {
  GitHubActivationClient, type GitHubActivationTransport, type GitHubRequest, type GitHubResponse
} from '../../src/adapters/github/activation-rest.js';
import { githubSourceFixture } from './github-source-fixture.js';

export function repositoryDiscoveryFixture() {
  const base = '/repos/owner/repo';
  const source = 'name: Source validation\non: pull_request\njobs:\n  verify:\n    name: verify-source\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n';
  const workflowPath = '.github/workflows/verify.source.yml';
  const branches = [
    { name: 'develop', commit: { sha: 'a'.repeat(40) }, protected: true },
    { name: 'main', commit: { sha: 'b'.repeat(40) }, protected: true },
    { name: 'release/1.0', commit: { sha: 'c'.repeat(40) }, protected: false },
    { name: 'hotfix/security', commit: { sha: 'd'.repeat(40) }, protected: false }
  ];
  const rulesets = [
    {
      id: 11, name: 'liftoff-gitflow-develop', target: 'branch', enforcement: 'active',
      source_type: 'Repository', source: 'owner/repo',
      conditions: { ref_name: { include: ['refs/heads/develop'], exclude: [] } },
      bypass_actors: [],
      rules: [{
        type: 'pull_request',
        parameters: {
          dismiss_stale_reviews_on_push: true, require_code_owner_review: false,
          require_last_push_approval: false, required_approving_review_count: 0,
          dismissal_restriction: { enabled: false }, require_extra_approval_for_unattributed_changes: true,
          required_reviewers: []
        }
      }]
    },
    {
      id: 12, name: 'liftoff-gitflow-main', target: 'branch', enforcement: 'active',
      source_type: 'Organization', source: 'owner',
      conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
      bypass_actors: [], rules: [{ type: 'deletion' }]
    }
  ];
  const responses = new Map<string, GitHubResponse>();
  const set = (endpoint: string, data: unknown, status = 200) => {
    responses.set(endpoint, { status, headers: {}, data });
  };
  set(base, {
    id: 42, name: 'repo', full_name: 'owner/repo', default_branch: 'develop', private: true,
    owner: { id: 3, login: 'owner', type: 'Organization' },
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    security_and_analysis: { secret_scanning: { status: 'enabled' } }
  });
  set(`${base}/branches`, branches);
  set(`${base}/actions/workflows`, {
    total_count: 1, workflows: [{ id: 4, name: 'Source validation', path: workflowPath, state: 'active' }]
  });
  set(`${base}/contents/${workflowPath}`, githubSourceFixture(workflowPath, source));
  set(`${base}/rulesets`, rulesets);
  for (const ruleset of rulesets) set(`${base}/rulesets/${ruleset.id}`, ruleset);
  for (const branch of branches) {
    set(`${base}/branches/${encodeURIComponent(branch.name)}/protection`, { message: 'Branch not protected' }, 404);
    set(`${base}/commits/${branch.commit.sha}/check-runs`, {
      total_count: 1, check_runs: [{
        id: 71 + branches.indexOf(branch), name: 'verify-source', status: 'completed', conclusion: 'success',
        head_sha: branch.commit.sha, app: { id: 15368, slug: 'github-actions' }
      }]
    });
  }
  set(`${base}/actions/permissions`, { enabled: true, allowed_actions: 'all' });
  set(`${base}/actions/permissions/workflow`, {
    default_workflow_permissions: 'read', can_approve_pull_request_reviews: false
  });
  const requests: GitHubRequest[] = [];
  let beforeRequest: ((request: GitHubRequest) => void) | undefined;
  const transport: GitHubActivationTransport = {
    async request(request) {
      requests.push(structuredClone(request));
      beforeRequest?.(request);
      return structuredClone(responses.get(request.path.split('?')[0]!) ?? {
        status: 404, headers: {}, data: { message: 'Unregistered fixture endpoint' }
      });
    }
  };
  return {
    base, source, workflowPath, branches, rulesets, responses, set, requests, transport,
    client: new GitHubActivationClient(transport),
    beforeRequest: (hook: (request: GitHubRequest) => void) => { beforeRequest = hook; }
  };
}
