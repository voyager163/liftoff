#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import {
  nativeContainerToolProfile,
  nativeCustodyQualificationCommands,
  qualifiedOpenSpecProfile
} from './native-custody-qualification.mjs';

export const communityFiles = [
  'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md', 'GOVERNANCE.md', 'SUPPORT.md'
];
export const workflowFiles = [
  'ci.yml', 'repository.yml', 'release.yml', 'template-dependency-audit.yml', 'supported-stack-freshness.yml',
  'github-job-identity.yml'
];
export function githubJobIdentityQualificationWorkflow() {
  const condition = "${{ github.repository == 'voyager163/liftoff' && github.event_name == 'workflow_dispatch' && github.run_attempt == 1 && github.ref_type == 'branch' }}";
  const node = { uses: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020', with: { 'node-version': '24.21.0' } };
  const artifact = (kind, artifactPath) => ({
    uses: 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
    with: { name: `liftoff-job-identity-${kind}-\${{ github.run_id }}-\${{ github.run_attempt }}`,
      path: artifactPath, 'if-no-files-found': 'error', 'retention-days': 14 }
  });
  return {
    name: 'GitHub job identity qualification', on: { workflow_dispatch: null }, permissions: { contents: 'read' },
    jobs: {
      'prepare-job-identity': {
        name: 'Prepare dependency-free job identity program', if: condition,
        'runs-on': 'ubuntu-latest', 'timeout-minutes': 5, permissions: { contents: 'read' },
        steps: [
          { uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
            with: { ref: '${{ github.sha }}', 'persist-credentials': false } },
          structuredClone(node),
          { name: 'Transform only the explicit identity program with Node built-ins',
            run: 'node scripts/qualify-github-job-identity.mjs prepare' },
          artifact('program', 'qualification/job-identity-program')
        ]
      },
      'observe-job-identity': {
        name: 'Observe signed GitHub job identity', needs: 'prepare-job-identity', if: condition,
        'runs-on': 'ubuntu-latest', 'timeout-minutes': 5,
        permissions: { contents: 'read', actions: 'read', 'id-token': 'write' },
        steps: [
          structuredClone(node),
          { uses: 'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
            with: { name: 'liftoff-job-identity-program-${{ github.run_id }}-${{ github.run_attempt }}',
              path: 'qualification/job-identity-program' } },
          { name: 'Verify signed original job facts without publishing or cloud access',
            env: { GH_TOKEN: '${{ github.token }}' },
            run: 'node qualification/job-identity-program/qualify.mjs observe' },
          artifact('report', 'qualification/job-identity-program/job-identity-report.json')
        ]
      }
    }
  };
}
export const allowedActions = [
  'actions/checkout', 'actions/setup-node', 'actions/setup-python', 'actions/setup-go',
  'opentofu/setup-opentofu', 'actions/upload-artifact', 'actions/download-artifact'
];
export const publicationCondition = "${{ github.event_name == 'push' && github.repository == 'voyager163/liftoff' && github.ref_type == 'tag' && startsWith(github.ref, 'refs/tags/v') }}";
export const coverageGateJobs = {
  'coverage-cli': 'npm run coverage:cli',
  'coverage-gateway': 'npm run coverage:gateway'
};
export const ciCoverageGateJobs = {
  ...coverageGateJobs,
  'coverage-cli': `${coverageGateJobs['coverage-cli']} -- --max-workers 4`
};
export const qualificationSourceRef = '${{ github.event.pull_request.head.sha || github.sha }}';
export const gatewayInstallCommand = 'npm ci --prefix services/telemetry-ingest';
export const independentStepCondition = '${{ !cancelled() }}';
export const nativeCustodyWorkflowFile = 'repository.yml';
export const nativeCustodyFocusedFiles = [
  'tests/governance-state-handover.test.ts',
  'tests/governance-transitions.test.ts',
  'tests/governance-activation-v2.test.ts',
  'tests/modern-activation-contract-parity.test.ts',
  'tests/update-compatibility.test.ts',
  'tests/contract-baseline.test.ts',
  'tests/governance-extraction.test.ts',
  'tests/plugin-generation-parity.test.ts',
  'tests/generator-parity.test.ts',
  'tests/modern-managed-core.test.ts',
  'tests/modern-source-registry.test.ts',
  'tests/pre-assessment-source-contract.test.ts',
  'tests/project-telemetry-source.test.ts',
  'tests/documentation.test.ts',
  'tests/developer-activation-documentation.test.ts'
];
export const nativeCustodyCommands = nativeCustodyQualificationCommands;
export const platformShardCheckCommand = 'npm run check:supported-stack && npm run build && ' +
  'npx vitest run --shard=${{ matrix.shard }}/4 --allowOnly=false ' +
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
const programBoundaryGroup = 'private original-program input boundary without manufactured assembly facts';
const genuineProgramGroup = 'genuine original current5 program construction and consumption';
export const workflowProgramContentCases = Object.freeze([
  ...['path', 'installedRoot', 'archive', 'manifest', 'receipt', 'reader', 'callback', 'authenticated', 'observedAt']
    .map(field => `${programBoundaryGroup} rejects caller-selected ${field} before original assembly observation`),
  ...['ordinary', 'copy', 'json', 'proxy', 'accessor']
    .map(kind => `${programBoundaryGroup} refuses ${kind} counterfeit original assembly without invoking hooks`),
  ...['context-copy', 'runtime-copy', 'proxy', 'accessor', 'extra-symbol', 'hidden-field']
    .map(kind => `${programBoundaryGroup} refuses ${kind} request reconstruction without invoking hooks`),
  `${programBoundaryGroup} refuses a fabricated content token and proxy without reading their properties or returning archive bytes`,
  `${genuineProgramGroup} builds, packs and installs the actual versioned program before issuing any Source content token`,
  ...['manual', 'openspec', 'spec-kit'].flatMap(workflow =>
    ['single-maintainer-gitflow', 'team-gitflow'].map(profile =>
      `${genuineProgramGroup} binds actual original archive and complete installed content for ${workflow}/${profile} without issuing release authority`)),
  `${genuineProgramGroup} rejects copied tokens, foreign original contexts/runtimes and getter-bearing substitutes`,
  `${genuineProgramGroup} freshly consumes original runtime, validator and independent archive bytes without trusting the readback as a token`,
  `${genuineProgramGroup} captures original request references before caller substitution and refuses same-byte physical output replacement`
]);
export function checkWorkflowProgramContentReport(report) {
  assert.equal(report.success, true, 'Original program consumer qualification must succeed.');
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numFailedTestSuites, 0);
  assert.equal(report.numPendingTests, 0, 'Genuine original program consumer cases cannot be skipped.');
  assert.equal(report.numPassedTests, workflowProgramContentCases.length);
  assert.equal(report.numTotalTests, workflowProgramContentCases.length);
  assert.ok(Array.isArray(report.testResults) && report.testResults.length === 1,
    'A separate complete original program consumer report is required.');
  const suite = report.testResults[0];
  assert.ok(typeof suite.name === 'string' &&
    suite.name.replaceAll('\\', '/').endsWith('/tests/workflow-source5-program-content.test.ts'),
  'The exact original program consumer suite is required.');
  assert.ok(Array.isArray(suite.assertionResults), 'Original program consumer cases are missing.');
  assert.deepEqual(suite.assertionResults.map(test => test.fullName).sort(), [...workflowProgramContentCases].sort(),
    'Original program consumer cases are missing, duplicated or unexpected.');
  assert.ok(suite.assertionResults.every(test => test.status === 'passed'),
    'Every original program consumer case must run and pass.');
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
      { uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
        with: { ref: qualificationSourceRef, 'persist-credentials': false } },
      { uses: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
        with: { 'node-version': '24.21.0', architecture: 'arm64', cache: 'npm' } },
      { uses: 'actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e',
        with: { 'go-version': '1.27.0', 'cache-dependency-path': 'assets/supported-stack.json' } },
      { name: 'Select supported npm', run: 'npm install --global "npm@12.0.2"' },
      { name: 'Install dependencies', run: 'npm ci' },
      { name: 'Retrieve pinned runtime and historical client', shell: 'bash', run: [
        'url="$(node --input-type=module -e \'import inputs from "./distribution/native/inputs.json" with { type: "json" }; console.log(inputs.runtime.url)\')"',
        'curl --fail --location --proto \'=https\' --proto-redir \'=https\' --max-time 180 \\',
        '  "$url" --output "$RUNNER_TEMP/liftoff-node-runtime.tgz"',
        'curl --fail --location --proto \'=https\' --proto-redir \'=https\' --max-time 60 \\',
        '  \'https://registry.npmjs.org/@msn-control/liftoff/-/liftoff-0.3.4.tgz\' \\',
        '  --output "$RUNNER_TEMP/liftoff-historical-0.3.4.tgz"',
        'printf \'%s  %s\\n\' \'05793480c44632b3fc01ac98a4f76a73313d8b273afcb30bde5c22de989d69c0\' \\',
        '  "$RUNNER_TEMP/liftoff-historical-0.3.4.tgz" | shasum --algorithm 256 --check', ''
      ].join('\n') },
      { name: 'Assemble the development bundle', run: 'npm run build:native -- build ' +
        '--runtime-archive "$RUNNER_TEMP/liftoff-node-runtime.tgz" --output "$RUNNER_TEMP/liftoff-native-bundle"' },
      { name: 'Qualify actual installed behavior', shell: 'bash', run: [
        'node scripts/native-release.mjs archive "$RUNNER_TEMP/liftoff-native-bundle" "$RUNNER_TEMP/liftoff-native-archive"',
        'LIFTOFF_NATIVE_BUNDLE_ROOT="$RUNNER_TEMP/liftoff-native-bundle" \\',
        'LIFTOFF_MAC_MIGRATION_BUNDLE_ROOT="$RUNNER_TEMP/liftoff-native-bundle" \\',
        'LIFTOFF_NATIVE_GO_EXECUTABLE="$(command -v go)" \\',
        'LIFTOFF_NATIVE_PACKAGE_ROOT="$RUNNER_TEMP/liftoff-native-bundle" \\',
        'LIFTOFF_NATIVE_ARCHIVE_ROOT="$RUNNER_TEMP/liftoff-native-archive" \\',
        'LIFTOFF_NATIVE_PROGRAM_RUNTIME_ARCHIVE="$RUNNER_TEMP/liftoff-node-runtime.tgz" \\',
        'npx vitest run tests/native-bundle.test.ts tests/native-bundle-installed.test.ts \\',
        '  tests/native-distribution.test.ts tests/native-release-set.test.ts tests/native-package-installed.test.ts \\',
        '  tests/mac-migration-package.test.ts tests/mac-migration-preparation.test.ts tests/mac-migration-cask-stage.test.ts \\',
        '  --maxWorkers=1 --no-file-parallelism --coverage.enabled=false --allowOnly=false \\',
        '  --reporter=default --reporter=json --outputFile.json=qualification/native-bundle.json',
        'node scripts/native-bundle.mjs verify-report qualification/native-bundle.json',
        'node scripts/native-package-report.mjs qualification/native-bundle.json "$RUNNER_TEMP/liftoff-native-bundle"',
        'node scripts/mac-migration-package-report.mjs qualification/native-bundle.json',
        'journey="$(node scripts/mac-migration-journey-report.mjs select "$RUNNER_TEMP/liftoff-native-bundle")"',
        'case "$journey" in',
        '  stable-handover) journey_test=tests/mac-migration-journey.test.ts ;;',
        '  prerelease-refusal) journey_test=tests/mac-migration-prerelease.test.ts ;;',
        '  *) printf \'Unsupported migration journey outcome: %s\\n\' "$journey" >&2; exit 1 ;;',
        'esac',
        'journey_report="qualification/mac-migration-${journey}.json"',
        'LIFTOFF_MAC_MIGRATION_BUNDLE_ROOT="$RUNNER_TEMP/liftoff-native-bundle" \\',
        'LIFTOFF_MAC_MIGRATION_HISTORICAL_TARBALL="$RUNNER_TEMP/liftoff-historical-0.3.4.tgz" \\',
        'npx vitest run "$journey_test" \\',
        '  --maxWorkers=1 --no-file-parallelism --coverage.enabled=false --allowOnly=false \\',
        '  --reporter=default --reporter=json --outputFile.json="$journey_report"',
        'node scripts/mac-migration-journey-report.mjs "$journey_report" "$RUNNER_TEMP/liftoff-native-bundle" "$journey" \\',
        '  > "qualification/mac-migration-${journey}-outcome.json"',
        'LIFTOFF_NATIVE_PROGRAM_RUNTIME_ARCHIVE="$RUNNER_TEMP/liftoff-node-runtime.tgz" \\',
        'npx vitest run tests/workflow-source5-program-content.test.ts \\',
        '  --maxWorkers=1 --no-file-parallelism --coverage.enabled=false --allowOnly=false \\',
        '  --reporter=default --reporter=json --outputFile.json=qualification/workflow-program-content.json',
        'node scripts/check-repository-policy.mjs --workflow-program-report qualification/workflow-program-content.json', ''
      ].join('\n') },
      { name: 'Store development qualification evidence', if: independentStepCondition,
        uses: 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
        with: { name: 'liftoff-native-bundle-ci-${{ github.run_id }}-${{ github.run_attempt }}',
          path: 'qualification/native-bundle.json\nqualification/mac-migration-*.json\nqualification/workflow-program-content.json\n${{ runner.temp }}/liftoff-native-bundle/bundle.json\n${{ runner.temp }}/liftoff-native-archive/\n',
          'if-no-files-found': 'error', 'retention-days': 14 } }
    ]
  };
}
export function nativePlatformQualificationJob() {
  return {
    name: 'Native development package (${{ matrix.target }})', 'runs-on': '${{ matrix.os }}',
    'timeout-minutes': 20, permissions: { contents: 'read' },
    strategy: { 'fail-fast': false, matrix: { include: [
      { os: 'ubuntu-24.04', target: 'linux-x64' },
      { os: 'ubuntu-24.04-arm', target: 'linux-arm64' },
      { os: 'windows-2025', target: 'win32-x64' }
    ] } },
    steps: [
      { uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
        with: { ref: qualificationSourceRef, 'persist-credentials': false } },
      { uses: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
        with: { 'node-version': '24.21.0', cache: 'npm' } },
      { name: 'Select supported npm', run: 'npm install --global "npm@12.0.2"' },
      { name: 'Install dependencies', run: 'npm ci' },
      { name: 'Compile the native Windows launcher', if: "runner.os == 'Windows'", shell: 'cmd', run: [
        'for /f "usebackq tokens=*" %%i in (`"%ProgramFiles(x86)%\\Microsoft Visual Studio\\Installer\\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do call "%%i\\Common7\\Tools\\VsDevCmd.bat" -arch=x64 -host_arch=x64',
        'cl /nologo /W4 /WX /O2 /MT /Fo:"%RUNNER_TEMP%\\liftoff-launcher.obj" /Fe:"%RUNNER_TEMP%\\liftoff-launcher.exe" distribution\\windows\\launcher.c /link /SUBSYSTEM:CONSOLE', ''
      ].join('\n') },
      { name: 'Retrieve the pinned platform runtime', shell: 'bash', run: [
        'url="$(node --input-type=module -e \'import inputs from "./distribution/native/inputs.json" with { type: "json" }; import { nativeRuntimeInput } from "./scripts/native-bundle-contract.mjs"; console.log(nativeRuntimeInput(inputs, {platform:process.platform,architecture:process.arch}).url)\')"',
        'curl --fail --location --proto \'=https\' --proto-redir \'=https\' --max-time 180 \\',
        '  "$url" --output "$RUNNER_TEMP/liftoff-platform-runtime"', ''
      ].join('\n') },
      { name: 'Prepare pinned Linux qualification userspace', if: "runner.os == 'Linux'", shell: 'bash', run: [
        'image="$(node --input-type=module -e \'import { nativeLinuxUserspaceImages } from "./scripts/native-package-report.mjs"; console.log(nativeLinuxUserspaceImages[process.arch])\')"',
        'docker pull "$image"', ''
      ].join('\n') },
      { name: 'Build and qualify the isolated native package', shell: 'bash', run: [
        'launcher=()',
        'if [ "$RUNNER_OS" = Windows ]; then launcher=(--windows-launcher "$RUNNER_TEMP/liftoff-launcher.exe"); fi',
        'npm run build:native -- build --runtime-archive "$RUNNER_TEMP/liftoff-platform-runtime" \\',
        '  --output "$RUNNER_TEMP/liftoff-native-bundle" "${launcher[@]}"',
        'node scripts/native-release.mjs archive "$RUNNER_TEMP/liftoff-native-bundle" "$RUNNER_TEMP/liftoff-native-archive"',
        'if [ "$RUNNER_OS" = Linux ]; then export LIFTOFF_NATIVE_DOCKER_EXECUTABLE="$(command -v docker)"; fi',
        'LIFTOFF_NATIVE_PACKAGE_ROOT="$RUNNER_TEMP/liftoff-native-bundle" \\',
        'LIFTOFF_NATIVE_ARCHIVE_ROOT="$RUNNER_TEMP/liftoff-native-archive" \\',
        'npx vitest run tests/native-bundle.test.ts tests/native-distribution.test.ts tests/native-release-set.test.ts tests/native-package-installed.test.ts \\',
        '  --maxWorkers=1 --no-file-parallelism --coverage.enabled=false --allowOnly=false \\',
        '  --reporter=default --reporter=json --outputFile.json=qualification/native-platform-package.json',
        'node scripts/native-package-report.mjs qualification/native-platform-package.json "$RUNNER_TEMP/liftoff-native-bundle"', ''
      ].join('\n') },
      { name: 'Store exact-source native development artifacts', if: independentStepCondition,
        uses: 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
        with: { name: 'liftoff-native-package-${{ matrix.target }}-${{ github.run_id }}-${{ github.run_attempt }}',
          path: 'qualification/native-platform-package.json\n${{ runner.temp }}/liftoff-native-bundle/bundle.json\n${{ runner.temp }}/liftoff-native-archive/\n',
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

function namedStep(job, name) {
  const matches = job.steps.filter(step => step.name === name);
  assert.equal(matches.length, 1, `Hosted native custody qualification requires exactly one ${name} step.`);
  return matches[0];
}

export function checkNativeCustodyQualificationJob(job) {
  assert.equal(job.name, 'Full suite and source-complete coverage (macOS ARM64)');
  assert.equal(job['runs-on'], 'macos-15');
  assert.equal(job['timeout-minutes'], 240, 'Measured native full-suite and coverage need the reviewed bounded timeout.');
  assert.deepEqual(job.permissions, { contents: 'read' });
  assert.deepEqual(job.env, {
    CI: 'true',
    DO_NOT_TRACK: '1',
    LIFTOFF_TELEMETRY: '0',
    LIFTOFF_HCL_TEST_LANE: 'native',
    LIFTOFF_OPENSPEC_B_TESTS: '1',
    OB1_VERSION_REMAINING: '2',
    OB1_SUPPORT_REMAINING: '10',
    LIFTOFF_OI_TESTS: '1'
  });
  assert.equal(job.steps[0].uses, 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1');
  assert.deepEqual(job.steps[0].with, { 'persist-credentials': false });
  assert.equal(job.steps[1].uses, 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020');
  assert.deepEqual(job.steps[1].with, { 'node-version': '24.21.0', architecture: 'arm64', cache: 'npm' });
  assert.equal(job.steps[2].uses, 'actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97');
  assert.deepEqual(job.steps[2].with, { 'python-version': '3.14.7' });
  assert.equal(job.steps[3].uses, 'actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e');
  assert.deepEqual(job.steps[3].with, {
    'go-version': '1.27.0',
    'cache-dependency-path': 'assets/supported-stack.json'
  });
  assert.equal(job.steps[4].uses, 'opentofu/setup-opentofu@a1320f892987e89d278cc92dc5adc984fb93aca4');
  assert.deepEqual(job.steps[4].with, { tofu_version: '1.12.6', tofu_wrapper: false });
  assert.equal(namedStep(job, 'Install uv').run, 'python -m pip install uv==0.12.7');
  const npmInstall = namedStep(job, 'Select supported npm');
  assert.equal(npmInstall.shell, 'bash');
  assert.equal(npmInstall.run.trim(), [
    'npm install --prefix "$RUNNER_TEMP/liftoff-npm" --no-package-lock --ignore-scripts --no-audit --no-fund "npm@12.0.2"',
    'echo "$RUNNER_TEMP/liftoff-npm/node_modules/.bin" >> "$GITHUB_PATH"'
  ].join('\n'));
  const containerInstall = namedStep(job, 'Install qualified Docker and Compose');
  assert.equal(containerInstall.shell, 'bash');
  assert.equal(containerInstall.run.trim(), [
    'set -euo pipefail',
    'root="$RUNNER_TEMP/liftoff-docker"',
    `archive="$RUNNER_TEMP/docker-${nativeContainerToolProfile.docker.version}.tgz"`,
    'compose="$RUNNER_TEMP/docker-compose-darwin-aarch64"',
    'mkdir -p "$root/bin" "$root/cli-plugins" "$RUNNER_TEMP/liftoff-docker-extract"',
    "curl --fail --location --proto '=https' --tlsv1.2 \\",
    '  --output "$archive" \\',
    `  "${nativeContainerToolProfile.docker.archiveUrl}"`,
    `echo "${nativeContainerToolProfile.docker.archiveSha256}  $archive" | shasum -a 256 --check`,
    'tar -xzf "$archive" -C "$RUNNER_TEMP/liftoff-docker-extract"',
    'install -m 0755 "$RUNNER_TEMP/liftoff-docker-extract/docker/docker" "$root/bin/docker"',
    "curl --fail --location --proto '=https' --tlsv1.2 \\",
    '  --output "$compose" \\',
    `  "${nativeContainerToolProfile.compose.binaryUrl}"`,
    `echo "${nativeContainerToolProfile.compose.binarySha256}  $compose" | shasum -a 256 --check`,
    'install -m 0755 "$compose" "$root/cli-plugins/docker-compose"',
    'echo "$root/bin" >> "$GITHUB_PATH"'
  ].join('\n'));
  const openspecInstall = namedStep(job, 'Install pinned OpenSpec');
  assert.equal(openspecInstall.shell, 'bash');
  assert.equal(openspecInstall.run.trim(), [
    'npm install --global --prefix "$RUNNER_TEMP/liftoff-openspec" \\',
    `  --before=${qualifiedOpenSpecProfile.registryCutoff} --no-package-lock --ignore-scripts --no-audit --no-fund \\`,
    `  ${qualifiedOpenSpecProfile.package}@${qualifiedOpenSpecProfile.version}`,
    'node scripts/native-custody-qualification.mjs verify-openspec-profile \\',
    '  "$RUNNER_TEMP/liftoff-openspec/lib/node_modules/@fission-ai/openspec"',
    'echo "$RUNNER_TEMP/liftoff-openspec/bin" >> "$GITHUB_PATH"'
  ].join('\n'));
  assert.equal(namedStep(job, 'Install dependencies').run.trim(), [
    'npm ci',
    gatewayInstallCommand
  ].join('\n'));
  const toolchain = namedStep(job, 'Verify native toolchain');
  assert.equal(toolchain.id, 'toolchain');
  for (const required of [
    "platform: 'darwin'", "architecture: 'arm64'", "node: '24.21.0'",
    "'12.0.2'", 'OpenTofu v1\\.12\\.6', "'1.11.0'", 'go1.27.0 darwin/arm64',
    'Python 3.14.7', 'uv 0\\.12\\.7',
    "realpathSync(run('/usr/bin/which', ['npm']))",
    "path.basename(npmLauncher), 'npm-cli.js'",
    "{ name: npmPackage.name, version: npmPackage.version }, { name: 'npm', version: '12.0.2' }",
    "run(process.execPath, [npmLauncher, '--version'])",
    nativeContainerToolProfile.docker.binarySha256,
    nativeContainerToolProfile.compose.binarySha256,
    `Docker version ${nativeContainerToolProfile.docker.version}, build ${nativeContainerToolProfile.docker.build}`,
    `['version', '--short']), '${nativeContainerToolProfile.compose.version}'`,
    "'liftoff-docker', 'bin', 'docker'",
    "'liftoff-docker', 'cli-plugins', 'docker-compose'",
    "'liftoff-openspec', 'lib', 'node_modules', '@fission-ai', 'openspec', 'bin', 'openspec.js'",
    'LIFTOFF_OPENSPEC_B_TESTS', 'OB1_VERSION_REMAINING', 'OB1_SUPPORT_REMAINING', 'LIFTOFF_OI_TESTS'
  ]) assert.ok(toolchain.run.includes(required), `Native toolchain check is missing ${required}.`);
  const cleanStart = namedStep(job, 'Verify exact clean candidate');
  assert.equal(cleanStart.id, 'clean-start');
  assert.ok(cleanStart.run.includes('git rev-parse HEAD'));
  assert.ok(cleanStart.run.includes('$GITHUB_SHA'));
  assert.ok(cleanStart.run.includes('git status --porcelain=v1 --untracked-files=all'));

  const gates = [
    ['Check supported stack', 'supported-stack', nativeCustodyCommands.supportedStack],
    ['Build', 'build', nativeCustodyCommands.build],
    ['Verify source-complete coverage evidence', 'coverage-verify', nativeCustodyCommands.coverageVerification],
    ['Run package smoke', 'package', nativeCustodyCommands.packageSmoke],
    ['Run repository policy', 'policy', nativeCustodyCommands.repositoryPolicy],
    ['Run strict OpenSpec validation', 'openspec', nativeCustodyCommands.openspec]
  ];
  for (const [name, id, command] of gates) {
    const step = namedStep(job, name);
    assert.equal(step.id, id);
    assert.equal(step.if, independentStepCondition);
    assert.equal(step.run, command);
  }

  const fullSuite = namedStep(job, 'Run unfiltered full suite');
  assert.equal(fullSuite.id, 'full-suite');
  assert.equal(fullSuite.if, independentStepCondition);
  assert.ok(fullSuite.run.includes(nativeCustodyCommands.fullSuite));
  assert.ok(fullSuite.run.includes('qualification/native-full-suite.log'));
  assert.ok(fullSuite.run.includes('set -o pipefail'));
  assert.ok(!fullSuite.run.includes(' --testTimeout') && !fullSuite.run.includes(' -t '));

  const coverage = namedStep(job, 'Run source-complete CLI coverage');
  assert.equal(coverage.id, 'coverage');
  assert.equal(coverage.if, independentStepCondition);
  assert.ok(coverage.run.includes(nativeCustodyCommands.coverage));
  assert.ok(coverage.run.includes('qualification/native-coverage.log'));
  assert.ok(coverage.run.includes('set -o pipefail'));
  assert.ok(!coverage.run.includes('--source') && !coverage.run.includes('coverage.enabled=false'));

  const focused = namedStep(job, 'Run focused custody and history checks');
  assert.equal(focused.id, 'focused');
  assert.equal(focused.if, independentStepCondition);
  for (const file of nativeCustodyFocusedFiles) {
    assert.equal(focused.run.split(file).length - 1, 1, `Focused custody gate must include ${file} exactly once.`);
  }
  assert.ok(focused.run.includes('--maxWorkers=1 --no-file-parallelism --reporter=dot'));
  assert.ok(focused.run.includes('qualification/native-focused.log'));
  assert.ok(!focused.run.includes(' -t '));

  const cleanFinish = namedStep(job, 'Verify final clean bytes');
  assert.equal(cleanFinish.id, 'clean-finish');
  assert.equal(cleanFinish.if, independentStepCondition);
  assert.ok(cleanFinish.run.includes('git diff --check'));
  assert.ok(cleanFinish.run.includes('git status --porcelain=v1 --untracked-files=all'));

  const record = namedStep(job, 'Record hosted native qualification evidence');
  assert.equal(record.if, independentStepCondition);
  assert.equal(record.run, 'node scripts/native-custody-qualification.mjs record qualification/native-custody.json');
  assert.deepEqual(record.env, {
    NATIVE_COMPOSE_EXECUTABLE: '${{ runner.temp }}/liftoff-docker/cli-plugins/docker-compose',
    NATIVE_TOOLCHAIN_OUTCOME: '${{ steps.toolchain.outcome }}',
    NATIVE_CLEAN_START_OUTCOME: '${{ steps.clean-start.outcome }}',
    NATIVE_SUPPORTED_STACK_OUTCOME: '${{ steps.supported-stack.outcome }}',
    NATIVE_BUILD_OUTCOME: '${{ steps.build.outcome }}',
    NATIVE_FULL_SUITE_OUTCOME: '${{ steps.full-suite.outcome }}',
    NATIVE_COVERAGE_OUTCOME: '${{ steps.coverage.outcome }}',
    NATIVE_COVERAGE_VERIFY_OUTCOME: '${{ steps.coverage-verify.outcome }}',
    NATIVE_FOCUSED_OUTCOME: '${{ steps.focused.outcome }}',
    NATIVE_PACKAGE_OUTCOME: '${{ steps.package.outcome }}',
    NATIVE_POLICY_OUTCOME: '${{ steps.policy.outcome }}',
    NATIVE_OPENSPEC_OUTCOME: '${{ steps.openspec.outcome }}',
    NATIVE_CLEAN_FINISH_OUTCOME: '${{ steps.clean-finish.outcome }}'
  });

  const upload = namedStep(job, 'Store hosted native qualification evidence');
  assert.equal(upload.if, independentStepCondition);
  assert.equal(upload.uses, 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a');
  assert.equal(upload.with.name, 'liftoff-native-custody-${{ github.run_id }}-${{ github.run_attempt }}');
  for (const artifact of [
    'qualification/native-custody.json',
    'qualification/native-full-suite.log',
    'qualification/native-coverage.log',
    'qualification/native-focused.log',
    'coverage/cli/'
  ]) assert.ok(upload.with.path.includes(artifact), `Native qualification artifact is missing ${artifact}.`);
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.equal(upload.with['retention-days'], 14);
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
  const identityQualification = filename === 'github-job-identity.yml';
  if (identityQualification) {
    assert.deepEqual(workflow, githubJobIdentityQualificationWorkflow(),
      'Only the exact closed manual job-identity workflow may request nonpublishing OIDC; no dependency execution, caller inputs or additional steps.');
  }
  const nativeCustodyWorkflow = filename === nativeCustodyWorkflowFile;
  const windowsBoundaryTimeout =
    "${{ matrix.os == 'windows-latest' && matrix.shard == 2 && 75 || 45 }}";
  assert.deepEqual(workflow.permissions, { contents: 'read' }, `${filename}: workflow default must be contents: read.`);
  assert.ok(workflow.jobs && typeof workflow.jobs === 'object', `${filename}: jobs are required.`);
  const triggers = Object.keys(workflow.on ?? {});
  const allowedTriggers = release ? ['workflow_dispatch', 'push'] : ['pull_request', 'push', 'workflow_dispatch', 'schedule'];
  assert.ok(triggers.length && triggers.every(trigger => allowedTriggers.includes(trigger)), `${filename}: unapproved trigger.`);
  for (const [id, job] of Object.entries(workflow.jobs)) {
    const parserQualification = ['ci.yml', 'release.yml'].includes(filename) && id === 'qualify-isolated-hcl';
    const bundleQualification = filename === 'ci.yml' && id === 'qualify-native-bundle';
    const nativeCustodyQualification = nativeCustodyWorkflow && id === 'qualify-native-custody';
    assert.ok(['ubuntu-latest', 'macos-latest', 'windows-latest', '${{ matrix.os }}'].includes(job['runs-on']) ||
      (parserQualification || bundleQualification || nativeCustodyQualification) && job['runs-on'] === 'macos-15',
    `${filename}/${id}: use reviewed hosted runners.`);
    const timeout = job['timeout-minutes'];
    assert.ok(
      Number.isInteger(timeout) && timeout > 0 && timeout <= 60 ||
        filename === 'ci.yml' && id === 'test-shards' &&
          timeout === windowsBoundaryTimeout ||
        nativeCustodyQualification && timeout === 240,
      `${filename}/${id}: bounded timeout required.`
    );
    assert.ok(!job['continue-on-error'], `${filename}/${id}: do not suppress a failed check.`);
    if (release && id === 'publish') {
      assert.deepEqual(job.permissions, { contents: 'read', 'id-token': 'write' }, 'Only publish gets OIDC.');
      assert.equal(job.environment, 'npm-release', 'Publishing requires the release environment.');
      assert.equal(job.needs, 'qualify', 'Publishing must depend on qualification.');
      assert.equal(job.if, publicationCondition, 'Publishing must be limited to canonical tag pushes.');
    } else if (identityQualification && id === 'observe-job-identity') {
      assert.deepEqual(job.permissions, { contents: 'read', actions: 'read', 'id-token': 'write' },
        'Only the closed manual identity observer gets nonpublishing OIDC and read-only job metadata.');
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
    for (const id of ['test-shards', 'coverage-cli']) {
      const steps = workflow.jobs[id]?.steps ?? [];
      const platforms = id === 'test-shards' ? ['Linux', 'macOS', 'Windows'] : ['Linux', 'macOS'];
      for (const platform of platforms) {
        const prepare = steps.findIndex(step => step.name === `Prepare pinned ${platform} Docker and Compose`);
        assert.deepEqual(steps[prepare], {
          name: `Prepare pinned ${platform} Docker and Compose`,
          if: `runner.os == '${platform}'`,
          run: 'node scripts/prepare-ci-local-tools.mjs'
        }, `ci.yml/${id}: prepare real pinned ${platform} container tools without suppressing failures.`);
        assert.ok(prepare < steps.findIndex(step => step.run === 'npm ci'),
          `ci.yml/${id}: prepare ${platform} tools before the test/dependency consumers.`);
      }
      assert.equal(steps.filter(step => step.run === 'node scripts/prepare-ci-local-tools.mjs').length, platforms.length);
    }
    for (const id of Object.keys(coverageGateJobs)) {
      assert.equal(workflow.jobs[id]?.steps[0]?.with?.ref, qualificationSourceRef,
        'Independent coverage must be bound to the exact owning head, not a synthetic PR merge revision.');
    }
    assert.deepEqual(workflow.jobs['qualify-native-bundle'], nativeBundleQualificationJob(),
      'Native bundle qualification must retain its exact reviewed host, inputs, complete cases and report gate.');
    assert.deepEqual(workflow.jobs['qualify-native-platform-packages'], nativePlatformQualificationJob(),
      'Native platform qualification must retain every reviewed target, native compiler, complete cases and exact artifact handoff.');
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
    assert.deepEqual(job?.strategy?.matrix, { os: platforms, shard: [1, 2, 3, 4] },
      'Full-suite sharding requires all four shards on all three hosted platforms.');
    assert.equal(job.name, 'Platform tests (${{ matrix.os }}, shard ${{ matrix.shard }}/4)');
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
    for (const [id, command] of Object.entries(ciCoverageGateJobs)) {
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
    assert.deepEqual(Object.keys(workflow.jobs), ['policy', 'qualify-native-custody']);
    const native = workflow.jobs['qualify-native-custody'];
    assert.equal(native.if, "${{ github.event_name == 'workflow_dispatch' }}",
      'Hosted native custody qualification must remain manual-only.');
    checkNativeCustodyQualificationJob(native);
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
  if (args.length === 2 && args[0] === '--workflow-program-report') {
    checkWorkflowProgramContentReport(JSON.parse(await readFile(args[1], 'utf8')));
    console.log('All 31 original program consumer cases passed, including 10 genuine cases; no host, workflow or release authority is issued.');
    return;
  }
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
