import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import path from 'node:path';
import { readBoundProjectFileDigest, readBoundProjectFileSnapshot } from '../../adapters/filesystem/bound-project-files.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { localInputFailure, rawLocalDigest } from '../../domain/governance/activation/modern-local-inputs.js';
import {
  manualInfrastructureEnvironment, manualInfrastructureOutputPaths, manualInfrastructurePolicy,
  validateManualInfrastructureInputs, validateManualInfrastructureOutput,
  type ManualInfrastructureInputs, type ManualInfrastructureOutput, type ManualInfrastructureOutputEntry
} from '../../domain/governance/activation/modern-manual-infrastructure.js';
import { ApplicationFiles, assertApplicationNoLinkAncestors } from '../repair/application-files.js';

const physical = (stat: BigIntStats) => [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.uid, stat.gid,
  stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':');
const ownedDirectory = (stat: BigIntStats) => stat.isDirectory() && !stat.isSymbolicLink() &&
  stat.uid === BigInt(process.getuid!()) && (stat.mode & 0o7022n) === 0n;
const directoryIdentity = (stat: BigIntStats) => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.birthtimeNs].join(':');

/** Allocates only owned configuration/data; callers must independently authorize preparation and network. */
export async function createManualInfrastructureEnvironment(workspace: string, input: ManualInfrastructureInputs) {
  const initialization = validateManualInfrastructureInputs(input);
  if (process.platform !== manualInfrastructurePolicy.qualifiedPlatform ||
      process.arch !== manualInfrastructurePolicy.qualifiedArchitecture || typeof process.getuid !== 'function') {
    localInputFailure('Locked Manual provider preparation is unavailable on this unqualified native host.');
  }
  manualInfrastructureEnvironment(workspace, initialization, initialization.roots[0]!.component);
  await assertApplicationNoLinkAncestors(workspace);
  const cache = path.join(workspace, 'cache'), scratch = path.join(workspace, 'scratch');
  const cacheStat = await lstat(cache, { bigint: true }), scratchStat = await lstat(scratch, { bigint: true });
  if (!ownedDirectory(cacheStat) || !ownedDirectory(scratchStat)) localInputFailure('Manual preparation needs existing owned cache and scratch roles.');
  const cacheIdentity = directoryIdentity(cacheStat), scratchIdentity = directoryIdentity(scratchStat);
  const base = path.join(cache, 'manual-init');
  await mkdir(base, { mode: 0o700 });
  const configuration = `provider_installation {\n  direct {\n    include = ["${manualInfrastructurePolicy.providerSource}"]\n  }\n}\n`;
  const configParts = ['cache', 'manual-init', 'tofu.rc'];
  await writeFile(path.join(workspace, ...configParts), configuration, { flag: 'wx', mode: 0o600 });
  const configPhysical = physical(await lstat(path.join(workspace, ...configParts), { bigint: true }));
  const baseIdentity = directoryIdentity(await lstat(base, { bigint: true }));
  const roots = new Map<string, string>();
  for (const root of initialization.roots) {
    const target = path.join(workspace, ...root.dataPathParts);
    await mkdir(target, { mode: 0o700 });
    roots.set(root.component, directoryIdentity(await lstat(target, { bigint: true })));
  }
  const expectedMembers = ['tofu.rc', ...initialization.roots.map(root => root.dataPathParts.at(-1)!)].sort();
  const diagnostics = { pathLabel: 'Owned Manual initialization output', invalid: localInputFailure };

  async function assertControls(): Promise<void> {
    await assertApplicationNoLinkAncestors(base);
    for (const [target, expected] of [[cache, cacheIdentity], [scratch, scratchIdentity], [base, baseIdentity]]) {
      const observed = await lstat(target, { bigint: true });
      if (!ownedDirectory(observed) || directoryIdentity(observed) !== expected) {
        localInputFailure('Manual initialization configuration or workspace role identity changed.');
      }
    }
    if (canonicalSha256((await readdir(base)).sort()) !== canonicalSha256(expectedMembers)) {
      localInputFailure('Manual initialization controls contain unexpected or missing entries.');
    }
    const config = await readBoundProjectFileSnapshot(workspace, configParts, { maximumBytes: 8192, linkPolicy: 'single-link', diagnostics });
    if (!config.content?.equals(Buffer.from(configuration)) || config.mode !== 0o600 ||
        physical(await lstat(path.join(workspace, ...configParts), { bigint: true })) !== configPhysical) {
      localInputFailure('Manual initialization CLI configuration changed.');
    }
    for (const root of initialization.roots) {
      const observed = await lstat(path.join(workspace, ...root.dataPathParts), { bigint: true });
      if (!ownedDirectory(observed) || (observed.mode & 0o7777n) !== 0o700n ||
          directoryIdentity(observed) !== roots.get(root.component)) localInputFailure('Manual initialization output root changed.');
    }
  }
  function selected(component: string) {
    const root = initialization.roots.find(root => root.component === component);
    if (!root) localInputFailure('Manual initialization has no approved component.');
    return root;
  }
  async function assertFresh(component: string): Promise<void> {
    await assertControls();
    if ((await readdir(path.join(workspace, ...selected(component).dataPathParts))).length) {
      localInputFailure('Manual initialization requires its fresh empty output root.');
    }
  }
  function environment(component: string) {
    return manualInfrastructureEnvironment(workspace, initialization, component);
  }
  async function capture(component: string, sourceDigest: string, toolDigest: string): Promise<ManualInfrastructureOutput> {
    await assertControls();
    const root = selected(component), dataRoot = path.join(workspace, ...root.dataPathParts);
    const reader = new ApplicationFiles(dataRoot), expected = manualInfrastructureOutputPaths();
    const entries: ManualInfrastructureOutputEntry[] = [];
    let total = 0, files = 0;
    async function walk(parts: string[]): Promise<void> {
      if (parts.length > manualInfrastructurePolicy.outputDepth ||
          reader.directoryInventory.length >= manualInfrastructurePolicy.outputDirectories) {
        localInputFailure('Manual initialization output directory bound exceeded.');
      }
      const directory = await reader.inventory(parts);
      if (!directory.exists || expected.get(parts.join('/')) !== 'directory') localInputFailure('Unrecognized Manual output directory.');
      const stat = await lstat(path.join(dataRoot, ...parts), { bigint: true });
      if (!ownedDirectory(stat)) localInputFailure('Manual output directory ownership or mode changed.');
      entries.push({ pathParts: [...parts], kind: 'directory', mode: Number(stat.mode & 0o7777n),
        bytes: 0, digest: null, physical: physical(stat) });
      for (const member of directory.entries) {
        const next = [...parts, member.name], name = next.join('/');
        if (expected.get(name) !== member.kind) localInputFailure('Manual initialization produced an unapproved file, link or special entry.');
        if (member.kind === 'directory') { await walk(next); continue; }
        if (++files > manualInfrastructurePolicy.outputFiles) localInputFailure('Manual output file bound exceeded.');
        const before = await lstat(path.join(dataRoot, ...next), { bigint: true });
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
            before.uid !== BigInt(process.getuid!()) || (before.mode & 0o7022n) !== 0n ||
            before.size > BigInt(manualInfrastructurePolicy.outputBytes - total)) {
          localInputFailure('Manual output file is unowned, unsafe or exceeds the remaining byte bound.');
        }
        const file = await readBoundProjectFileDigest(dataRoot, next, {
          maximumBytes: Math.max(1, Math.min(manualInfrastructurePolicy.outputFileBytes, manualInfrastructurePolicy.outputBytes - total)),
          linkPolicy: 'single-link', diagnostics
        });
        total += file.bytes;
        if (file.physical !== physical(before) || total > manualInfrastructurePolicy.outputBytes) {
          localInputFailure('Manual output file changed after its owned bounded metadata observation.');
        }
        if (member.name === manualInfrastructurePolicy.providerBinary && file.header !== 'cffaedfe0c000001') {
          localInputFailure('The locked provider output is not the qualified native arm64 executable format.');
        }
        entries.push({ pathParts: next, kind: 'file', mode: file.mode, bytes: file.bytes, digest: file.digest, physical: file.physical });
      }
    }
    await walk([]);
    const index = await readBoundProjectFileSnapshot(dataRoot, ['modules', 'modules.json'], {
      maximumBytes: manualInfrastructurePolicy.moduleIndexBytes, linkPolicy: 'single-link', diagnostics
    });
    if (!index.content || rawLocalDigest(index.content) !== entries.find(entry => entry.pathParts.join('/') === 'modules/modules.json')?.digest) {
      localInputFailure('Manual module index changed during output capture.');
    }
    let modules: unknown;
    try { modules = JSON.parse(index.content.toString('utf8')); }
    catch { localInputFailure('Manual module index is not bounded valid JSON.'); }
    if (canonicalSha256(modules) !== canonicalSha256({ Modules: [
      { Key: '', Source: '', Dir: '.' },
      { Key: root.module.key, Source: root.module.source, Dir: path.posix.normalize(root.module.source) }
    ] })) localInputFailure('Initialized modules differ from the exact captured local application graph.');
    await reader.assertUnchanged();
    for (const entry of entries) {
      if (physical(await lstat(path.join(dataRoot, ...entry.pathParts), { bigint: true })) !== entry.physical) {
        localInputFailure('Manual initialization output changed during complete capture.');
      }
    }
    await assertControls();
    entries.sort((a, b) => a.pathParts.join('/') < b.pathParts.join('/') ? -1 : a.pathParts.join('/') > b.pathParts.join('/') ? 1 : 0);
    return validateManualInfrastructureOutput({
      kind: 'liftoff-manual-infrastructure-output', schemaVersion: 1, component,
      inputDigest: canonicalSha256(initialization), sourceDigest, toolDigest,
      environmentDigest: canonicalSha256(environment(component)), dataPathParts: root.dataPathParts,
      entries, outputDigest: canonicalSha256(entries)
    }, initialization, sourceDigest, toolDigest, workspace);
  }
  return { environment, assertControls, assertFresh, capture };
}
