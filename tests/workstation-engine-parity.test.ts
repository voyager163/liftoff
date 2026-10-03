import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LinuxFamily, SupportedPlatform, WorkstationRequirementId } from '../src/workstation-catalog.js';
import {
  compareRequirementObservations, detectHostEnvironment, installRequirement, parseLinuxFamily, probeRequirement,
  probeWorkstation, selectRemediation, type RequirementProbeResult, type SelectedRequirement, type WorkstationProbeOptions
} from '../src/workstation.js';
import {
  EngineHarness, fixtureRoot, installRecord, probeRecord, requirementFor, resolvedIdentity, type ToolScript
} from './fixtures/workstation-engine.js';

// Characterization captured from the pre-extraction implementation through the stable workstation facade.
// Runner, observer and no-progress store calls, fingerprints and results must stay identical as the probe and
// remediation engine move between layers.

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface ProbeScenario {
  name: string;
  id: WorkstationRequirementId;
  platform?: SupportedPlatform;
  requirement?: Partial<SelectedRequirement>;
  resolutions?: Record<string, ReturnType<typeof resolvedIdentity>>;
  script: ToolScript;
  options?: (harness: EngineHarness) => Partial<WorkstationProbeOptions>;
  expected: [RequirementProbeResult['state'], RequirementProbeResult['reasonCode']];
}

const darwinNode = resolvedIdentity('node', '/opt/homebrew/bin/node', 'brew', '/opt/homebrew/Cellar/node@24/24.21.0/bin/node');
const probeScenarios: ProbeScenario[] = [
  { name: 'darwin Node is compatible', id: 'node', resolutions: { node: darwinNode }, script: { 'node --version': 'v24.21.0\n' }, expected: ['ready', 'compatible'] },
  { name: 'Node is missing', id: 'node', script: {}, expected: ['missing', 'missing-executable'] },
  { name: 'Node is below the supported minimum', id: 'node', resolutions: { node: darwinNode }, script: { 'node --version': 'v24.0.0\n' }, expected: ['outdated', 'below-minimum'] },
  { name: 'Node prerelease is an incompatible channel', id: 'node', resolutions: { node: darwinNode }, script: { 'node --version': 'v24.21.1-rc.1\n' }, expected: ['outdated', 'incompatible-channel'] },
  { name: 'Node outside the release line', id: 'node', resolutions: { node: darwinNode }, script: { 'node --version': 'v26.1.0\n' }, expected: ['outdated', 'release-line-mismatch'] },
  {
    name: 'Python version output cannot be parsed for any candidate', id: 'python',
    resolutions: { python3: resolvedIdentity('python3', '/usr/bin/python3') },
    script: { 'python3 --version': 'Python version unknown\n', 'python --version': 'Python version unknown\n' },
    expected: ['unhealthy', 'version-unparseable']
  },
  { name: 'uv probe times out', id: 'uv', script: { 'uv --version': { status: null, timedOut: true } }, expected: ['unhealthy', 'probe-failed'] },
  { name: 'Go probe exceeds its output bound', id: 'go', script: { 'go version': { status: null, outputLimitExceeded: true } }, expected: ['unhealthy', 'probe-failed'] },
  {
    name: 'Docker is compatible but its daemon is unhealthy', id: 'docker',
    script: {
      'docker --version': 'Docker version 28.1.1, build fixture\n',
      'docker info --format {{.ServerVersion}}': { status: 1, stderr: 'Cannot connect to the Docker daemon' }
    },
    expected: ['ready', 'compatible']
  },
  {
    name: 'Azure CLI is compatible and authenticated', id: 'azure-cli',
    script: {
      'az version --output json': '{"azure-cli": "2.75.0", "azure-cli-core": "2.75.0"}\n',
      'az account show --output none --only-show-errors': ''
    },
    expected: ['ready', 'compatible']
  },
  {
    name: 'GitHub CLI authentication is unhealthy', id: 'github-cli',
    script: {
      'gh --version': 'gh version 2.80.0 (2026-01-01)\n',
      'gh auth status': { status: 1, stderr: 'You are not logged into any GitHub hosts. token=fixture-secret' }
    },
    expected: ['ready', 'compatible']
  },
  { name: 'Claude doctor is healthy', id: 'claude', script: { 'claude --version': '2.1.0 (Claude Code)\n', 'claude doctor': 'ok\n' }, expected: ['ready', 'compatible'] },
  { name: 'Codex reports an owned authentication notice', id: 'codex', script: { 'codex --version': 'codex-cli 0.40.0\n' }, expected: ['ready', 'compatible'] },
  {
    name: 'Copilot is observed through the VS Code extension', id: 'github-copilot',
    resolutions: { code: resolvedIdentity('code', '/usr/local/bin/code') },
    script: { 'code --list-extensions': 'ms-python.python\nGitHub.copilot\n' }, expected: ['ready', 'compatible']
  },
  { name: 'Copilot cannot be observed without CLIs', id: 'github-copilot', script: {}, expected: ['not-observable', 'observation-unavailable'] },
  {
    name: 'Copilot VS Code discovery fails', id: 'github-copilot',
    resolutions: { code: resolvedIdentity('code', '/usr/local/bin/code') },
    script: { 'code --list-extensions': { status: 1, stderr: 'code failed' } }, expected: ['unhealthy', 'probe-failed']
  },
  { name: 'OpenSpec does not match its tested pin', id: 'openspec', script: { 'openspec --version': '1.11.4\n' }, expected: ['outdated', 'exact-version-mismatch'] },
  {
    name: 'An unregistered requested pin is unsupported', id: 'openspec', requirement: { exactVersion: '9.9.9' },
    script: {}, expected: ['not-observable', 'unsupported-constraint']
  },
  {
    name: 'A compatible Node reports a newer available update', id: 'node', resolutions: { node: darwinNode },
    script: { 'node --version': 'v24.21.0\n' },
    options: () => ({ availableUpdates: { node: { version: '24.22.0', source: 'fixture feed' } } }),
    expected: ['ready', 'compatible']
  },
  {
    name: 'A runner exception is normalized into a probe failure', id: 'node',
    script: { 'node --version': Object.assign(new Error('fixture spawn failure'), { code: 'EACCES' }) },
    expected: ['unhealthy', 'probe-failed']
  },
  {
    name: 'An injected runner without an observer uses unavailable observation', id: 'node',
    script: { 'node --version': 'v24.21.0\n' }, options: () => ({ executableObserver: undefined }), expected: ['ready', 'compatible']
  },
  {
    name: 'win32 Node resolves with pinned environment', id: 'node', platform: 'win32',
    resolutions: { node: resolvedIdentity('node', 'C:\\Program Files\\nodejs\\node.exe') },
    script: { 'node --version': 'v24.21.0\r\n' }, expected: ['ready', 'compatible']
  }
];

