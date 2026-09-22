import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { canonicalWorkspaceBoundary, repairWorkspaceDirectory, repairWorkspaceLocation } from '../../src/adapters/filesystem/repair-workspaces.js';
import { windowsNativeCwdUnits } from '../../src/adapters/process/windows-native-cwd.js';
import { applicationCommandFailure } from '../../src/application/repair/application-diagnostics.js';
import { applicationPreparationBounds, applicationToolRequirement } from '../../src/application/repair/application-preparation-policy.js';
import { applicationVerificationCwdParts } from '../../src/application/repair/application-verification.js';
import { isRecord } from '../../src/domain/governance/activation/canonical-json.js';
import { compareVersionCores, extractVersion, isPrereleaseVersion, matchesReleaseLine } from '../../src/domain/workstation/versions.js';
import { NodeCommandRunner, type CommandResult, type CommandRunner } from '../../src/process-runner.js';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const numericVersion = (value: unknown) => typeof value === 'string' && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value) ? value : null;
class ObservationError extends Error {
  constructor(readonly code: 'file-shape' | 'file-bound' | 'file-identity' | 'declaration-shape') { super(code); }
}

async function observeFile(file: string, declaration = false) {
  const canonical = await realpath(file), before = await lstat(canonical, { bigint: true });
  if (canonical !== file || !before.isFile() || before.isSymbolicLink()) throw new ObservationError('file-shape');
  const bound = declaration ? 64 * 1024 : applicationPreparationBounds.toolFileBytes;
  if (before.size < 1n || before.size > BigInt(bound)) throw new ObservationError('file-bound');
  const handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  const buffer = Buffer.alloc(64 * 1024), contents = declaration ? Buffer.alloc(Number(before.size)) : undefined;
  const fields = ['dev', 'ino', 'size', 'mode', 'uid', 'mtimeNs', 'ctimeNs'] as const;
  try {
    const opened = await handle.stat({ bigint: true });
    if (fields.some(field => opened[field] !== before[field])) throw new ObservationError('file-identity');
    const hash = createHash('sha256');
    let offset = 0;
    while (offset < Number(before.size)) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, Number(before.size) - offset), offset);
      if (!bytesRead) throw new ObservationError('file-identity');
      hash.update(buffer.subarray(0, bytesRead));
      contents?.set(buffer.subarray(0, bytesRead), offset);
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true }), named = await lstat(canonical, { bigint: true });
    if (named.isSymbolicLink() || [after, named].some(item => fields.some(field => item[field] !== before[field])) ||
        await realpath(file) !== canonical) throw new ObservationError('file-identity');
    let declaredVersion: string | null = null;
    if (contents) {
      let value: unknown;
      try { value = JSON.parse(contents.toString('utf8')); }
      catch { throw new ObservationError('declaration-shape'); }
      if (!isRecord(value) || value.name !== 'npm' || typeof value.version !== 'string' || value.version.length > 128) {
        throw new ObservationError('declaration-shape');
      }
      declaredVersion = value.version;
    }
    return {
      identity: { pathDigest: digest(canonical), contentDigest: hash.digest('hex'), bytes: offset,
        metadataDigest: digest(fields.map(field => String(before[field])).join(':')) },
      declaredVersion
    };
  } finally {
    buffer.fill(0); contents?.fill(0);
    await handle.close();
  }
}

async function observeFiles(executable: string, cli?: string) {
  let phase: 'binary' | 'launcher' | 'declaration' = 'binary';
  try {
    const binary = await observeFile(executable);
    phase = 'launcher';
    const launcher = cli ? await observeFile(cli) : undefined;
    phase = 'declaration';
    const declaration = cli ? await observeFile(path.join(path.dirname(path.dirname(cli)), 'package.json'), true) : undefined;
    return {
      status: 'observed' as const, binary: binary.identity, launcher: launcher?.identity ?? null,
      declaration: declaration?.identity ?? null, declaredVersion: declaration?.declaredVersion ?? null
    };
  } catch (error) {
    return { status: 'unavailable' as const, phase,
      code: error instanceof ObservationError ? error.code : 'file-read-unavailable' };
  }
}

export function frameworkVersionObservation(tool: 'node' | 'npm', result: CommandResult, declaredVersion: string | null) {
  const parsed = extractVersion(`${result.stdout}\n${result.stderr}`, tool), requirement = applicationToolRequirement(tool);
  const failure = applicationCommandFailure({
    executable: tool, args: ['--version'], cwdPathParts: [], network: false,
    timeoutMs: applicationPreparationBounds.probeTimeoutMs, maxOutputBytes: applicationPreparationBounds.probeOutputBytes
  }, result);
  const predicates: string[] = [];
  if (failure) predicates.push('command-result-unsuccessful');
  else {
    if (!parsed) predicates.push('version-unrecognized');
    else {
      if (!/^\d+\.\d+\.\d+$/.test(parsed)) predicates.push('version-not-stable-three-part');
      if (!matchesReleaseLine(parsed, requirement.releaseLine)) predicates.push('release-line-mismatch');
      if (compareVersionCores(parsed, requirement.minimumVersion) < 0) predicates.push('below-minimum');
      if (!requirement.allowPrerelease && isPrereleaseVersion(parsed)) predicates.push('prerelease-forbidden');
    }
    if (tool === 'npm') {
      if (declaredVersion === null) predicates.push('declaration-unobserved');
      else if (parsed !== undefined && parsed !== declaredVersion) predicates.push('declaration-version-mismatch');
    }
  }
  return {
    status: Number.isSafeInteger(result.status) ? result.status : null, timedOut: result.timedOut,
    spawned: result.processSpawned ?? null, treeSettled: result.processTreeSettled ?? null,
    commandFailureKind: failure?.kind ?? null, parsedVersionRecognized: parsed !== undefined,
    parsedNumericVersion: numericVersion(parsed), declaredNumericVersion: numericVersion(declaredVersion),
    parsedVersionDigest: parsed ? digest(parsed) : null,
    declarationVersionDigest: declaredVersion === null ? null : digest(declaredVersion),
    predicates
  };
}

