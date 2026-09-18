import type { CanonicalSkillDefinition, CanonicalSkillId, SkillCatalog } from '../../domain/skills/contracts.js';
import {
  enrichCanonicalSkill, isCanonicalSkillId, SkillCatalogError,
  strictSkillObject, validateCanonicalSkillMetadata, validateSkillCatalogMetadata
} from '../../domain/skills/catalog.js';
import { parseStrictManifestJson } from '../../domain/project/manifest/json.js';
import { resolvePackagedResource } from './resource-catalog.js';

export interface LoadCatalogOptions {
  reload?: boolean;
}

function verifiedText(resourceId: string, pathParts: readonly string[], maximumBytes: number): {
  content: string;
  hash: string;
} {
  const resource = resolvePackagedResource(resourceId, { expectedPathParts: pathParts, maximumBytes });
  if (resource.descriptor.id !== resourceId || resource.descriptor.category !== 'skill' || resource.descriptor.componentId !== 'canonical-skills' ||
      resource.descriptor.lifecycle !== 'managed-core' || !/^sha256:[a-f0-9]{64}$/u.test(resource.digest)) {
    throw new SkillCatalogError(`Unregistered canonical skill resource identity: ${resourceId}`);
  }
  const content = resource.buffer.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(resource.buffer)) {
    throw new SkillCatalogError(`Canonical skill resource is not valid UTF-8: ${resourceId}`);
  }
  return { content, hash: resource.digest.slice('sha256:'.length) };
}

export function assertValidSkillEntrypoint(entrypoint: unknown, skillId: string): string[] {
  if (!isCanonicalSkillId(skillId) || entrypoint !== `${skillId}/SKILL.md`) {
    throw new SkillCatalogError('Canonical skill entrypoint must be its exact registered portable identity.');
  }
  return [skillId, 'SKILL.md'];
}

export function validateAndEnrichSkill(raw: unknown): CanonicalSkillDefinition {
  const metadata = validateCanonicalSkillMetadata(raw);
  const source = verifiedText(`skills.${metadata.id}`, ['assets', 'skills', metadata.id, 'SKILL.md'], 2 * 1024 * 1024);
  return enrichCanonicalSkill(metadata, source.content, source.hash);
}

export function clearSkillCatalogCache(): void {
  // Compatibility only: every read verifies current packaged bytes.
}

export function loadCanonicalSkillCatalog(_options?: LoadCatalogOptions): SkillCatalog {
  if (_options !== undefined) {
    const options = strictSkillObject(_options, [], 'Canonical loader options', ['reload']);
    if (options.reload !== undefined && typeof options.reload !== 'boolean') throw new SkillCatalogError('Canonical reload option must be a boolean.');
  }
  const resource = verifiedText('skills.catalog', ['assets', 'skills', 'catalog.json'], 256 * 1024);
  const metadata = validateSkillCatalogMetadata(parseStrictManifestJson(resource.content, 'Canonical skill catalog'));
  return {
    schemaVersion: 1, catalogVersion: metadata.catalogVersion,
    skills: metadata.skills.map(validateAndEnrichSkill)
  };
}

export function getCanonicalSkill(id: CanonicalSkillId, options?: LoadCatalogOptions): CanonicalSkillDefinition {
  if (!isCanonicalSkillId(id)) throw new SkillCatalogError(`Unknown canonical skill identity: ${String(id)}`);
  const skill = loadCanonicalSkillCatalog(options).skills.find((entry) => entry.id === id);
  if (!skill) throw new SkillCatalogError(`Canonical skill ${id} is missing from the verified inventory.`);
  return skill;
}
