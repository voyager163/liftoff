import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHomebrewCaskPreparation } from '../src/adapters/distribution/native-cask-plan.js';
import type { NativeStableSource } from '../src/adapters/distribution/native-metadata.js';
import { upgradeWorld } from './fixtures/installer-upgrade.js';
import { signedMaterial } from './fixtures/native-stable-material.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function preparationWorld() {
  const fixture = upgradeWorld({ layout: 'homebrew-opt' });
  const signed = signedMaterial('darwin-arm64');
  const prefix = '/opt/homebrew';
  const caskRoot = `${prefix}/Caskroom/liftoff`;
  const definition = `${prefix}/Library/Taps/fixture/homebrew-tools/Casks/liftoff.rb`;
  const files = new Map([[definition, Buffer.from('# Unverified local fixture bytes. Must never be evaluated.\n')]]);
  for (const directory of [`${prefix}/Caskroom`, path.posix.dirname(definition)]) {
    let current = directory;
    while (current !== '/') {
      fixture.world.nodes.set(current, { kind: 'directory' });
      current = path.posix.dirname(current);
    }
  }
  fixture.world.nodes.set(definition, { kind: 'file' });
  const readBytes = vi.fn(async (filename: string, _maximum: number) => {
    const bytes = files.get(filename);
    if (!bytes) throw Object.assign(new Error('Missing fixture source'), { code: 'ENOENT' });
    return bytes;
  });
  const lstat = vi.fn(fixture.dependencies.lstat);
  const dependencies = { ...fixture.dependencies, architecture: 'arm64', lstat, readBytes };
  const readStable = vi.fn<NativeStableSource['readStable']>(async () => signed.material);
  const controller = new AbortController();
  const port = () => createHomebrewCaskPreparation(dependencies, signed.policy, { readStable });
  return { ...fixture, ...signed, dependencies, readStable, lstat, readBytes, files, definition, prefix, caskRoot, controller, port };
}

