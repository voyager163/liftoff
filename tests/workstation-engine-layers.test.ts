import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { probeRequirement } from '../src/application/workstation/probe.js';
import { installRequirement, type InstallContext } from '../src/application/workstation/remediation.js';
import type { ExecutableIdentity } from '../src/domain/workstation/contracts.js';
import type { ExecutableObserver } from '../src/domain/workstation/executables.js';
import { classifyVersion, requiredConstraint } from '../src/domain/workstation/probe-classification.js';
import { pathRemedy } from '../src/domain/workstation/remediation.js';
import type { CommandResult, CommandRunner } from '../src/process-runner.js';
import { workstationRequirementCatalog, type WorkstationRequirementId } from '../src/workstation-catalog.js';
import { EngineHarness, fixtureRoot, requirementFor, resolvedIdentity, type ToolScript } from './fixtures/workstation-engine.js';

const node = requirementFor('node');
const nodeFormula = workstationRequirementCatalog.node.packageIdentities!.brew!;
const commands = (harness: EngineHarness) =>
  harness.events.flatMap((event) => 'run' in event ? [event.run.command] : []);
const inspections = (harness: EngineHarness) =>
  harness.events.flatMap((event) => 'observer' in event && event.observer === 'inspect' ? [event.target] : []);

function succeeded(stdout: string): CommandResult {
  return { command: { executable: 'fixture', args: [] }, displayCommand: 'fixture', status: 0, signal: null, stdout, stderr: '', timedOut: false };
}

async function remediate(harness: EngineHarness, id: WorkstationRequirementId, script: ToolScript, overrides: Partial<InstallContext> = {}) {
  const requirement = requirementFor(id);
  const runner = harness.runner(script);
  const before = await probeRequirement(requirement, runner, harness.options(overrides));
  const context: InstallContext = { ...harness.options(overrides), host: harness.options().host!, authorized: true, runner, ...overrides };
  return { before, result: await installRequirement(requirement, before, context) };
}

describe('pure probe classification rules', () => {
  const identity: ExecutableIdentity = resolvedIdentity('fixture', path.posix.join('/', 'fixture', 'bin', 'fixture'));

  it.each([
    ['github-cli', 'gh version 2.80.0-rc.1\n', 'Install a stable GitHub CLI release.'],
    ['node', `v${node.minimumVersion}-rc.1\n`, `Install a stable Node.js release in the supported ${node.releaseLine} line.`],
    ['openspec', '1.12.0-beta.1\n', `Install OpenSpec ${workstationRequirementCatalog.openspec.exactVersion}.`]
  ] as const)('never accepts a %s prerelease on a stable channel and names the exact stable remedy', (id, stdout, remedy) => {
    const requirement = requirementFor(id);
    const result = classifyVersion(requirement, requirement.definition.probes[0]!, succeeded(stdout), identity);
    expect(result).toMatchObject({ state: 'outdated', reasonCode: 'incompatible-channel', remedy });
  });

  it('treats an absent prerelease permission as stable-only and omits undeclared bounds', () => {
    const { allowPrerelease: _omitted, ...requirement } = requirementFor('docker');
    expect(requiredConstraint(requirement)).toEqual({ allowPrerelease: false });
  });
});

describe('pure remediation rules', () => {
  it.each([
    ['node', 'darwin', `Run \`brew --prefix ${nodeFormula}\`, ensure its bin directory is on PATH, open a new terminal, then retry node.`],
    ['go', 'darwin', 'Run `brew --prefix`, ensure its bin directory is on PATH, open a new terminal, then retry go.'],
    ['node', 'win32', 'Open a new terminal and retry node; if it is still missing, inspect the WinGet package installation and PATH aliases.'],
    ['openspec', 'linux', 'Run `npm prefix -g`, add that installation\'s bin directory to PATH, open a new terminal, then retry openspec.'],
    ['spec-kit', 'linux', 'Run `uv tool dir --bin`, add that directory to PATH, open a new terminal, then retry specify.']
  ] as const)('gives %s on %s the PATH remedy of its registered manager', (id, platform, remedy) => {
    const recipe = workstationRequirementCatalog[id].install[platform]!;
    expect(pathRemedy(recipe, requirementFor(id))).toBe(remedy);
  });
});