function prepare(platform: SupportedPlatform, resolutions: Record<string, ReturnType<typeof resolvedIdentity>> = {}, family: LinuxFamily = 'unknown') {
  const harness = new EngineHarness(platform, family);
  Object.assign(harness.resolutions, resolutions);
  return harness;
}

describe('workstation probe parity', () => {
  it.each(probeScenarios)('$name', async ({ id, platform = 'darwin', requirement, resolutions, script, options, expected }) => {
    const harness = prepare(platform, resolutions);
    const result = await probeRequirement(requirementFor(id, requirement), harness.runner(script), harness.options(options?.(harness)));
    expect([result.state, result.reasonCode]).toEqual(expected);
    expect({ trace: harness.events, result: probeRecord(result) }).toMatchSnapshot();
  });

  it('keeps probeWorkstation results in requirement order', async () => {
    const harness = prepare('darwin', { node: darwinNode });
    const script: ToolScript = {
      'node --version': 'v24.21.0\n', 'npm --version': '12.0.2\n', 'docker --version': 'Docker version 28.1.1, build fixture\n',
      'docker info --format {{.ServerVersion}}': '28.1.1\n'
    };
    const results = await probeWorkstation(['docker', 'node', 'npm'].map((id) => requirementFor(id as WorkstationRequirementId)),
      harness.runner(script), harness.options());
    const byCommand = new Map<string, string[]>();
    for (const event of harness.events) {
      const key = 'run' in event ? `run:${event.run.command.split(' ')[0]}` : 'observer' in event ? `observer:${event.target}` : 'store';
      byCommand.set(key, [...byCommand.get(key) ?? [], JSON.stringify(event)]);
    }
    expect({
      results: results.map(probeRecord),
      eventsByTarget: Object.fromEntries([...byCommand].sort(([left], [right]) => left < right ? -1 : 1))
    }).toMatchSnapshot();
  });
});

async function observed(harness: EngineHarness, id: WorkstationRequirementId, script: ToolScript, requirement?: Partial<SelectedRequirement>) {
  harness.recording = false;
  const result = await probeRequirement(requirementFor(id, requirement), harness.runner(script), harness.options());
  harness.recording = true;
  return result;
}

