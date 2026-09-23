#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

export const communityFiles = [
  'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md', 'GOVERNANCE.md', 'SUPPORT.md'
];
export const workflowFiles = [
  'ci.yml', 'repository.yml', 'release.yml', 'template-dependency-audit.yml', 'supported-stack-freshness.yml'
];
export const allowedActions = [
  'actions/checkout', 'actions/setup-node', 'actions/setup-python', 'actions/setup-go',
  'opentofu/setup-opentofu', 'actions/upload-artifact', 'actions/download-artifact'
];
export const publicationCondition = "${{ github.event_name == 'push' && github.repository == 'voyager163/liftoff' && github.ref_type == 'tag' && startsWith(github.ref, 'refs/tags/v') }}";

export function checkPromotion(event) {
  const pr = event.pull_request;
  assert.ok(pr?.base?.ref && pr?.head?.ref && pr?.head?.repo?.full_name, 'Missing PR source/target identity.');
  assert.equal(pr.base.repo?.full_name, 'voyager163/liftoff', 'PR target repository must be canonical.');
  if (pr.base.ref === 'main') {
    assert.equal(pr.head.ref, 'develop', 'Promote canonical develop into main; normal changes target develop.');
    assert.equal(pr.head.repo.full_name, 'voyager163/liftoff', 'A fork named develop is not a release source.');
  }
}

