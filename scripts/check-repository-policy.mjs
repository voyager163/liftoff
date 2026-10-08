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
export const coverageGateJobs = {
  'coverage-cli': 'npm run coverage:cli',
  'coverage-gateway': 'npm run coverage:gateway'
};
export const gatewayInstallCommand = 'npm ci --prefix services/telemetry-ingest';
export const independentStepCondition = '${{ !cancelled() }}';
export const platformShardCheckCommand = 'npm run check:supported-stack && npm run build && ' +
  'npx vitest run --shard=${{ matrix.shard }}/2 --allowOnly=false ' +
  '--maxWorkers=2 ' +
  '--reporter=default --reporter=json --outputFile.json=qualification/platform-tests.json';
export const pluginPathTestCommand = 'npx vitest run tests/plugin-native-paths.test.ts tests/plugin-packaged-lookup-native.test.ts ' +
  'tests/plugin-generation-parity.test.ts tests/plugin-composition.test.ts ' +
  '--maxWorkers=1 --no-file-parallelism --coverage.enabled=false --allowOnly=false ' +
  '--reporter=dot --reporter=json --outputFile.json=qualification/plugin-paths.json';
export function checkPluginPathReport(report, platform = process.platform) {
  assert.ok(['win32', 'darwin', 'linux'].includes(platform), 'Unsupported native plugin qualification host.');
  assert.equal(report.success, true, 'Native plugin qualification must succeed.');
  assert.equal(report.numFailedTests, 0, 'Native plugin qualification must not fail cases.');
  assert.ok(Array.isArray(report.testResults) && report.testResults.length === 4, 'All four native plugin suites are required.');
  const expected = new Map([
    ['plugin-native-paths.test.ts', 8], ['plugin-packaged-lookup-native.test.ts', 6],
    ['plugin-generation-parity.test.ts', 166], ['plugin-composition.test.ts', 25]
  ]);
  let passed = 0, skipped = 0;
  for (const suite of report.testResults) {
    const name = String(suite.name).replaceAll('\\', '/').split('/').at(-1), minimum = expected.get(name);
    assert.ok(minimum, 'Unexpected or duplicate native plugin suite.');
    expected.delete(name);
    assert.ok(Array.isArray(suite.assertionResults) && suite.assertionResults.length >= minimum, 'Missing native plugin cases.');
    const titles = new Set();
    for (const test of suite.assertionResults) {
      assert.equal(typeof test.fullName, 'string');
      assert.ok(test.fullName.length > 0 && !titles.has(test.fullName), 'Missing or duplicate native plugin case identity.');
      titles.add(test.fullName);
      if (test.status === 'passed') { passed++; continue; }
      assert.ok(platform !== 'win32' && name === 'plugin-packaged-lookup-native.test.ts' && test.status === 'skipped' &&
        test.title === `reads a case-variant spelling of the package root (native Windows only; unrun on ${platform})`,
      'Every applicable native plugin case must pass; unavailable links are not qualification.');
      skipped++;
    }
  }
  assert.equal(expected.size, 0);
  assert.equal(skipped, platform === 'win32' ? 0 : 1, 'Only the named Windows-only case is inapplicable elsewhere.');
  assert.equal(report.numPendingTests, skipped);
  assert.equal(report.numPassedTests, passed);
  assert.equal(report.numTotalTests, passed + skipped);
}
export const isolatedHclTestFiles = [
  'tests/modern-local-inputs.test.ts', 'tests/modern-local-check-plans.test.ts', 'tests/isolated-hcl-parser.test.ts'
];
export const isolatedHclTestCommand = 'npx vitest run ' + isolatedHclTestFiles.join(' ') +
  ' --maxWorkers=1 --no-file-parallelism --reporter=default --reporter=json --outputFile.json=qualification/isolated-hcl.json';