describe('canonical absent-cask preparation without manager effect authority', () => {
  it('authenticates a target without inventing an installed owner and keeps source bytes, presence and execution authority separate', async () => {
    const fixture = preparationWorld();
    const port = fixture.port();
    const preview = await port.preview(fixture.prefix, fixture.controller.signal);
    expect(preview).toMatchObject({
      schemaVersion: 1, kind: 'liftoff-homebrew-cask-install-preview', effects: 'none',
      cask: 'fixture/tools/liftoff', expectedSourceRepository: 'fixture/homebrew-tools',
      target: { target: 'darwin-arm64', version: '0.13.0', sourceCommit: 'd'.repeat(40) },
      destination: { caskRoot: fixture.caskRoot, launcher: '/opt/homebrew/bin/liftoff',
        versionRoot: `${fixture.caskRoot}/0.13.0`, stagedLauncher: `${fixture.caskRoot}/0.13.0/bin/liftoff`,
        cask: { state: 'absent' }, selectedLauncher: { state: 'occupied' } },
      source: { state: 'observed', path: fixture.definition, authority: 'unverified-local-bytes',
        bytes: fixture.files.get(fixture.definition)!.length, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      channel: { status: 'unknown' },
      preflight: { nativeAppleSilicon: true, canonicalDirectories: true, caskAbsent: true,
        launcherAbsent: false, exactExecutionProven: false },
      execution: { status: 'blocked', reason: 'exact_cask_execution_unproven', command: null },
      identity: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(preview.target).not.toHaveProperty('bundleRoot');
    expect(preview.target).not.toHaveProperty('owner');
    expect(fixture.readStable.mock.calls[0][0]).toEqual({ target: 'darwin-arm64' });
    expect(fixture.readStable.mock.calls[0][1].aborted).toBe(true);
    expect(port).not.toHaveProperty('install');
    expect(port).not.toHaveProperty('installExact');
    expect(port).not.toHaveProperty('uninstall');
    expect(fixture.world.trace.filter(event => 'run' in event || 'installCommand' in event || 'neutral' in event)).toEqual([]);
  });

  it('observes occupied cask paths without claiming installed inventory or absence', async () => {
    const fixture = preparationWorld();
    fixture.world.nodes.set(fixture.caskRoot, { kind: 'directory' });
    const observation = await fixture.port().observeDestination(fixture.prefix, fixture.controller.signal);
    expect(observation.cask.state).toBe('occupied');
    expect(observation).not.toHaveProperty('installation');
    expect(fixture.readStable).not.toHaveBeenCalled();
    const preview = await fixture.port().preview(fixture.prefix, fixture.controller.signal);
    expect(preview.preflight.caskAbsent).toBe(false);
    expect(preview.execution.command).toBeNull();
  });

  it.each(['namespace', 'signer', 'team'] as const)('refuses missing %s approval before filesystem or release reads', async kind => {
    const fixture = preparationWorld();
    if (kind === 'namespace') fixture.policy.homebrew.cask = null;
    if (kind === 'signer') fixture.policy.approvedSigningKeySha256 = null;
    if (kind === 'team') fixture.policy.homebrew.developerTeamId = null;
    await expect(fixture.port().preview(fixture.prefix, fixture.controller.signal))
      .rejects.toMatchObject({ reasonCode: 'native_unqualified' });
    expect(fixture.lstat).not.toHaveBeenCalled();
    expect(fixture.readStable).not.toHaveBeenCalled();
  });

  it.each(['/foreign', '/opt/homebrew/', '/opt/homebrew/../homebrew', 'relative'])('rejects noncanonical prefix %s', async prefix => {
    const fixture = preparationWorld();
    await expect(fixture.port().preview(prefix, fixture.controller.signal))
      .rejects.toMatchObject({ reasonCode: 'unsupported_installation' });
    expect(fixture.lstat).not.toHaveBeenCalled();
  });

  it.each(['linux', 'x64'] as const)('rejects unsupported %s host inputs', async kind => {
    const fixture = preparationWorld();
    if (kind === 'linux') fixture.dependencies.platform = 'linux';
    else fixture.dependencies.architecture = 'x64';
    await expect(fixture.port().preview(fixture.prefix, fixture.controller.signal))
      .rejects.toMatchObject({ reasonCode: 'unsupported_installation' });
    expect(fixture.readStable).not.toHaveBeenCalled();
  });

  it('does not turn a missing local definition into absent package-channel authority', async () => {
    const fixture = preparationWorld();
    fixture.world.nodes.delete(fixture.definition);
    const preview = await fixture.port().preview(fixture.prefix, fixture.controller.signal);
    expect(preview.source).toEqual({ state: 'absent' });
    expect(preview.channel).toEqual({ status: 'unknown' });
    expect(preview.execution.status).toBe('blocked');
  });

  it('observes the alternate canonical first-letter layout without evaluating it', async () => {
    const fixture = preparationWorld();
    const nested = fixture.definition.replace('/Casks/', '/Casks/l/');
    fixture.world.nodes.delete(fixture.definition);
    fixture.world.nodes.set(path.posix.dirname(nested), { kind: 'directory' });
    fixture.world.nodes.set(nested, { kind: 'file' });
    fixture.files.set(nested, fixture.files.get(fixture.definition)!);
    const preview = await fixture.port().preview(fixture.prefix, fixture.controller.signal);
    expect(preview.source).toMatchObject({ state: 'observed', path: nested, authority: 'unverified-local-bytes' });
  });

  it('rejects ambiguous source layouts', async () => {
    const fixture = preparationWorld();
    const nested = fixture.definition.replace('/Casks/', '/Casks/l/');
    fixture.world.nodes.set(path.posix.dirname(nested), { kind: 'directory' });
    fixture.world.nodes.set(nested, { kind: 'file' });
    fixture.files.set(nested, fixture.files.get(fixture.definition)!);
    await expect(fixture.port().preview(fixture.prefix, fixture.controller.signal))
      .rejects.toMatchObject({ reasonCode: 'unsupported_installation' });
  });

  it.each(['definition', 'directory'] as const)('rejects symlinked %s source scope', async kind => {
    const fixture = preparationWorld();
    fixture.world.nodes.set(kind === 'definition' ? fixture.definition : path.posix.dirname(fixture.definition),
      { kind: 'symlink', target: '/foreign' });
    await expect(fixture.port().preview(fixture.prefix, fixture.controller.signal))
      .rejects.toMatchObject({ reasonCode: 'unsupported_installation' });
  });

  it.each([0, 256 * 1024 + 1])('rejects %i-byte source definitions', async length => {
    const fixture = preparationWorld();
    fixture.files.set(fixture.definition, Buffer.alloc(length));
    await expect(fixture.port().preview(fixture.prefix, fixture.controller.signal))
      .rejects.toMatchObject({ reasonCode: length ? 'unsupported_installation' : 'native_invalid' });
  });

  it('reports denied source reads rather than treating them as missing', async () => {
    const fixture = preparationWorld();
    fixture.readBytes.mockRejectedValue(Object.assign(new Error('Fixture denied read'), { code: 'EACCES' }));
    await expect(fixture.port().preview(fixture.prefix, fixture.controller.signal))
      .rejects.toMatchObject({ reasonCode: 'native_unavailable' });
  });

  it('rechecks cask absence after release/source preparation', async () => {
    const fixture = preparationWorld();
    fixture.readStable.mockImplementation(async () => {
      fixture.world.nodes.set(fixture.caskRoot, { kind: 'directory' });
      return fixture.material;
    });
    await expect(fixture.port().preview(fixture.prefix, fixture.controller.signal))
      .rejects.toMatchObject({ reasonCode: 'owner_changed' });
  });

  it('rechecks source bytes before returning the preview', async () => {
    const fixture = preparationWorld();
    fixture.readBytes.mockImplementation(async () => {
      const bytes = fixture.files.get(fixture.definition)!;
      fixture.files.set(fixture.definition, Buffer.concat([bytes, Buffer.from('changed')]));
      return bytes;
    });
    await expect(fixture.port().preview(fixture.prefix, fixture.controller.signal))
      .rejects.toMatchObject({ reasonCode: 'owner_changed' });
  });

  it('rejects changed signature material before reading any cask definition', async () => {
    const fixture = preparationWorld();
    fixture.material.signature[0] ^= 1;
    await expect(fixture.port().preview(fixture.prefix, fixture.controller.signal))
      .rejects.toMatchObject({ reasonCode: 'native_invalid' });
    expect(fixture.readBytes).not.toHaveBeenCalled();
  });

  it('honors external cancellation without filesystem reads', async () => {
    const fixture = preparationWorld();
    fixture.controller.abort();
    await expect(fixture.port().observeDestination(fixture.prefix, fixture.controller.signal))
      .rejects.toMatchObject({ reasonCode: 'native_unavailable' });
    expect(fixture.lstat).not.toHaveBeenCalled();
  });

  it('bounds a noncooperative filesystem probe', async () => {
    vi.useFakeTimers();
    const fixture = preparationWorld();
    const dependencies = { ...fixture.dependencies, probeTimeoutMs: 10 };
    dependencies.lstat.mockImplementation(() => new Promise(() => {}));
    const port = createHomebrewCaskPreparation(dependencies, fixture.policy, { readStable: fixture.readStable });
    const result = expect(port.observeDestination(fixture.prefix, fixture.controller.signal))
      .rejects.toMatchObject({ reasonCode: 'native_timeout' });
    await vi.advanceTimersByTimeAsync(10);
    await result;
  });

  it.each([0, -1, 1.5, Infinity, 2_147_483_648])('rejects invalid probe deadline %s before reading', async probeTimeoutMs => {
    const fixture = preparationWorld();
    const port = createHomebrewCaskPreparation({ ...fixture.dependencies, probeTimeoutMs }, fixture.policy);
    await expect(port.observeDestination(fixture.prefix, fixture.controller.signal)).rejects.toMatchObject({ reasonCode: 'native_invalid' });
    expect(fixture.lstat).not.toHaveBeenCalled();
  });

  it('refuses a late observation even if synchronous work delays the timer', async () => {
    const fixture = preparationWorld();
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(30001);
    await expect(fixture.port().observeDestination(fixture.prefix, fixture.controller.signal))
      .rejects.toMatchObject({ reasonCode: 'native_timeout' });
  });
});