export function checkWorkflow(filename, workflow) {
  const release = filename === 'release.yml';
  assert.deepEqual(workflow.permissions, { contents: 'read' }, `${filename}: workflow default must be contents: read.`);
  assert.ok(workflow.jobs && typeof workflow.jobs === 'object', `${filename}: jobs are required.`);
  const triggers = Object.keys(workflow.on ?? {});
  const allowedTriggers = release ? ['workflow_dispatch', 'push'] : ['pull_request', 'push', 'workflow_dispatch', 'schedule'];
  assert.ok(triggers.length && triggers.every(trigger => allowedTriggers.includes(trigger)), `${filename}: unapproved trigger.`);
  for (const [id, job] of Object.entries(workflow.jobs)) {
    assert.ok(['ubuntu-latest', 'macos-latest', 'windows-latest', '${{ matrix.os }}'].includes(job['runs-on']), `${filename}/${id}: use reviewed hosted runners.`);
    assert.ok(Number.isInteger(job['timeout-minutes']) && job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 60, `${filename}/${id}: bounded timeout required.`);
    assert.ok(!job['continue-on-error'], `${filename}/${id}: do not suppress a failed check.`);
    if (release && id === 'publish') {
      assert.deepEqual(job.permissions, { contents: 'read', 'id-token': 'write' }, 'Only publish gets OIDC.');
      assert.equal(job.environment, 'npm-release', 'Publishing requires the release environment.');
      assert.equal(job.needs, 'qualify', 'Publishing must depend on qualification.');
      assert.equal(job.if, publicationCondition, 'Publishing must be limited to canonical tag pushes.');
    } else if (job.permissions !== undefined) {
      assert.deepEqual(job.permissions, { contents: 'read' }, `${filename}/${id}: contribution/qualification jobs cannot escalate permissions.`);
    }
    assert.ok(Array.isArray(job.steps), `${filename}/${id}: reusable jobs need separate policy review.`);
    for (const step of job.steps) {
      assert.ok(!step['continue-on-error'], `${filename}/${id}: do not suppress a failed step.`);
      assert.ok(!JSON.stringify(step).includes('secrets.'), `${filename}/${id}: named workflows must not reference secrets.`);
      if (step.uses) {
        const match = /^([^@]+)@([a-f0-9]{40})$/.exec(step.uses);
        assert.ok(match && allowedActions.includes(match[1]), `${filename}/${id}: action must be allowed and full-SHA pinned: ${step.uses}`);
        if (match[1] === 'actions/checkout') {
          assert.equal(step.with?.['persist-credentials'], false, `${filename}/${id}: checkout must not persist credentials.`);
        }
      }
    }
  }
  if (['ci.yml', 'repository.yml'].includes(filename)) {
    assert.deepEqual(workflow.on.pull_request, null, `${filename}: every PR must produce its required checks.`);
    assert.deepEqual(workflow.on.push?.branches, ['develop', 'main'], `${filename}: qualify both long-lived branches.`);
    assert.deepEqual(Object.keys(workflow.on.push), ['branches'], `${filename}: required push checks cannot be path-filtered.`);
    assert.equal(workflow.concurrency?.['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}", `${filename}: cancel superseded PRs only.`);
  }
  if (filename === 'repository.yml') {
    assert.equal(workflow.jobs.policy?.name, 'Repository policy');
    assert.equal(workflow.jobs.policy?.if, undefined, 'Repository policy must not be skipped.');
    assert.ok(workflow.jobs.policy.steps.some(step => step.run === 'npm run check:repository'), 'Repository policy must run its checker.');
  }
  if (release) {
    assert.deepEqual(triggers.sort(), ['push', 'workflow_dispatch']);
    assert.deepEqual(workflow.on.workflow_dispatch, null, 'Manual dispatch must have no publish-capable inputs.');
    assert.deepEqual(workflow.on.push, { tags: ['v*'] }, 'Publishing is tag-triggered only.');
    assert.deepEqual(Object.keys(workflow.jobs).sort(), ['publish', 'qualify'], 'Release job inventory must remain explicit.');
    assert.equal(workflow.jobs.qualify.if, undefined, 'Qualification must not be skipped.');
    assert.equal(workflow.jobs.qualify.environment, undefined, 'Qualification needs no release approval.');
    assert.equal(workflow.concurrency?.['cancel-in-progress'], false, 'Never cancel a running release.');
  }
}

export function checkIssueForm(form, expectedLabel) {
  assert.ok(form.name && form.description, 'Issue form needs a name and description.');
  assert.deepEqual(form.labels, [expectedLabel], 'Issue form must use the established label.');
  assert.ok(Array.isArray(form.body) && form.body.length, 'Issue form needs a body.');
  const ids = new Set();
  for (const field of form.body) {
    assert.ok(['markdown', 'input', 'textarea', 'dropdown', 'checkboxes'].includes(field.type), 'Unsupported issue field type.');
    if (field.type === 'markdown') {
      assert.ok(field.attributes?.value, 'Markdown issue field needs text.');
      continue;
    }
    assert.ok(field.id && !ids.has(field.id), 'Issue field IDs must be present and unique.');
    ids.add(field.id);
    assert.ok(field.attributes?.label, 'Issue field needs a label.');
    if (['dropdown', 'checkboxes'].includes(field.type)) {
      assert.ok(field.attributes.options?.length, 'Choice field needs options.');
    }
  }
  assert.ok(form.body.some(field => field.validations?.required), 'Issue form needs required context.');
}

export async function checkRepositoryPolicy(root = process.cwd()) {
  const text = (...parts) => readFile(path.join(root, ...parts), 'utf8');
  const pkg = JSON.parse(await text('package.json'));
  assert.equal(pkg.license, 'GPL-3.0-only', 'Preserve the project license.');
  for (const file of communityFiles) {
    assert.ok((await text(file)).trim(), `Missing community guidance: ${file}`);
    assert.ok(pkg.files.includes(file), `Package the README-linked community document: ${file}`);
  }
  const conduct = await text('CODE_OF_CONDUCT.md');
  assert.ok(conduct.includes('mailto:ask.msncontrol@gmail.com'), 'Use the owner-approved conduct contact.');
  const security = await text('SECURITY.md');
  assert.ok(security.includes('https://github.com/voyager163/liftoff/security/advisories/new'), 'Retain the private security route.');
  const owners = (await text('.github', 'CODEOWNERS')).split(/\r?\n/).filter(line => line.trim() && !line.startsWith('#'));
  for (const line of owners) {
    const [pattern, ...people] = line.trim().split(/\s+/);
    assert.ok(pattern);
    assert.deepEqual(people, ['@voyager163'], 'Ownership changes need a reviewed maintainer update.');
  }
  for (const pattern of ['*', '/.github/CODEOWNERS', '/.github/workflows/', '/GOVERNANCE.md', '/SECURITY.md', '/LICENSE']) {
    assert.ok(owners.includes(`${pattern} @voyager163`), `Missing ownership entry: ${pattern}`);
  }
  checkIssueForm(parse(await text('.github', 'ISSUE_TEMPLATE', 'bug_report.yml')), 'bug');
  checkIssueForm(parse(await text('.github', 'ISSUE_TEMPLATE', 'feature_request.yml')), 'enhancement');
  const issues = parse(await text('.github', 'ISSUE_TEMPLATE', 'config.yml'));
  assert.equal(issues.blank_issues_enabled, true, 'Keep general public issues available.');
  assert.ok(issues.contact_links.some(link => link.url === 'https://github.com/voyager163/liftoff/security/advisories/new'));
  assert.ok(issues.contact_links.some(link => link.url.endsWith('/CODE_OF_CONDUCT.md')));
  assert.ok((await text('.github', 'PULL_REQUEST_TEMPLATE.md')).includes('develop'));
  for (const file of workflowFiles) {
    checkWorkflow(file, parse(await text('.github', 'workflows', file)));
  }
  const images = ['liftoff-hero.svg', 'liftoff-terminal.svg'];
  let total = 0;
  for (const file of images) {
    const image = await text('docs', 'assets', file);
    assert.ok(image.includes('<title') && image.includes('<desc'), `${file}: accessible image description required.`);
    assert.ok(!/<script\b|<foreignObject\b|@import|@font-face|\b(?:href|src)=["'](?:https?:|\/\/)|url\(["']?(?:https?:|\/\/)/i.test(image), `${file}: artwork must be static and self-contained.`);
    const size = (await stat(path.join(root, 'docs', 'assets', file))).size;
    if (file === 'liftoff-hero.svg') assert.ok(size <= 300 * 1024, 'Hero exceeds 300 KiB.');
    total += size;
  }
  assert.ok(total <= 500 * 1024, 'README images exceed 500 KiB.');
  const readme = await text('README.md');
  assert.ok(readme.split(/\r?\n/).length < 135, 'README must remain below 135 lines.');
  for (const file of communityFiles) assert.ok(readme.includes(`](${file}`), `README must link to ${file}.`);
}

async function main() {
  await checkRepositoryPolicy();
  if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
    assert.ok(process.env.GITHUB_EVENT_PATH, 'The PR event file is required.');
    checkPromotion(JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')));
  }
  console.log('Repository setup policy passed for the named files; hosted settings require separate readback.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`Repository policy failed: ${error.message}`);
    process.exitCode = 1;
  });
}
