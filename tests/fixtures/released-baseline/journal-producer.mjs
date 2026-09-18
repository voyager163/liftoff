import { chmod, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadReleasedSource } from './source-loader.mjs';

export const journalCases = [
  { id: 'update-v0.11.2-schema1', release: 'v0.11.2', kind: 'update', schemaVersion: 1, explicitKind: false },
  { id: 'repair-v0.12.2-schema1', release: 'v0.12.2', kind: 'repair', schemaVersion: 1, explicitKind: true },
  { id: 'update-v0.12.3-schema1', release: 'v0.12.3', kind: 'update', schemaVersion: 1, explicitKind: true },
  { id: 'repair-v0.12.3-azure-schema2', release: 'v0.12.3', kind: 'repair', schemaVersion: 2, explicitKind: true, recipe: 'azure-local-layout' },
  { id: 'repair-v0.12.3-application-schema2', release: 'v0.12.3', kind: 'repair', schemaVersion: 2, explicitKind: true, recipe: 'application-layout-patch' }
];

export async function fileTree(root) {
  const files = [];
  async function visit(parts) {
    for (const entry of (await readdir(path.join(root, ...parts), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const next = [...parts, entry.name];
      if (entry.isDirectory()) await visit(next);
      else {
        const target = path.join(root, ...next);
        const details = await lstat(target);
        if (!details.isFile() || details.nlink !== 1) throw new Error(`Not a private regular fixture file: ${target}`);
        files.push({ path: next.join('/'), mode: details.mode & 0o7777, bytes: (await readFile(target)).toString('base64') });
      }
    }
  }
  await visit([]);
  return files;
}

async function put(root, parts, content, mode = 0o600) {
  const target = path.join(root, ...parts);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, content, { flag: 'wx', mode });
  await chmod(target, mode);
}

async function produce(config) {
  const released = loadReleasedSource(path.resolve(config.sourceRoot));
  const { applyReviewedUpdateTransaction } = await released.import('src/adapters/filesystem/reviewed-update-transaction.ts');
  const { captureProjectFileSnapshot } = await released.import('src/adapters/filesystem/project-transaction.ts');
  const { projectMutationLockPath } = await released.import('src/adapters/filesystem/project-lock.ts');
  const { createUpdateTransactionApprovalStore } = await released.import('src/adapters/filesystem/update-previews.ts');
  const { canonicalSha256 } = await released.import('src/domain/governance/activation/canonical-json.ts');
  const writer = journalCases.find((entry) => entry.id === config.caseId);
  if (!writer) throw new Error('Unregistered released journal fixture.');
  const workspace = path.resolve(config.workspace);
  const root = path.join(workspace, "project's directory with spaces");
  const home = path.join(workspace, 'private home');
  await mkdir(root, { mode: 0o700 });
  await mkdir(path.join(root, '.git'), { mode: 0o700 });
  await mkdir(home, { mode: 0o700 });
  const fingerprint = canonicalSha256({ fixture: writer.id, effects: 'bounded-local-byte-preservation' });
  const raw = Buffer.from([0xef, 0xbb, 0xbf, 0x23, 0x0d, 0x0a, 0xff, 0x00, 0x80, 0x0d, 0x0a]);
  const originalManifest = Buffer.from('{\r\n\t"fixture": "original released transaction bytes"\r\n}\r\n');
  const targetManifest = Buffer.from('{"fixture":"approved target bytes"}\n');
  const source = writer.kind === 'repair' ? ['infra', 'opentofu', 'main.tf'] : ['governance', 'evidence', 'receipt.bin'];
  const target = writer.kind === 'repair' ? ['infra', 'opentofu', 'modules', 'application', 'main.tf'] : ['governance', 'successor', 'receipt.bin'];
  const history = writer.kind === 'repair' ? ['.liftoff', 'repair-history', fingerprint] : ['governance', 'history', fingerprint, 'files'];
  await put(root, source, raw, 0o640);
  await put(root, ['liftoff.manifest.json'], originalManifest);
  await put(root, ['unrelated.bin'], Buffer.from([0x00, 0xfe, 0xff, 0x0d, 0x0a]), 0o644);
  await put(root, ['user-script.sh'], '#!/bin/sh\r\nprintf untouched\r\n', 0o750);
  const mutations = [
    { type: 'write', pathParts: [...history, ...source], content: raw, mode: 0o440 },
    { type: 'write', pathParts: [...history, 'liftoff.manifest.json'], content: originalManifest, mode: 0o440 },
    { type: 'delete', pathParts: source },
    { type: 'write', pathParts: target, content: raw, mode: 0o640 },
    { type: 'write', pathParts: ['liftoff.manifest.json'], content: targetManifest, mode: 0o600 }
  ];
  const storage = { homedir: home, env: {}, repositoryRoot: root, clock: () => new Date('2026-09-09T00:00:00.000Z') };
  const approvalStore = createUpdateTransactionApprovalStore(root, storage);
  const repairIdentity = writer.recipe
    ? (await released.import('src/domain/repair/identity.ts')).repairExecutionIdentity(
        (await released.import('src/version.ts')).liftoffVersion, writer.recipe)
    : undefined;
  const before = await fileTree(root);
  const preconditions = await Promise.all(mutations.map((entry) => captureProjectFileSnapshot(root, entry.pathParts)));
  const lock = await projectMutationLockPath(root);
  const metadata = {
    caseId: writer.id, release: writer.release, root, home, fingerprint, lock,
    platform: process.platform, node: process.version,
    checkpoint: config.checkpoint, before,
    mutations: mutations.map((entry) => entry.type === 'write'
      ? { ...entry, content: entry.content.toString('base64') } : entry)
  };
  await writeFile(path.join(workspace, 'handover.json'), `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await applyReviewedUpdateTransaction(root, mutations, {
    ...(writer.explicitKind ? { transactionKind: writer.kind } : {}),
    ...(repairIdentity ? { repairIdentity } : {}),
    planFingerprint: fingerprint, approvalStore, preconditions,
    onCheckpoint: async (checkpoint) => {
      if (checkpoint.phase === config.checkpoint.phase && checkpoint.index === config.checkpoint.index) {
        await writeFile(path.join(workspace, 'loaded-source.json'), `${JSON.stringify([...released.loaded].sort(), null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        process.exit(73);
      }
    }
  });
  throw new Error('The released writer did not reach the requested interruption.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await produce(JSON.parse(process.argv[2]));
}