export function isolatedHclQualificationJob(filename) {
  return {
    name: 'Isolated HCL parser (macOS ARM64)', 'runs-on': 'macos-15', 'timeout-minutes': 15,
    permissions: { contents: 'read' }, env: { LIFTOFF_HCL_TEST_LANE: 'native' },
    steps: [
      { uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', with: { 'persist-credentials': false } },
      { uses: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
        with: { 'node-version': '24.21.0', architecture: 'arm64', cache: 'npm' } },
      { name: 'Select supported npm', run: 'npm install --global "npm@12.0.2"' },
      { name: 'Install dependencies', run: 'npm ci' },
      { name: 'Require qualified parser runtime', run: 'node scripts/check-repository-policy.mjs --hcl-runtime' },
      { name: 'Run required native parser qualification', run: isolatedHclTestCommand },
      { name: 'Verify nonempty complete parser qualification', run: 'node scripts/check-repository-policy.mjs --hcl-report qualification/isolated-hcl.json' },
      { name: 'Store parser qualification evidence', if: independentStepCondition,
        uses: 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
        with: { name: `liftoff-isolated-hcl-${filename === 'ci.yml' ? 'ci' : 'release'}-${'${{ github.run_id }}'}-${'${{ github.run_attempt }}'}`,
          path: 'qualification/isolated-hcl.json', 'if-no-files-found': 'error', 'retention-days': 14 } }
    ]
  };
}
export function nativeBundleQualificationJob() {
  return {
    name: 'Runtime-inclusive bundle (macOS ARM64)', 'runs-on': 'macos-15', 'timeout-minutes': 20,
    permissions: { contents: 'read' },
    steps: [
      { uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', with: { 'persist-credentials': false } },
      { uses: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
        with: { 'node-version': '24.21.0', architecture: 'arm64', cache: 'npm' } },
      { uses: 'actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e',
        with: { 'go-version': '1.27.0', 'cache-dependency-path': 'assets/supported-stack.json' } },
      { name: 'Select supported npm', run: 'npm install --global "npm@12.0.2"' },
      { name: 'Install dependencies', run: 'npm ci' },
      { name: 'Retrieve the pinned standalone runtime', shell: 'bash', run: [
        'url="$(node --input-type=module -e \'import inputs from "./distribution/native/inputs.json" with { type: "json" }; console.log(inputs.runtime.url)\')"',
        'curl --fail --location --proto \'=https\' --proto-redir \'=https\' --max-time 180 \\',
        '  "$url" --output "$RUNNER_TEMP/liftoff-node-runtime.tgz"', ''
      ].join('\n') },
      { name: 'Assemble the development bundle', run: 'npm run build:native -- build ' +
        '--runtime-archive "$RUNNER_TEMP/liftoff-node-runtime.tgz" --output "$RUNNER_TEMP/liftoff-native-bundle"' },
      { name: 'Qualify actual installed behavior', shell: 'bash', run: [
        'LIFTOFF_NATIVE_BUNDLE_ROOT="$RUNNER_TEMP/liftoff-native-bundle" \\',
        'LIFTOFF_NATIVE_GO_EXECUTABLE="$(command -v go)" \\',
        'npx vitest run tests/native-bundle.test.ts tests/native-bundle-installed.test.ts \\',
        '  --maxWorkers=1 --no-file-parallelism --coverage.enabled=false --allowOnly=false \\',
        '  --reporter=default --reporter=json --outputFile.json=qualification/native-bundle.json',
        'node scripts/native-bundle.mjs verify-report qualification/native-bundle.json', ''
      ].join('\n') },
      { name: 'Store development qualification evidence', if: independentStepCondition,
        uses: 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
        with: { name: 'liftoff-native-bundle-ci-${{ github.run_id }}-${{ github.run_attempt }}',
          path: 'qualification/native-bundle.json\n${{ runner.temp }}/liftoff-native-bundle/bundle.json\n',
          'if-no-files-found': 'error', 'retention-days': 14 } }
    ]
  };
}
export function checkIsolatedHclRuntime(runtime = {
  platform: process.platform, arch: process.arch, versions: { node: process.versions.node }
}, lane = process.env.LIFTOFF_HCL_TEST_LANE) {
  assert.equal(lane, 'native', 'Parser qualification requires the test-only native lane.');
  assert.equal(runtime.platform, 'darwin', 'Parser qualification requires actual macOS.');
  assert.equal(runtime.arch, 'arm64', 'Parser qualification requires actual ARM64.');
  assert.equal(runtime.versions.node, '24.21.0', 'Parser qualification requires exact Node24.21.0.');
}
export function checkIsolatedHclReport(report) {
  assert.equal(report.success, true, 'Parser qualification must succeed.');
  assert.equal(report.numFailedTests, 0, 'Parser qualification must not fail cases.');
  assert.equal(report.numPendingTests, 0, 'Native parser qualification must not skip cases.');
  assert.ok(Array.isArray(report.testResults) && report.testResults.length === 3, 'All three parser qualification suites are required.');
  const expected = new Map([
    ['modern-local-inputs.test.ts', { minimum: 162, required: [
      'reparses real local HCL module and file references within selected scopes',
      'plans supported jsonencode over a literal populated object',
      'contains original500000-visit construction plus 0 and recovers',
      'contains original500000-visit construction plus 1 and recovers'
    ] }],
    ['modern-local-check-plans.test.ts', { minimum: 33, required: [] }],
    ['isolated-hcl-parser.test.ts', { minimum: 50, required: [
      'parses actual cold/repeated configurations and expressions from neutral cwd',
      'kills and settles an actual hanging child at the fixed deadline',
      'demonstrates actual WASM cap in a test-owned canary, never authored source',
      'freshly reproduces every actual recorded validator specimen without injecting parser results'
    ] }]
  ]);
  let total = 0;
  for (const suite of report.testResults) {
    const name = String(suite.name).replaceAll('\\', '/').split('/').at(-1), contract = expected.get(name);
    assert.ok(contract, 'Unexpected or duplicate parser qualification suite.');
    expected.delete(name);
    assert.ok(Array.isArray(suite.assertionResults) && suite.assertionResults.length >= contract.minimum, 'Missing parser qualification cases.');
    for (const test of suite.assertionResults) assert.equal(test.status, 'passed', 'Every applicable native parser case must pass.');
    const names = suite.assertionResults.map(test => test.title);
    for (const title of contract.required) assert.ok(names.includes(title), `Missing required parser case: ${title}`);
    total += suite.assertionResults.length;
  }
  assert.equal(expected.size, 0);
  assert.equal(report.numPassedTests, total, 'Qualification count must match actual results.');
}

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
    const parserQualification = ['ci.yml', 'release.yml'].includes(filename) && id === 'qualify-isolated-hcl';
    const bundleQualification = filename === 'ci.yml' && id === 'qualify-native-bundle';
    assert.ok(['ubuntu-latest', 'macos-latest', 'windows-latest', '${{ matrix.os }}'].includes(job['runs-on']) ||
      (parserQualification || bundleQualification) && job['runs-on'] === 'macos-15', `${filename}/${id}: use reviewed hosted runners.`);
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
    if (['ci.yml', 'release.yml'].includes(filename)) {
      assert.deepEqual(workflow.jobs['qualify-isolated-hcl'], isolatedHclQualificationJob(filename),
        `${filename}: isolated HCL qualification must retain its exact reviewed runner, runtime, native mode, commands and evidence steps.`);
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
  if (filename === 'ci.yml') {
    assert.deepEqual(workflow.jobs['qualify-native-bundle'], nativeBundleQualificationJob(),
      'Native bundle qualification must retain its exact reviewed host, inputs, complete cases and report gate.');
    const platforms = ['ubuntu-latest', 'macos-latest', 'windows-latest'];
    const required = workflow.jobs.test;
    assert.deepEqual(required, {
      name: 'Test (${{ matrix.os }})', 'runs-on': 'ubuntu-latest', 'timeout-minutes': 5,
      if: '${{ always() }}', needs: 'test-shards',
      strategy: { 'fail-fast': false, matrix: { os: platforms } },
      steps: [{
        name: 'Require every platform shard',
        env: { SHARD_RESULT: '${{ needs.test-shards.result }}' },
        run: 'test "$SHARD_RESULT" = success'
      }]
    }, 'Required platform checks must fail unless every shard succeeds, including cancelled or skipped shards.');
    const job = workflow.jobs['test-shards'];
    assert.deepEqual(job?.strategy?.matrix, { os: platforms, shard: [1, 2] },
      'Full-suite sharding requires both shards on all three hosted platforms.');
    assert.equal(job.strategy['fail-fast'], false, 'Retain diagnostics from every shard.');
    assert.equal(job['runs-on'], '${{ matrix.os }}');
    assert.equal(job.needs, undefined);
    assert.equal(job.if, undefined, 'Native plugin qualification cannot skip a platform.');
    const steps = job.steps, position = command => steps.findIndex(step => step.run === command);
    const run = position(pluginPathTestCommand);
    const verify = position('node scripts/check-repository-policy.mjs --plugin-path-report qualification/plugin-paths.json');
    const packageCheck = position(platformShardCheckCommand);
    assert.ok(run > position('npm ci') && verify > run && packageCheck > verify,
      'Run and verify complete native plugin qualification after dependency installation and before the package check.');
    assert.equal(steps.filter(step => step.run === platformShardCheckCommand).length, 1);
    assert.equal(steps[packageCheck].if, undefined, 'Every shard must run its complete unfiltered test selection.');
    assert.equal(steps.filter(step => step.run === pluginPathTestCommand).length, 1);
    assert.equal(steps[run].if, undefined);
    assert.equal(steps[verify].if, undefined);
    const upload = steps.find(step => step.with?.path === 'qualification/plugin-paths.json');
    assert.ok(upload?.uses.startsWith('actions/upload-artifact@'), 'Native plugin qualification needs its report artifact.');
    assert.equal(upload.if, independentStepCondition);
    assert.equal(upload.with['if-no-files-found'], 'error');
    assert.equal(upload.with.name, 'liftoff-plugin-paths-${{ runner.os }}-${{ matrix.shard }}-${{ github.run_id }}-${{ github.run_attempt }}');
    const testUpload = steps.find(step => step.with?.path === 'qualification/platform-tests.json');
    assert.ok(testUpload?.uses.startsWith('actions/upload-artifact@'));
    assert.equal(testUpload.if, independentStepCondition);
    assert.equal(testUpload.with['if-no-files-found'], 'error');
    assert.equal(testUpload.with.name, 'liftoff-platform-tests-${{ runner.os }}-${{ matrix.shard }}-${{ github.run_id }}-${{ github.run_attempt }}');
    for (const [id, command] of Object.entries(coverageGateJobs)) {
      const job = workflow.jobs[id];
      assert.ok(job && job.if === undefined && job['runs-on'] === 'ubuntu-latest', `ci.yml/${id}: the independent coverage gate must run on every CI event.`);
      const gates = job.steps.filter(step => step.run === command);
      assert.ok(gates.length === 1 && gates[0].if === undefined, `ci.yml/${id}: run ${command} exactly once without a condition.`);
    }
  }
  if (release) {
    const steps = workflow.jobs.qualify.steps;
    const position = command => steps.findIndex(step => step.run === command);
    const cli = position(coverageGateJobs['coverage-cli']);
    const gateway = position(coverageGateJobs['coverage-gateway']);
    const install = position(gatewayInstallCommand);
    const pack = steps.findIndex(step => step.id === 'bundle');
    assert.ok(cli >= 0 && gateway >= 0 && pack > cli && pack > gateway, 'Release qualification must run both independent coverage gates before packing.');
    assert.equal(steps[cli].if, undefined, 'Release CLI coverage cannot be skipped.');
    // An omitted condition is GitHub's implicit success(), which would skip the
    // gateway report whenever an earlier step (such as CLI coverage) failed.
    assert.equal(steps[gateway].if, independentStepCondition, 'Release gateway coverage must run whatever the CLI result.');
    assert.ok(install > cli && install < gateway && steps[install].if === independentStepCondition,
      'Release gateway coverage needs its dependency install to run whatever the CLI result.');
    assert.equal(steps[pack].if, undefined, 'Packing requires every earlier qualification step, including both coverage gates, to succeed.');
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
    assert.deepEqual(Object.keys(workflow.jobs).sort(), ['publish', 'qualify', 'qualify-isolated-hcl'], 'Release job inventory must remain explicit.');
    assert.equal(workflow.jobs.qualify.needs, 'qualify-isolated-hcl', 'Release qualification must wait for native parser qualification.');
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
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === '--plugin-path-report') {
    checkPluginPathReport(JSON.parse(await readFile(args[1], 'utf8')));
    console.log(`All applicable native plugin path cases passed on ${process.platform}; other hosts require their own reports.`);
    return;
  }
  if (args.length === 1 && args[0] === '--hcl-runtime') {
    checkIsolatedHclRuntime();
    console.log('Native parser qualification runtime verified; no parser readiness is inferred yet.');
    return;
  }
  if (args.length === 2 && args[0] === '--hcl-report') {
    checkIsolatedHclRuntime();
    checkIsolatedHclReport(JSON.parse(await readFile(args[1], 'utf8')));
    console.log('All required native parser qualification suites and cases passed without skips.');
    return;
  }
  assert.equal(args.length, 0, 'Unsupported repository policy arguments.');
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
