import { projectCatalog } from './catalog.js';
import { readManifestFile } from '../../adapters/filesystem/manifest-file.js';
import { createManifestReader } from '../../domain/project/manifest/reader.js';
import { governancePolicyVersion } from '../../domain/governance/policy/content-validation.js';
import { minimumLiftoffForManifestV8 } from '../../domain/project/manifest/identity.js';
import { validateReadableActivationIdentity } from '../../domain/governance/activation/validators.js';
import { managedCoreArtifactPaths } from '../../domain/project/artifact-lifecycle.js';
import { currentStandardsManifestContext } from '../../adapters/packaged-assets/resource-catalog.js';
import { createHash } from 'node:crypto';
import { FileSystemError } from '../../domain/project/errors.js';
import { parseStrictManifestJson } from '../../domain/project/manifest/json.js';
import { isRecord } from '../../domain/project/manifest/fields.js';
import { validateAdoptionRecord } from '../../domain/project-evolution/adoption/record-reader.js';
import { ApplicationFiles } from '../repair/application-files.js';
import { repairRecipes } from '../../domain/repair/identity.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';

const manifestReader = createManifestReader({
  catalog: projectCatalog,
  policyVersion: governancePolicyVersion,
  minimumLiftoffVersion: minimumLiftoffForManifestV8,
  validateActivationIdentity: validateReadableActivationIdentity,
  governanceArtifactPaths: managedCoreArtifactPaths,
  currentStandards: currentStandardsManifestContext
});

export const { parseManifest, normalizeManifestProject, normalizeManifestFramework } = manifestReader;

