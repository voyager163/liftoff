import {
  SUPPORTED_STANDARDS_PROFILE_IDS, isSupportedProfileId as isCanonicalProfileId,
  type StandardsProfile, type StandardsProfileCatalog, type StandardsProfileId
} from '../standards/profile-schema.js';
import type { StandardsProfileIdentity } from './types.js';
import { canonicalJson, sha256Hex } from './sanitizer.js';

const aliases: Readonly<Record<string, StandardsProfileId>> = {
  fastapi: 'python-fastapi', fastify: 'node-fastify', node: 'node-fastify',
  huma: 'go-huma', go: 'go-huma', vue: 'vue-component', frontend: 'vue-component',
  genai: 'genai-generic', 'python-genai': 'genai-generic', 'genai-backend': 'genai-generic'
};

export function resolveProfileId(input: string): StandardsProfileId | undefined {
  const normalized = input.trim().toLowerCase();
  return isCanonicalProfileId(normalized) ? normalized :
    Object.hasOwn(aliases, normalized) ? aliases[normalized] : undefined;
}

export function adaptStandardsProfile(profile: StandardsProfile): StandardsProfileIdentity {
  return {
    schemaVersion: profile.schemaVersion, id: profile.id, revision: profile.revision, digest: profile.digest,
    name: profile.label, description: profile.label, status: 'supported',
    declaredRuleCoverage: profile.evaluationCoverage.map((rule) => rule.id),
    componentBoundaries: { allowedRoots: [...profile.componentBoundaries], requiredDeclarations: [], sourcePatterns: [] }
  };
}

export function getSupportedProfile(idOrAlias: string, catalog: StandardsProfileCatalog): StandardsProfileIdentity | undefined {
  const id = resolveProfileId(idOrAlias);
  if (!catalog) throw new Error('A validated installed standards catalog is required; no synthetic profile identity is available.');
  const profile = id && Object.hasOwn(catalog.profiles, id) ? catalog.profiles[id] : undefined;
  return profile ? adaptStandardsProfile(profile) : undefined;
}

export function listSupportedProfiles(catalog: StandardsProfileCatalog): readonly StandardsProfileIdentity[] {
  if (!catalog) throw new Error('A validated installed standards catalog is required; no synthetic profile inventory is available.');
  return SUPPORTED_STANDARDS_PROFILE_IDS.map((id) => adaptStandardsProfile(catalog.profiles[id]));
}

export function isSupportedProfileId(id: string): boolean {
  return resolveProfileId(id) !== undefined;
}

export function makeUnsupportedProfile(id: string, name?: string): StandardsProfileIdentity {
  const raw = {
    schemaVersion: 1 as const, id, revision: 'unsupported', name: name ?? `Unsupported: ${id}`,
    description: `The stack '${id}' is not a supported Liftoff standards profile.`,
    status: 'unsupported' as const, declaredRuleCoverage: []
  };
  return { ...raw, digest: sha256Hex(canonicalJson(raw)) };
}

export function makeUnresolvedProfile(): StandardsProfileIdentity {
  const raw = {
    schemaVersion: 1 as const, id: 'unresolved', revision: 'none', name: 'Unresolved Profile',
    description: 'Captured evidence does not establish one unambiguous supported profile for the selected scope.',
    status: 'unresolved' as const, declaredRuleCoverage: []
  };
  return { ...raw, digest: sha256Hex(canonicalJson(raw)) };
}
