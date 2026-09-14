import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { nativeExecutableObserver } from '../../adapters/filesystem/executables.js';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { compareVersionCores, extractVersion, isPrereleaseVersion, matchesReleaseLine } from '../../domain/workstation/versions.js';
import { NodeCommandRunner } from '../../process-runner.js';
import { workstationRequirementCatalog, type SupportedPlatform } from '../../workstation-catalog.js';
import {
  ApplicationInspectionError, applicationWithin, assertApplicationNoLinkAncestors
} from './application-files.js';
import { createApplicationEnvironment } from './application-environment.js';
import { applicationCommandFailure } from './application-diagnostics.js';
import { applicationPreparationBounds, applicationToolRequirement } from './application-preparation-policy.js';
import type {
  ApplicationInspectionOptions, ApplicationResolvedPreparation, ApplicationToolFileIdentity,
  ApplicationToolId, ApplicationToolIdentity
} from './application-preparation-types.js';

const cachedIdentities = new Map<string, ApplicationToolFileIdentity>();
const nativeHeaders = new Set(['7f454c46', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);

async function toolFile(
  supplied: string, projectRoot: string, stagingRoot: string, binary: boolean
): Promise<ApplicationToolFileIdentity> {
  const target = await realpath(supplied);
  if ([projectRoot, stagingRoot].some((root) => applicationWithin(root, target)) || /[\u0000-\u001f\u007f]/u.test(target)) {
    throw new ApplicationInspectionError('[untrusted-tool] Installed tools must resolve outside project/staging paths, not to project PATH shims.');
  }
  const before = await lstat(target, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(applicationPreparationBounds.toolFileBytes) ||
      before.size === 0n || process.platform !== 'win32' && (before.mode & 0o002n) !== 0n) {
    throw new ApplicationInspectionError('[untrusted-tool] A resolved tool is not a bounded, non-world-writable installed regular file.');
  }
  const stamp = [
    target, binary, before.dev, before.ino, before.size, before.mode, before.mtimeNs, before.ctimeNs
  ].join(':');
  const cached = cachedIdentities.get(stamp);
  if (cached) return { ...cached };
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size ||
        opened.mtimeNs !== before.mtimeNs || opened.ctimeNs !== before.ctimeNs) {
      throw new ApplicationInspectionError('[changed-tool] Installed tool identity changed during inspection.');
    }
    const buffer = Buffer.alloc(1024 * 1024);
    const hash = createHash('sha256');
    let offset = 0;
    while (offset < Number(before.size)) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, Number(before.size) - offset), offset);
      if (!bytesRead) throw new ApplicationInspectionError('[changed-tool] Installed tool bytes changed during inspection.');
      if (offset === 0 && binary && !nativeHeaders.has(buffer.subarray(0, 4).toString('hex')) &&
          buffer.subarray(0, 2).toString('ascii') !== 'MZ') {
        throw new ApplicationInspectionError('[untrusted-tool] A runtime resolves to a script/shim rather than an identifiable installed interpreter binary.');
      }
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(target, { bigint: true });
    if ([after, current].some((item) => item.dev !== before.dev || item.ino !== before.ino || item.size !== before.size ||
        item.mode !== before.mode || item.mtimeNs !== before.mtimeNs || item.ctimeNs !== before.ctimeNs) ||
        await realpath(supplied) !== target) {
      throw new ApplicationInspectionError('[changed-tool] Installed tool bytes, mode, or resolution changed during inspection.');
    }
    const identity: ApplicationToolFileIdentity = {
      path: target, digest: hash.digest('hex'), bytes: offset, mode: Number(before.mode & 0o7777n),
      device: String(before.dev), inode: String(before.ino), modifiedNs: String(before.mtimeNs), changedNs: String(before.ctimeNs)
    };
    cachedIdentities.set(stamp, Object.freeze({ ...identity }));
    if (cachedIdentities.size > 64) cachedIdentities.delete(cachedIdentities.keys().next().value!);
    return identity;
  } finally {
    await handle.close();
  }
}

