import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { GeneratedArtifact, LiftoffManifest } from '../../src/domain/project/contracts.js';

interface Change {
  surface: string;
  key: string;
  currentSha256: string;
  templateAuditRefresh?: string;
  priorChange?: Change;
}

interface AuditRenderingChanges {
  refresh: string;
  assets: Array<{
    file: string;
    logicalName: string;
    beforeSha256: string;
    afterSha256: string;
    hunks: Array<{ before: string; after: string }>;
  }>;
  update: {
    beforeSha256: string;
    fields: Array<{ segments: string[]; before: string; after: string }>;
  };
}

export const templateAuditRenderingChanges: AuditRenderingChanges = JSON.parse(readFileSync(
  new URL('./template-audit-rendering-changes.json', import.meta.url), 'utf8'));
const review: { changes: Change[] } = JSON.parse(readFileSync(
  new URL('./contract-baseline-changes.json', import.meta.url), 'utf8'));
const { stableDigest }: { stableDigest: (value: unknown) => string } =
  createRequire(import.meta.url)('../../scripts/contract-baseline.mjs');
const digest = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

export function restoreTemplateAuditArtifacts(artifacts: GeneratedArtifact[]): GeneratedArtifact[] {
  const restored = structuredClone(artifacts);
  const hashes = new Map<string, { before: string; after: string }>();
  for (const artifact of restored) {
    const sources = templateAuditRenderingChanges.assets.filter(asset => asset.logicalName === artifact.logicalName);
    if (!sources.length) continue;
    const candidates = sources.flatMap(source => {
      let content = artifact.content;
      for (const hunk of [...source.hunks].reverse()) {
        if (content.split(hunk.after).length !== 2) return [];
        content = content.replace(hunk.after, hunk.before);
      }
      return [content];
    });
    const distinct = [...new Set(candidates)];
    assert.equal(distinct.length, 1, `${artifact.logicalName}: exact authenticated asset patch`);
    const before = distinct[0]!;
    hashes.set(artifact.logicalName, { before: digest(before), after: digest(artifact.content) });
    artifact.content = before;
  }
  const manifests = restored.filter(artifact => artifact.logicalName === 'manifest');
  assert.equal(manifests.length, 1);
  const manifest = manifests[0]!;
  const parsed: LiftoffManifest = JSON.parse(manifest.content);
  for (const entry of parsed.projectArtifacts) {
    const pair = hashes.get(entry.logicalName);
    if (!pair) continue;
    assert.equal(entry.generationHash, pair.after, `${entry.logicalName}: exact induced generation hash`);
    entry.generationHash = pair.before;
  }
  manifest.content = JSON.stringify(parsed, null, 2) + '\n';
  return restored;
}

export function expectBeforeTemplateAuditGeneration(key: string, restored: unknown): void {
  const changes = review.changes.filter(change => change.surface === 'plugin-generation' && change.key === key);
  assert.equal(changes.length, 1);
  const change = changes[0]!;
  const prior = change.templateAuditRefresh === templateAuditRenderingChanges.refresh ? change.priorChange : change;
  assert.ok(prior, `${key}: complete preceding generation record`);
  assert.equal(stableDigest(restored), prior.currentSha256,
    `${key}: only the authenticated asset patches and their manifest hashes may differ`);
}

export function restoreTemplateAuditUpdate(current: unknown): unknown {
  const restored: unknown = structuredClone(current);
  for (const field of templateAuditRenderingChanges.update.fields) {
    let parent = restored;
    for (const segment of field.segments.slice(0, -1)) {
      assert.ok(parent !== null && typeof parent === 'object');
      parent = Reflect.get(parent, segment);
    }
    assert.ok(parent !== null && typeof parent === 'object');
    const leaf = field.segments.at(-1)!;
    assert.equal(Reflect.get(parent, leaf), field.after, field.segments.join('/'));
    Reflect.set(parent, leaf, field.before);
  }
  assert.equal(stableDigest(restored), templateAuditRenderingChanges.update.beforeSha256,
    'only the eight measured physical-asset/manifest update content digests may differ');
  return restored;
}