interface SelectionScenario {
  name: string;
  id: WorkstationRequirementId;
  platform: SupportedPlatform;
  family?: LinuxFamily;
  resolutions?: Record<string, ReturnType<typeof resolvedIdentity>>;
  script: ToolScript;
  selected?: Partial<SelectedRequirement>;
  recipe?: string;
}

const npmOpenSpec = resolvedIdentity('openspec', '/usr/local/bin/openspec', 'npm', '/usr/local/lib/node_modules/@fission-ai/openspec/bin/openspec.js');
const selectionScenarios: SelectionScenario[] = [
  { name: 'a compatible requirement needs no remedy', id: 'node', platform: 'darwin', resolutions: { node: darwinNode }, script: { 'node --version': 'v24.21.0\n' } },
  { name: 'darwin missing Node selects the registered Homebrew install', id: 'node', platform: 'darwin', script: {} },
  { name: 'win32 missing Node selects the registered WinGet install', id: 'node', platform: 'win32', script: {} },
  { name: 'linux missing Node falls back to the Debian manual remedy', id: 'node', platform: 'linux', family: 'debian', script: {} },
  { name: 'linux missing OpenSpec selects the npm install', id: 'openspec', platform: 'linux', family: 'fedora', script: {} },
  {
    name: 'an npm-owned OpenSpec pin mismatch offers a reviewed version change', id: 'openspec', platform: 'darwin',
    resolutions: { openspec: npmOpenSpec }, script: { 'openspec --version': '1.11.4\n' }
  },
  { name: 'an unknown-origin outdated Node stays manual', id: 'node', platform: 'darwin', resolutions: { node: resolvedIdentity('node', '/usr/local/bin/node') }, script: { 'node --version': 'v24.0.0\n' } },
  {
    name: 'a probe for another constraint is never reused', id: 'node', platform: 'darwin', script: {},
    selected: { minimumVersion: '24.21.0' }
  },
  {
    name: 'an explicitly requested unmatched recipe stays manual', id: 'node', platform: 'darwin', script: {},
    recipe: 'node:darwin:brew:upgrade'
  }
];

describe('workstation remediation selection parity', () => {
  it.each(selectionScenarios)('$name', async ({ id, platform, family = 'unknown', resolutions, script, selected, recipe }) => {
    const harness = prepare(platform, resolutions, family);
    const probe = await observed(harness, id, script);
    const selection = selectRemediation(requirementFor(id, selected), probe, { platform, linuxFamily: family }, recipe);
    expect({ probe: probeRecord(probe), selection: { ...selection, recipe: selection.recipe ?? null } }).toMatchSnapshot();
  });
});

interface InstallScenario {
  name: string;
  id: WorkstationRequirementId;
  platform: SupportedPlatform;
  family?: LinuxFamily;
  before: ToolScript;
  beforeResolutions?: Record<string, ReturnType<typeof resolvedIdentity>>;
  install: ToolScript;
  afterResolutions?: Record<string, ReturnType<typeof resolvedIdentity>>;
  inspections?: Record<string, ReturnType<typeof resolvedIdentity> | { executable: string; resolution: 'not-observable'; origin: 'unknown'; evidence: 'unavailable' }>;
  authorized?: boolean;
  approved?: boolean;
  store?: { find?: EngineHarness['storeFind']; record?: EngineHarness['storeRecord'] };
  repeat?: boolean;
  expected: [string, string];
}