export function frameworkProbeRecorder(inner: CommandRunner = new NodeCommandRunner()) {
  const observations: object[] = [];
  let truncated = false, admitted = 0;
  const runner: CommandRunner = {
    async run(command, options) {
      const cli = command.args.length === 2 && typeof command.args[0] === 'string' &&
        path.isAbsolute(command.args[0]) && path.basename(command.args[0]) === 'npm-cli.js' ? command.args[0] : undefined;
      const registered = path.isAbsolute(command.executable) && command.args.at(-1) === '--version' &&
        (command.args.length === 1 || cli !== undefined);
      if (!registered) return inner.run(command, options);
      if (admitted >= 4) { truncated = true; return inner.run(command, options); }
      admitted++;
      const before = await observeFiles(command.executable, cli);
      let result: CommandResult;
      try { result = await inner.run(command, options); }
      catch (error) {
        observations.push({ tool: cli ? 'npm' : 'node', status: 'runner-threw', resultUnchanged: true });
        throw error;
      }
      const after = await observeFiles(command.executable, cli);
      const publicFiles = (value: Awaited<ReturnType<typeof observeFiles>>) => value.status === 'observed'
        ? { status: value.status, binary: value.binary, launcher: value.launcher, declaration: value.declaration }
        : value;
      observations.push({
        tool: cli ? 'npm' : 'node', before: publicFiles(before), after: publicFiles(after),
        filesStable: before.status === 'observed' && after.status === 'observed' &&
          JSON.stringify(publicFiles(before)) === JSON.stringify(publicFiles(after)),
        cwdUnits: options?.cwd?.length ?? null,
        cwdNativeUnits: process.platform === 'win32' && options?.cwd ? windowsNativeCwdUnits(options.cwd) : null,
        timeoutMs: options?.timeoutMs ?? null, maxOutputBytes: options?.maxOutputBytes ?? null,
        result: frameworkVersionObservation(cli ? 'npm' : 'node', result,
          before.status === 'observed' ? before.declaredVersion : null),
        resultUnchanged: true
      });
      return result;
    }
  };
  return { runner, snapshot: () => ({ observations: structuredClone(observations), truncated, additionalCommands: 0 }) };
}

export function frameworkFixtureStorage(projectRoot: string, home: string) {
  return { homedir: home, repositoryRoot: projectRoot, env: process.platform === 'win32' ? { LOCALAPPDATA: home } : {} };
}

export function frameworkCwdGeometry(root: string, policy: Parameters<typeof applicationVerificationCwdParts>[0]) {
  const directory = path.win32.join(root, '0'.repeat(64)), project = path.win32.join(directory, 'project');
  const declared = applicationVerificationCwdParts(policy);
  if (declared.length > 62) throw new Error('Fixture cwd metadata exceeds its bounded inventory.');
  const rows = [
    { role: 'project', depth: 0, cwd: project }, { role: 'home', depth: 0, cwd: path.win32.join(directory, 'home') },
    ...declared.map(parts => ({ role: 'declared-command', depth: parts.length, cwd: path.win32.join(project, ...parts) }))
  ];
  return rows.map(({ role, depth, cwd }, index) => ({
    index, role, depth, length: cwd.length, nativeUnits: windowsNativeCwdUnits(cwd),
    withinNativeLimit: windowsNativeCwdUnits(cwd) <= 260
  }));
}

export async function frameworkStorageObservation(
  fixture: { parent: string; root: string; home: string }, policy: Parameters<typeof applicationVerificationCwdParts>[0]
) {
  let phase = 'parent-canonical';
  try {
    await canonicalWorkspaceBoundary(fixture.parent);
    phase = 'selected-base-canonical';
    await canonicalWorkspaceBoundary(fixture.home);
    phase = 'fixture-containment';
    const relative = path.relative(fixture.parent, fixture.home);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return { status: 'unavailable', code: 'selected-base-outside-fixture', newWorkspaceAllocated: false };
    }
    const storage = frameworkFixtureStorage(fixture.root, fixture.home);
    phase = 'location-read';
    const location = await repairWorkspaceLocation(fixture.root, storage);
    const full = repairWorkspaceDirectory(location, '0'.repeat(64));
    phase = 'cwd-bindings';
    return {
      status: 'observed', canonicalFixtureParentUnits: fixture.parent.length, canonicalSelectedBaseUnits: fixture.home.length,
      selectedBaseDigest: digest(fixture.home), plannedWorkspaceDigest: digest(full),
      declaredChecks: policy.commands.length, resolvedChecks: policy.executionCommands?.length ?? 0,
      preparationScopes: policy.preparation?.length ?? 0,
      preparationCommands: policy.preparation?.reduce((count, item) => count + item.commands.length, 0) ?? 0,
      geometry: frameworkCwdGeometry(location.root, policy), newWorkspaceAllocated: false
    };
  } catch {
    return { status: 'unavailable', phase, code: 'canonical-base-or-cwd-bindings-unqualified', newWorkspaceAllocated: false };
  }
}