export async function loadManifest(projectRoot: string) {
  const manifest = parseManifest(await readManifestFile(projectRoot));
  if (manifest.artifactVersion !== 8) return manifest;
  const historyFiles = new ApplicationFiles(projectRoot);
  const readHistory = async (parts: string[]) => {
    const snapshot = await historyFiles.read(parts, 4 * 1024 * 1024);
    return snapshot.content;
  };
  if (manifest.provenance.kind === 'generated' && manifest.provenance.origin.kind === 'historical-manifest') {
    const origin = manifest.provenance.origin;
    const bytes = await readHistory(origin.historyPathParts);
    if (!bytes || bytes.length > 4 * 1024 * 1024 ||
      `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== origin.contentHash) {
      throw new FileSystemError('Preserved source manifest history is absent, oversized or byte-mismatched; do not rewrite its provenance.');
    }
    const source = parseManifest(parseStrictManifestJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (source.artifactVersion !== origin.artifactVersion || source.liftoffVersion !== origin.writerVersion) {
      throw new FileSystemError('Preserved source manifest identity does not match the recorded historical origin.');
    }
  } else if (manifest.provenance.kind === 'adopted') {
    const bytes = await readHistory(['.liftoff', 'adoption-history', manifest.provenance.recordId, 'record.json']);
    if (!bytes || bytes.length > 4 * 1024 * 1024) throw new FileSystemError('Adopted provenance requires its bounded immutable schema-1 adoption record.');
    const record = parseStrictManifestJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'Adoption record');
    if (!isRecord(record) || record.schemaVersion !== 1 || record.kind !== 'liftoff-adoption-record' ||
      record.recordId !== manifest.provenance.recordId || record.assessmentDigest !== manifest.provenance.observationDigest) {
      throw new FileSystemError('Adoption record is not the exact registered provenance identity.');
    }
    const adopted = validateAdoptionRecord(record, {
      recordId: manifest.provenance.recordId, standards: manifest.standards, assessmentDigest: manifest.provenance.observationDigest
    });
    for (const artifact of manifest.projectArtifacts) {
      const adoption = artifact.adoption;
      const addition = artifact.addition;
      if (adoption) {
        const observation = adopted.source.find((source) => source.pathParts.join('/') === adoption.sourcePathParts.join('/'));
        if (!observation || `sha256:${observation.digest}` !== adoption.observedHash || observation.mode !== adoption.observedMode) {
          throw new FileSystemError('Adopted file observations differ from the preserved immutable adoption record.');
        }
        if (artifact.pathParts.join('/') !== adoption.sourcePathParts.join('/') &&
          !adopted.effects.some((effect) => effect.type === 'write' && effect.producer === 'application-patch' &&
            effect.pathParts.join('/') === artifact.pathParts.join('/'))) {
          throw new FileSystemError('An adopted file relocation has no exact recorded application effect.');
        }
      } else if (addition && !adopted.effects.some((effect) =>
        effect.producer === 'application-addition' && effect.pathParts.join('/') === artifact.pathParts.join('/') &&
        effect.logicalName === artifact.logicalName && `sha256:${effect.after.digest}` === addition.contentHash &&
        effect.after.mode === addition.mode)) {
        throw new FileSystemError('A declared project addition differs from its exact immutable adoption effect.');
      } else if (artifact.generatedBy && adopted.source.some((source) =>
        source.pathParts.join('/') === artifact.pathParts.join('/') && source.digest !== null)) {
        throw new FileSystemError('Pre-existing adopted application bytes cannot be relabeled as historical template generation.');
      }
    }
  }
  for (const repair of manifest.provenance.repairs) {
    const bytes = await readHistory(['.liftoff', 'manifest-repairs', `${repair.recordId}.json`]);
    if (!bytes) throw new FileSystemError('Manifest repair provenance is missing its immutable link.');
    const link = parseStrictManifestJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'Manifest repair link');
    const keys = ['schemaVersion', 'kind', 'recordId', 'sourceManifestHash', 'recipe', 'fingerprint', 'receiptPathParts', 'receiptHash'];
    const recipe = Object.values(repairRecipes).find((recipe) => recipe.id === repair.recipe && recipe.version === repair.recipeVersion);
    if (!isRecord(link) || Object.keys(link).length !== keys.length || keys.some((key) => !Object.hasOwn(link, key)) ||
      link.schemaVersion !== 1 || link.kind !== 'liftoff-manifest-repair-link' || link.recordId !== repair.recordId ||
      link.sourceManifestHash !== repair.sourceManifestHash || !recipe || canonicalSha256(link.recipe) !== canonicalSha256(recipe) ||
      typeof link.fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(link.fingerprint) ||
      !Array.isArray(link.receiptPathParts) ||
      link.receiptPathParts.join('/') !== `.liftoff/repair-history/${link.fingerprint}/receipt.json`) {
      throw new FileSystemError('Manifest repair link is not the exact registered original recipe/history identity.');
    }
    const receiptPath = ['.liftoff', 'repair-history', link.fingerprint, 'receipt.json'];
    const receiptBytes = await readHistory(receiptPath);
    if (!receiptBytes || `sha256:${createHash('sha256').update(receiptBytes).digest('hex')}` !== link.receiptHash) {
      throw new FileSystemError('Manifest repair receipt is missing or changed; historical recovery is not a metadata conversion.');
    }
    const receipt = parseStrictManifestJson(receiptBytes.toString('utf8'), 'Repair history receipt');
    if (!isRecord(receipt) || receipt.schemaVersion !== 2 || receipt.kind !== 'liftoff-repair-history' ||
      receipt.fingerprint !== link.fingerprint || canonicalSha256(receipt.recipe) !== canonicalSha256(recipe)) {
      throw new FileSystemError('Manifest repair link does not identify the unchanged schema-2 repair receipt.');
    }
    const sourceBytes = await readHistory(['.liftoff', 'repair-history', link.fingerprint, 'manifest.json']);
    if (!sourceBytes || `sha256:${createHash('sha256').update(sourceBytes).digest('hex')}` !== repair.sourceManifestHash) {
      throw new FileSystemError('Original pre-repair manifest history is missing or changed.');
    }
  }
  await historyFiles.assertUnchanged();
  return manifest;
}