const brewNodeInstall = 'brew install node@24';
const npmOpenSpecInstall = 'npm install -g @fission-ai/openspec@1.11.0';
const npmHealthy = { 'npm --version': '12.0.2\n' };
const installScenarios: InstallScenario[] = [
  {
    name: 'a compatible requirement is not remediated', id: 'node', platform: 'darwin',
    beforeResolutions: { node: darwinNode }, before: { 'node --version': 'v24.21.0\n' }, install: {}, expected: ['not-needed', 'verified']
  },
  { name: 'an unauthorized remedy is declined', id: 'node', platform: 'darwin', before: {}, install: {}, authorized: false, expected: ['declined', 'not-authorized'] },
  { name: 'a Linux manual remedy has no recipe', id: 'node', platform: 'linux', family: 'arch', before: {}, install: {}, expected: ['manual', 'recipe-unavailable'] },
  {
    name: 'a version change requires its own explicit review', id: 'openspec', platform: 'darwin',
    beforeResolutions: { openspec: npmOpenSpec }, before: { 'openspec --version': '1.11.4\n' }, install: {}, expected: ['manual', 'review-required']
  },
  {
    name: 'persisted no-progress history suppresses the unchanged remedy', id: 'node', platform: 'darwin', before: {}, install: {},
    store: { find: 'match' }, expected: ['unchanged', 'no-progress']
  },
  {
    name: 'an unreadable no-progress history blocks the remedy', id: 'node', platform: 'darwin', before: {}, install: {},
    store: { find: 'throw-error' }, expected: ['failed', 'history-storage-failed']
  },
  {
    name: 'a non-error history failure is reported without its value', id: 'node', platform: 'darwin', before: {}, install: {},
    store: { find: 'throw-value' }, expected: ['failed', 'history-storage-failed']
  },
  {
    name: 'an unavailable Homebrew is not bootstrapped', id: 'node', platform: 'darwin', before: {},
    install: { 'brew --version': { status: 1, stderr: 'brew failed' } }, expected: ['manual', 'manager-unavailable']
  },
  { name: 'an unavailable npm is not bootstrapped', id: 'openspec', platform: 'linux', before: {}, install: {}, expected: ['manual', 'manager-unavailable'] },
  {
    name: 'a failing installer reports execution failure', id: 'node', platform: 'darwin', before: {},
    install: { 'brew --version': 'Homebrew 5.0.0\n', [brewNodeInstall]: { status: 1, stderr: 'Error: node@24 formula failure' } },
    expected: ['failed', 'execution-failed']
  },
  {
    name: 'an installer timeout reports execution failure', id: 'node', platform: 'darwin', before: {},
    install: { 'brew --version': 'Homebrew 5.0.0\n', [brewNodeInstall]: { status: null, timedOut: true } },
    expected: ['failed', 'execution-failed']
  },
  {
    name: 'an installed tool is verified independently', id: 'node', platform: 'darwin', before: {},
    install: { 'brew --version': 'Homebrew 5.0.0\n', [brewNodeInstall]: 'installed\n', 'node --version': 'v24.21.0\n' },
    afterResolutions: { node: darwinNode }, expected: ['installed', 'verified']
  },
  {
    name: 'an npm global install found outside PATH requires restart', id: 'openspec', platform: 'linux', family: 'debian', before: {},
    install: { ...npmHealthy, [npmOpenSpecInstall]: 'added 1 package\n', 'npm prefix -g': '/fixture/npm-global\n' },
    afterResolutions: { npm: resolvedIdentity('npm', '/usr/bin/npm') },
    inspections: { '/fixture/npm-global/bin/openspec': resolvedIdentity('openspec', '/fixture/npm-global/bin/openspec', 'npm') },
    expected: ['restart-required', 'executable-discovery']
  },
  {
    name: 'a Homebrew formula prefix discovery requires restart', id: 'node', platform: 'darwin', before: {},
    install: { 'brew --version': 'Homebrew 5.0.0\n', [brewNodeInstall]: 'installed\n', 'brew --prefix node@24': '/opt/homebrew/opt/node@24\n' },
    inspections: { '/opt/homebrew/opt/node@24/bin/node': resolvedIdentity('node', '/opt/homebrew/opt/node@24/bin/node', 'brew') },
    expected: ['restart-required', 'executable-discovery']
  },
  {
    name: 'an incompletely observed WinGet location reports no progress', id: 'node', platform: 'win32', before: {},
    install: {
      'winget --version': 'v1.11.0\n',
      'winget install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements': 'installed\n'
    },
    inspections: {
      [path.win32.join(fixtureRoot('win32'), 'home', 'AppData', 'Local', 'Microsoft', 'WindowsApps', 'node.exe')]:
        { executable: 'node.exe', resolution: 'not-observable', origin: 'unknown', evidence: 'unavailable' }
    },
    expected: ['unchanged', 'no-progress']
  },
  {
    name: 'an empty uv tool directory reports no progress', id: 'spec-kit', platform: 'linux', family: 'fedora', before: {},
    install: { 'uv --version': 'uv 0.12.7\n', 'uv tool install specify-cli==1.0.1': 'installed\n', 'uv tool dir --bin': '/fixture/uv-bin\n' },
    afterResolutions: { uv: resolvedIdentity('uv', '/usr/local/bin/uv') },
    expected: ['unchanged', 'no-progress']
  },
  {
    name: 'a zero exit that leaves the tool outdated stays unresolved', id: 'node', platform: 'darwin',
    beforeResolutions: { node: darwinNode }, before: { 'node --version': 'v24.0.0\n' },
    install: {
      'brew --version': 'Homebrew 5.0.0\n', 'brew upgrade node@24': 'upgraded\n', 'node --version': 'v24.10.0\n'
    },
    afterResolutions: { node: darwinNode }, expected: ['unresolved', 'verification-unresolved']
  },
  {
    name: 'an unchanged attempt is recorded and not repeated with the same runner', id: 'node', platform: 'darwin', before: {},
    install: { 'brew --version': 'Homebrew 5.0.0\n', [brewNodeInstall]: 'installed\n' }, repeat: true,
    expected: ['unchanged', 'no-progress']
  },
  {
    name: 'a failed no-progress receipt write is reported', id: 'node', platform: 'darwin', before: {},
    install: { 'brew --version': 'Homebrew 5.0.0\n', [brewNodeInstall]: 'installed\n' }, store: { record: 'throw' },
    expected: ['failed', 'history-storage-failed']
  }
];