async function readNpmIdentity(file: string): Promise<{ name: string; version: string }> {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size > 64 * 1024) throw new Error('bounded package identity required');
    const bytes = Buffer.alloc(details.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== details.size) throw new Error('changed package identity');
    const value: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    if (!isRecord(value) || value.name !== 'npm' || typeof value.version !== 'string') throw new Error('npm identity required');
    return { name: value.name, version: value.version };
  } catch {
    throw new ApplicationInspectionError('[untrusted-tool] npm must resolve to an identifiable installed npm distribution and Node interpreter.');
  } finally {
    await handle.close();
  }
}

export async function resolveApplicationPreparationTools(
  projectRoot: string, stagingRoot: string, preparation: readonly ApplicationResolvedPreparation[],
  options: ApplicationInspectionOptions = {}, additionalTools: readonly ApplicationToolId[] = []
): Promise<ApplicationToolIdentity[]> {
  if (!preparation.length) return [];
  const platform = process.platform;
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
    throw new ApplicationInspectionError('[unsupported-tool-platform] Preparation tool identities cannot be observed on this platform.');
  }
  const requested = new Set([...preparation.flatMap((item) => item.tools), ...additionalTools]);
  const order: ApplicationToolId[] = ['node', 'npm', 'python', 'uv', 'go'];
  const probeRoot = path.join(path.dirname(stagingRoot), `.liftoff-preparation-probe-${randomUUID()}`);
  if (applicationWithin(projectRoot, probeRoot) || applicationWithin(stagingRoot, probeRoot)) {
    throw new ApplicationInspectionError('[unsafe-probe-scope] Tool metadata probes require a non-project, non-staging working directory.');
  }
  await assertApplicationNoLinkAncestors(path.dirname(probeRoot));
  await mkdir(probeRoot, { mode: 0o700 });
  const created = await lstat(probeRoot);
  const tools: ApplicationToolIdentity[] = [];
  let unsafeCleanup = false;
  try {
    const env = await createApplicationEnvironment(options.env ?? process.env, projectRoot, stagingRoot, probeRoot);
    const runner = options.runner ?? new NodeCommandRunner();
    for (const id of order.filter((item) => requested.has(item))) {
      const definition = workstationRequirementCatalog[id];
      const names = id === 'python' ? ['python3', 'python'] : [id];
      let launcher: { path: string; realPath: string } | undefined;
      for (const executable of names) {
        const observed = await nativeExecutableObserver.resolve(executable, {
          platform: platform as SupportedPlatform, cwd: probeRoot, env, definition
        });
        if (observed.resolution !== 'resolved') continue;
        if ([projectRoot, stagingRoot].some((root) => applicationWithin(root, observed.realPath!) ||
            applicationWithin(root, path.resolve(observed.resolvedPath!)))) {
          throw new ApplicationInspectionError(`[untrusted-tool] ${id} resolves through project/staging executable scope.`);
        }
        launcher = { path: observed.resolvedPath!, realPath: observed.realPath! };
        break;
      }
      if (!launcher) {
        throw new ApplicationInspectionError(`[missing-tool] Compatible installed ${id} is required for this preparation provider. Prepare that tool separately; repair does not install it.`);
      }
      let executablePath = launcher.realPath;
      const prefixArgs: string[] = [];
      const files: ApplicationToolFileIdentity[] = [];
      let declaredNpmVersion: string | undefined;
      if (id === 'npm') {
        const node = tools.find((item) => item.id === 'node');
        if (!node) throw new ApplicationInspectionError('[missing-tool] npm preparation requires an independently resolved Node interpreter.');
        const cli = path.basename(launcher.realPath) === 'npm-cli.js'
          ? launcher.realPath
          : path.join(path.dirname(launcher.realPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
        const cliIdentity = await toolFile(cli, projectRoot, stagingRoot, false);
        if (path.basename(path.dirname(cliIdentity.path)) !== 'bin' ||
            path.basename(path.dirname(path.dirname(cliIdentity.path))) !== 'npm') {
          throw new ApplicationInspectionError('[untrusted-tool] npm does not resolve to its registered installed JavaScript launcher.');
        }
        const packagePath = path.join(path.dirname(path.dirname(cliIdentity.path)), 'package.json');
        const packageIdentity = await toolFile(packagePath, projectRoot, stagingRoot, false);
        declaredNpmVersion = (await readNpmIdentity(packageIdentity.path)).version;
        files.push(await toolFile(launcher.path, projectRoot, stagingRoot, false), cliIdentity, packageIdentity,
          ...node.files);
        executablePath = node.executablePath;
        prefixArgs.push(cliIdentity.path);
      } else {
        files.push(await toolFile(launcher.path, projectRoot, stagingRoot, true));
        executablePath = files[0]!.path;
      }
      const probe = {
        executable: executablePath,
        args: [...prefixArgs, ...(id === 'go' ? ['version'] : id === 'python' ? ['-I', '-S', '--version'] : ['--version'])]
      };
      const actual = await runner.run(probe, {
        cwd: probeRoot, env, timeoutMs: applicationPreparationBounds.probeTimeoutMs,
        maxOutputBytes: applicationPreparationBounds.probeOutputBytes, stream: false
      });
      const diagnostic = applicationCommandFailure({
        executable: id, args: probe.args, cwdPathParts: [], network: false,
        timeoutMs: applicationPreparationBounds.probeTimeoutMs, maxOutputBytes: applicationPreparationBounds.probeOutputBytes
      }, actual);
      if (diagnostic) {
        unsafeCleanup ||= diagnostic.cleanupUnsafe;
        throw new ApplicationInspectionError(`[tool-probe-${diagnostic.kind}] Installed ${id} metadata could not be confirmed. ${diagnostic.message}`);
      }
      const version = extractVersion(`${actual.stdout}\n${actual.stderr}`, id);
      const requirement = applicationToolRequirement(id);
      if (!version || !/^\d+\.\d+\.\d+$/u.test(version) || !matchesReleaseLine(version, requirement.releaseLine) ||
          compareVersionCores(version, requirement.minimumVersion) < 0 ||
          !requirement.allowPrerelease && isPrereleaseVersion(version) ||
          id === 'npm' && version !== declaredNpmVersion) {
        throw new ApplicationInspectionError(`[incompatible-tool] Installed ${id} must satisfy ${requirement.minimumVersion}+ on release line ${requirement.releaseLine}; its resolved file identity and version must agree. Prepare a compatible tool separately.`);
      }
      const uniqueFiles = [...new Map(files.map((item) => [item.path, item])).values()];
      for (const file of uniqueFiles) {
        const checked = await toolFile(file.path, projectRoot, stagingRoot, id !== 'npm');
        if (canonicalSha256(checked) !== canonicalSha256(file)) throw new ApplicationInspectionError('[changed-tool] Installed tool identity changed during its probe.');
      }
      if (await realpath(launcher.path) !== files[0]?.path) {
        throw new ApplicationInspectionError('[changed-tool] Installed launcher resolution changed during its probe.');
      }
      const body = { schemaVersion: 1 as const, id, launcherPath: launcher.path, executablePath, prefixArgs, version, requirement, files: uniqueFiles, probe };
      tools.push({ ...body, digest: canonicalSha256(body) });
    }
    return tools;
  } catch (error) {
    if (error instanceof ApplicationInspectionError) throw error;
    throw new ApplicationInspectionError('[tool-inspection] Installed tool files could not be safely inspected or probed; no preparation was performed.');
  } finally {
    if (unsafeCleanup) {
      throw new ApplicationInspectionError(`[tool-probe-cleanup] Tool probe termination is uncertain; probe workspace was retained at ${probeRoot}. No preparation or project checks were authorized.`);
    }
    const current = await lstat(probeRoot);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== created.dev || current.ino !== created.ino) {
      throw new ApplicationInspectionError('[tool-probe-cleanup] Probe workspace identity changed; cleanup was refused.');
    }
    await rm(probeRoot, { recursive: true, force: true });
  }
}

export async function assertApplicationToolsCurrent(
  projectRoot: string, stagingRoot: string, tools: readonly ApplicationToolIdentity[]
): Promise<void> {
  for (const tool of tools) {
    if (await realpath(tool.launcherPath) !== tool.files[0]?.path) {
      throw new ApplicationInspectionError('[changed-tool] Approved launcher resolution changed before effects.');
    }
    for (const file of tool.files) {
      const current = await toolFile(file.path, projectRoot, stagingRoot, false);
      if (canonicalSha256(current) !== canonicalSha256(file)) {
        throw new ApplicationInspectionError('[changed-tool] Approved executable/interpreter bytes, identity, or mode changed before effects.');
      }
    }
  }
}