describe('application probe engine', () => {
  it('reports a non-error runner failure with a generic detail and never echoes the thrown value', async () => {
    const harness = new EngineHarness('darwin');
    const runner: CommandRunner = { run: async () => { throw 'fixture non-error runner failure token=abc'; } };
    const probe = await probeRequirement(requirementFor('go'), runner, harness.options());
    expect(probe).toMatchObject({
      state: 'unhealthy', reasonCode: 'probe-failed', detail: 'The command runner could not complete the observation.',
      remedy: 'Repair Go and retry.'
    });
    expect(probe.observations).toEqual([expect.objectContaining({ status: null, errorCode: 'COMMAND_RUNNER_ERROR' })]);
    expect(JSON.stringify(probe)).not.toContain('fixture non-error');
  });

  it('keeps a compatible tool ready while reporting a timed-out health probe as unhealthy', async () => {
    const harness = new EngineHarness('darwin');
    const runner = harness.runner({
      'docker --version': 'Docker version 28.0.0, build fixture\n',
      'docker info --format {{.ServerVersion}}': { status: null, timedOut: true }
    });
    const probe = await probeRequirement(requirementFor('docker'), runner, harness.options());
    expect(probe).toMatchObject({ state: 'ready', reasonCode: 'compatible', detectedVersion: '28.0.0' });
    expect(probe.notices).toEqual([{
      label: 'Docker daemon', code: 'health', state: 'unhealthy', detail: 'Health probe timed out.',
      remedy: 'Start Docker Desktop or the Docker daemon.'
    }]);
  });

  it('never turns terminal-control-only VS Code diagnostics into an empty failure detail', async () => {
    const harness = new EngineHarness('darwin');
    const runner = harness.runner({ 'code --list-extensions': { status: 1, stderr: '\u001b[31m\u001b[0m\n' } });
    const probe = await probeRequirement(requirementFor('github-copilot'), runner, harness.options());
    expect(probe).toMatchObject({
      state: 'unhealthy', reasonCode: 'probe-failed', detail: 'VS Code extension discovery failed.',
      remedy: 'Run `code --list-extensions` and repair the VS Code CLI before retrying.'
    });
    expect(commands(harness)).toEqual(['copilot --version', 'code --list-extensions']);
  });
});