describe('workstation installer parity', () => {
  it.each(installScenarios)('$name', async (scenario) => {
    const { id, platform, family = 'unknown' } = scenario;
    const harness = prepare(platform, scenario.beforeResolutions, family);
    const before = await observed(harness, id, scenario.before);
    Object.assign(harness.resolutions, scenario.afterResolutions ?? {});
    Object.assign(harness.inspections, scenario.inspections ?? {});
    if (scenario.store?.find) harness.storeFind = scenario.store.find;
    if (scenario.store?.record) harness.storeRecord = scenario.store.record;
    const selection = selectRemediation(requirementFor(id), before, { platform, linuxFamily: family });
    const runner = harness.runner(scenario.install);
    const context = {
      ...harness.options(), authorized: scenario.authorized ?? true, host: { platform, linuxFamily: family }, runner,
      streamOptions: { stdout: harness.stdout, stderr: harness.stderr }, noProgressStore: harness.store,
      ...(scenario.approved && selection.recipe ? { approvedRemediationId: selection.recipe.id } : {})
    };
    const result = await installRequirement(requirementFor(id), before, context);
    const repeated = scenario.repeat ? await installRequirement(requirementFor(id), before, context) : undefined;
    expect([(repeated ?? result).state, (repeated ?? result).reasonCode]).toEqual(scenario.expected);
    expect({
      before: probeRecord(before),
      trace: harness.events,
      result: installRecord(result),
      ...(repeated ? { repeated: installRecord(repeated) } : {})
    }).toMatchSnapshot();
  });
});

describe('workstation progress and host parity', () => {
  it('classifies remediation progress between observations', async () => {
    const harness = prepare('darwin', { node: darwinNode });
    const missing = await observed(harness, 'node', {});
    const outdated = await observed(harness, 'node', { 'node --version': 'v24.0.0\n' });
    const newer = await observed(harness, 'node', { 'node --version': 'v24.10.0\n' });
    const ready = await observed(harness, 'node', { 'node --version': 'v24.21.0\n' });
    const unparseable = await observed(harness, 'node', { 'node --version': 'node version unknown\n' });
    const channel = await observed(harness, 'node', { 'node --version': 'v24.21.1-rc.1\n' });
    const failed = await observed(harness, 'node', { 'node --version': { status: 1, stderr: 'broken' } });
    expect({
      ready: compareRequirementObservations(missing, ready),
      unchanged: compareRequirementObservations(outdated, outdated),
      discovered: compareRequirementObservations(missing, outdated),
      parsed: compareRequirementObservations(unparseable, outdated),
      channel: compareRequirementObservations(channel, outdated),
      raised: compareRequirementObservations(outdated, newer),
      changed: compareRequirementObservations(outdated, failed),
      lowered: compareRequirementObservations(newer, outdated)
    }).toMatchSnapshot();
  });

  it('parses Linux families and detects hosts without reading on macOS or Windows', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'lf-host-'));
    temporary.push(directory);
    const releases: Record<string, string> = {
      ubuntu: 'NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\n',
      rocky: 'ID="rocky"\nID_LIKE="rhel centos fedora"\n',
      manjaro: 'ID=manjaro\nID_LIKE=arch\n',
      alpine: 'ID=alpine\n',
      mint: 'ID=linuxmint\nID_LIKE="ubuntu debian"\n'
    };
    const detected: Record<string, unknown> = {};
    for (const [name, content] of Object.entries(releases)) {
      const file = path.join(directory, name);
      await writeFile(file, content);
      detected[name] = await detectHostEnvironment('linux', file);
    }
    const absent = path.join(directory, 'absent');
    expect({
      parsed: Object.fromEntries(Object.entries(releases).map(([name, content]) => [name, parseLinuxFamily(content)])),
      detected,
      missing: await detectHostEnvironment('linux', absent),
      darwin: await detectHostEnvironment('darwin', absent),
      win32: await detectHostEnvironment('win32', absent)
    }).toMatchSnapshot();
  });
});
