import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import {
  checkIssueForm, checkPromotion, checkRepositoryPolicy, checkWorkflow,
  communityFiles, workflowFiles
} from '../scripts/check-repository-policy.mjs';

const root = process.cwd();
const fixtures: string[] = [];
const readWorkflow = async (name: string) => parse(await readFile(path.join(root, '.github', 'workflows', name), 'utf8'));

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function pullRequest(base: string, head: string, owner = 'voyager163/liftoff') {
  return { pull_request: {
    base: { ref: base, repo: { full_name: 'voyager163/liftoff' } },
    head: { ref: head, repo: { full_name: owner } }
  } };
}

describe('source repository setup policy', () => {
  it('validates the explicitly named repository setup without inspecting application source', async () => {
    await expect(checkRepositoryPolicy(root)).resolves.toBeUndefined();
  });

  it('accepts public contributions and canonical release promotion', () => {
    expect(() => checkPromotion(pullRequest('develop', 'feature/docs', 'contributor/liftoff'))).not.toThrow();
    expect(() => checkPromotion(pullRequest('develop', 'sync/main'))).not.toThrow();
    expect(() => checkPromotion(pullRequest('main', 'develop'))).not.toThrow();
  });

  it('rejects noncanonical promotion and missing PR identity', () => {
    expect(() => checkPromotion(pullRequest('main', 'feature/docs'))).toThrow('Promote canonical develop');
    expect(() => checkPromotion(pullRequest('main', 'develop', 'contributor/liftoff'))).toThrow('fork named develop');
    expect(() => checkPromotion({})).toThrow('Missing PR');
  });

  it.each([
    ['write token', (workflow: ReturnType<typeof parse>) => { workflow.permissions.contents = 'write'; }],
    ['untrusted trigger', (workflow: ReturnType<typeof parse>) => { workflow.on.pull_request_target = null; }],
    ['mutable action', (workflow: ReturnType<typeof parse>) => { workflow.jobs.policy.steps[0].uses = 'actions/checkout@v7'; }],
    ['unapproved action', (workflow: ReturnType<typeof parse>) => { workflow.jobs.policy.steps[0].uses = `outsider/action@${'a'.repeat(40)}`; }],
    ['persisted credentials', (workflow: ReturnType<typeof parse>) => { workflow.jobs.policy.steps[0].with['persist-credentials'] = true; }],
    ['skipped policy', (workflow: ReturnType<typeof parse>) => { workflow.jobs.policy.if = 'false'; }],
    ['path-filtered PR', (workflow: ReturnType<typeof parse>) => { workflow.on.pull_request = { paths: ['docs/**'] }; }],
    ['secret-bearing step', (workflow: ReturnType<typeof parse>) => { workflow.jobs.policy.steps[0].env = { TOKEN: '${{ secrets.TOKEN }}' }; }],
    ['OIDC on contribution job', (workflow: ReturnType<typeof parse>) => { workflow.jobs.policy.permissions = { 'id-token': 'write' }; }]
  ])('rejects %s in contribution configuration', async (_name, mutate) => {
    const workflow = await readWorkflow('repository.yml');
    mutate(workflow);
    expect(() => checkWorkflow('repository.yml', workflow)).toThrow();
  });

  it.each([
    ['manual publish input', (workflow: ReturnType<typeof parse>) => { workflow.on.workflow_dispatch = { inputs: { publish: { type: 'boolean' } } }; }],
    ['workflow OIDC', (workflow: ReturnType<typeof parse>) => { workflow.permissions['id-token'] = 'write'; }],
    ['missing approval', (workflow: ReturnType<typeof parse>) => { delete workflow.jobs.publish.environment; }],
    ['bypassed qualification', (workflow: ReturnType<typeof parse>) => { delete workflow.jobs.publish.needs; }],
    ['arbitrary-ref publish', (workflow: ReturnType<typeof parse>) => { workflow.jobs.publish.if = '${{ success() }}'; }],
    ['cancellable release', (workflow: ReturnType<typeof parse>) => { workflow.concurrency['cancel-in-progress'] = true; }],
    ['suppressed failure', (workflow: ReturnType<typeof parse>) => { workflow.jobs.qualify.steps[0]['continue-on-error'] = true; }]
  ])('rejects %s in release configuration', async (_name, mutate) => {
    const workflow = await readWorkflow('release.yml');
    mutate(workflow);
    expect(() => checkWorkflow('release.yml', workflow)).toThrow();
  });

  it('rejects duplicate form IDs and labels that were not established', async () => {
    const form = parse(await readFile(path.join(root, '.github', 'ISSUE_TEMPLATE', 'bug_report.yml'), 'utf8'));
    form.body.push(form.body[1]);
    expect(() => checkIssueForm(form, 'bug')).toThrow('unique');
    expect(() => checkIssueForm(form, 'unknown-label')).toThrow('established label');
  });

  it('resolves an explicit setup inventory from a directory containing spaces', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'liftoff repository setup '));
    fixtures.push(directory);
    const files = [
      'package.json', 'README.md', ...communityFiles,
      path.join('.github', 'CODEOWNERS'), path.join('.github', 'PULL_REQUEST_TEMPLATE.md'),
      ...['bug_report.yml', 'feature_request.yml', 'config.yml'].map(file => path.join('.github', 'ISSUE_TEMPLATE', file)),
      ...workflowFiles.map((file: string) => path.join('.github', 'workflows', file)),
      ...['liftoff-hero.svg', 'liftoff-terminal.svg'].map(file => path.join('docs', 'assets', file))
    ];
    for (const file of files) {
      await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
      await writeFile(path.join(directory, file), await readFile(path.join(root, file)));
    }
    await expect(checkRepositoryPolicy(directory)).resolves.toBeUndefined();
    const hero = path.join(directory, 'docs', 'assets', 'liftoff-hero.svg');
    await writeFile(hero, `${await readFile(hero, 'utf8')}${' '.repeat(300 * 1024)}`);
    await expect(checkRepositoryPolicy(directory)).rejects.toThrow('Hero exceeds');
  });
});
