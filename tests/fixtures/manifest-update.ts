import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach } from 'vitest';
import { parseManifest } from '../../src/application/project/manifest.js';
import { projectCatalog } from '../../src/application/project/catalog.js';
import { composeModernManifestPlugins } from '../../src/application/project/plugins.js';
import { createManifestV8ProjectReader } from '../../src/domain/project/manifest/v8-project.js';
import type { ModernManagedCoreInput } from '../../src/application/project/modern-managed-core.js';
import { readManifestPluginMetadata } from '../../src/domain/project/manifest/plugins.js';
import { toSafeProjectName } from '../../src/domain/project/planning.js';
import { rawHistoryDigest } from '../../src/governance-activation/history-contracts.js';
import { readUpdateSuccessorApprovalAudit, type UpdatePreviewOptions } from '../../src/adapters/filesystem/update-previews.js';
import type { previewModernSuccessorUpdate } from '../../src/application/update/use-case.js';

export const now = '2026-09-01T12:00:00.000Z';
const roots: string[] = [], streams: PassThrough[] = [];
afterEach(async () => {
  for (const stream of streams.splice(0)) stream.destroy();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true });
});

export async function fixture(version = '0.12.3', profile: 'none' | 'single-maintainer-gitflow' = 'single-maintainer-gitflow') {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'liftoff-manifest-update-')));
  roots.push(parent);
  const root = path.join(parent, 'project with spaces'), home = path.join(parent, 'home');
  await fs.mkdir(root); await fs.mkdir(home);
  const raw = await fs.readFile(new URL(`./contract-baseline-0.12.3/manifests/${version}-standard-go.json`, import.meta.url));
  const original = Buffer.from(raw.toString('utf8').replace(/\r?\n/gu, '\r\n'));
  const manifest = parseManifest(JSON.parse(original.toString('utf8')));
  const workload = manifest.project.workload;
  const composition = composeModernManifestPlugins({
    workload: workload.kind, ...(workload.kind === 'genai' ? { variant: workload.pattern } : {}),
    stack: workload.apiStack, cloud: workload.cloud, workflow: manifest.project.specWorkflow,
    agents: manifest.project.agents, frontend: workload.frontend ? 'included' : 'omitted',
    governanceProfile: profile, environments: workload.environments
  }, { safeProjectName: toSafeProjectName(manifest.project.name) });
  const selection: ModernManagedCoreInput = {
    selection: { ...createManifestV8ProjectReader(projectCatalog).validateManifestV8Project({
      project: manifest.project, framework: manifest.framework
    }), profile },
    plugins: readManifestPluginMetadata({
      schemaVersion: 1, resolutionDigest: composition.resolution.digest, selections: composition.resolution.plugins
    }, { stack: workload.apiStack, cloud: workload.cloud, workflow: manifest.project.specWorkflow, agents: manifest.project.agents }),
    activeLayout: { schemaVersion: 1, state: 'unresolved', bindings: [] }
  };
  await fs.writeFile(path.join(root, 'liftoff.manifest.json'), original, { mode: 0o640 });
  await fs.writeFile(path.join(root, 'application.txt'), 'User-owned application bytes.\r\n');
  await fs.writeFile(path.join(root, 'package.json'), '{"scripts":{"test":"node MUST-NOT-EXECUTE.js"}}\n');
  const options: UpdatePreviewOptions = { homedir: home, env: {}, clock: () => new Date(now) };
  return { parent, root, home, original, manifest, selection, options };
}

export async function inventory(root: string) {
  const files: Record<string, { digest: string; mode: number }> = {};
  async function walk(parts: string[]) {
    for (const entry of await fs.readdir(path.join(root, ...parts), { withFileTypes: true })) {
      const next = [...parts, entry.name], absolute = path.join(root, ...next);
      if (entry.isDirectory()) await walk(next);
      else files[next.join('/')] = {
        digest: rawHistoryDigest(await fs.readFile(absolute)), mode: (await fs.lstat(absolute)).mode & 0o7777
      };
    }
  }
  await walk([]); return files;
}

export function approval(confirm?: () => Promise<boolean>) {
  const stdin = Object.assign(new PassThrough(), { isTTY: confirm !== undefined });
  const stderr = Object.assign(new PassThrough(), { isTTY: confirm !== undefined });
  streams.push(stdin, stderr);
  return { stdin, stderr, ...(confirm ? { approveUpdatePlan: confirm } : {}) };
}

export async function write(root: string, parts: readonly string[], bytes: string | Buffer) {
  const absolute = path.join(root, ...parts);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, bytes);
}

export async function auditFor(project: Awaited<ReturnType<typeof fixture>>, preview: Awaited<ReturnType<typeof previewModernSuccessorUpdate>>) {
  return readUpdateSuccessorApprovalAudit({
    projectRoot: project.root, semanticTransitionDigest: preview.receipt.publication.semanticTransitionDigest,
    preparationId: preview.receipt.receiptId
  }, project.options);
}