describe('application remediation engine', () => {
  it('discovers a plain Homebrew formula under the Homebrew prefix and asks for a restart, not success', async () => {
    const harness = new EngineHarness('darwin');
    const prefix = path.posix.join('/', 'opt', 'homebrew');
    const candidate = path.posix.join(prefix, 'bin', 'go');
    harness.inspections[candidate] = resolvedIdentity('go', candidate, 'brew');
    const { result } = await remediate(harness, 'go', {
      'brew --version': 'Homebrew 4.6.0\n', 'brew install go': 'installed\n', 'brew --prefix': `${prefix}\n`
    });
    expect(result).toMatchObject({
      state: 'restart-required', reasonCode: 'executable-discovery', recipe: { id: 'go:darwin:brew:install' },
      discovery: { checkedLocations: [candidate], complete: true },
      remedy: 'Run `brew --prefix`, ensure its bin directory is on PATH, open a new terminal, then retry go.'
    });
    expect(result.detail).toContain('this does not prove the installer wrote them');
    expect(commands(harness)).toEqual(['go version', 'brew --version', 'brew install go', 'go version', 'brew --prefix']);
  });

  it('checks uv through the probe engine, verifies independently and points at the uv tool directory', async () => {
    const harness = new EngineHarness('linux', 'fedora');
    const bin = path.posix.join(fixtureRoot('linux'), 'home', '.local', 'bin');
    const candidate = path.posix.join(bin, 'specify');
    harness.inspections[candidate] = resolvedIdentity('specify', candidate, 'uv');
    const install = `uv tool install specify-cli==${workstationRequirementCatalog['spec-kit'].exactVersion}`;
    const { result } = await remediate(harness, 'spec-kit', {
      'uv --version': `uv ${workstationRequirementCatalog.uv.minimumVersion}\n`, [install]: 'installed\n', 'uv tool dir --bin': `${bin}\n`
    });
    expect(result).toMatchObject({
      state: 'restart-required', reasonCode: 'executable-discovery', recipe: { id: 'spec-kit:linux:uv:install' },
      discovery: { checkedLocations: [candidate], complete: true },
      remedy: 'Run `uv tool dir --bin`, add that directory to PATH, open a new terminal, then retry specify.'
    });
    expect(commands(harness)).toEqual(['specify --version', 'uv --version', install, 'specify --version', 'uv tool dir --bin']);
  });

  // The VS Code CLI disappears during the install, so the observation changes while Copilot stays unobserved.
  const copilotCandidate = path.posix.join('/', 'opt', 'homebrew', 'bin', 'copilot');
  const copilotScript: ToolScript = {
    'code --list-extensions': ['ms-python.python\n', { status: null, errorCode: 'ENOENT', errorMessage: 'spawn code ENOENT' }],
    'brew --version': 'Homebrew 4.6.0\n',
    'brew install --cask copilot-cli': 'installed\n',
    'brew --prefix': `${path.posix.join('/', 'opt', 'homebrew')}\n`
  };
  const unresolvedCopilot = {
    state: 'unresolved', reasonCode: 'verification-unresolved', progress: 'changed',
    recipe: { id: 'github-copilot:darwin:brew:install' },
    probe: { state: 'not-observable', reasonCode: 'observation-unavailable' },
    discovery: { checkedLocations: [copilotCandidate], found: [], complete: false }
  };

  it('leaves an unobservable post-install location unresolved when the observation changed', async () => {
    const harness = new EngineHarness('darwin');
    harness.inspections[copilotCandidate] = { executable: copilotCandidate, resolution: 'not-observable', origin: 'unknown', evidence: 'unavailable' };
    const { before, result } = await remediate(harness, 'github-copilot', copilotScript);
    expect(before).toMatchObject({ state: 'missing', reasonCode: 'missing-executable' });
    expect(result).toMatchObject(unresolvedCopilot);
    expect(result.detail).toContain('Documented install locations could not be fully observed. No file changes were verified.');
    expect(inspections(harness)).toEqual([copilotCandidate]);
  });

  it('treats a failing location inspection as incomplete observation, never as absence', async () => {
    const harness = new EngineHarness('darwin');
    const executableObserver: ExecutableObserver = {
      resolve: harness.observer.resolve,
      inspect: async () => { throw new Error('fixture inspection failure'); }
    };
    const { result } = await remediate(harness, 'github-copilot', copilotScript, { executableObserver });
    expect(result).toMatchObject(unresolvedCopilot);
    expect(result.detail).not.toContain('No executable candidate was observed');
  });

  it.each([
    ['a relative', 'AppData\\Local'],
    ['a control-character', `${path.win32.join(fixtureRoot('win32'), 'home', 'AppData', 'Local')}\u0007`],
    ['an absent', undefined]
  ])('never inspects WinGet locations derived from %s LOCALAPPDATA', async (_name, localAppData) => {
    const harness = new EngineHarness('win32');
    const env = { ...harness.options().env, LOCALAPPDATA: localAppData };
    const { result } = await remediate(harness, 'node', {
      'winget --version': 'v1.11.0\n',
      'winget install --id OpenJS.NodeJS.LTS --exact --accept-package-agreements --accept-source-agreements': 'installed\n'
    }, { env });
    expect(result).toMatchObject({
      state: 'unchanged', reasonCode: 'no-progress', progress: 'unchanged',
      discovery: { checkedLocations: [], found: [], complete: false }
    });
    expect(result.probe.state).toBe('missing');
    expect(inspections(harness)).toEqual([]);
  });
});
