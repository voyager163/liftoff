import { lstat } from 'node:fs/promises';
import path from 'node:path';
import {
  CANONICAL_SKILL_IDS,
  SUPPORTED_SKILL_HOSTS,
  type SkillHostId,
  type SkillOwnershipStore,
  type SkillProjectionRecord,
  type SkillScope
} from '../../domain/skills/contracts.js';
import { canonicalJson, canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import {
  canonicalSkillRoot,
  captureSkillFile,
  validateSkillPathParts
} from '../../adapters/skills/discovery.js';
import { registeredSkillPathParts } from '../../domain/skills/identity.js';
import { isUpdatePlanFingerprint } from '../update/approval.js';
import type { createSkillsOwnershipAuthorityStore } from '../../adapters/filesystem/update-previews.js';

export type SkillOwnershipAuthorityStore = ReturnType<typeof createSkillsOwnershipAuthorityStore>;

export const skillOwnershipPathParts = ['.liftoff', 'skills-ownership.json'] as const;

function invalid(message: string): never {
  throw new Error(`Invalid skills ownership: ${message}`);
}

function exactFields(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    invalid(`${label} has missing or unrecognized fields.`);
  }
}

export function orderedSkillHosts(hosts: readonly SkillHostId[]): SkillHostId[] {
  return SUPPORTED_SKILL_HOSTS.filter((host) => hosts.includes(host));
}

export function resolveOwnershipFilePath(scope: SkillScope, targetRoot: string): string {
  if (!['user', 'project'].includes(scope)) invalid('unknown scope.');
  return path.join(path.resolve(targetRoot), ...skillOwnershipPathParts);
}

export function emptyOwnershipStore(scope: SkillScope, canonicalRoot: string): SkillOwnershipStore {
  return {
    schemaVersion: 1, kind: 'liftoff-skills-ownership', catalogId: 'liftoff-canonical-skills',
    scope, targetRoot: canonicalRoot, projections: {}
  };
}

export function validateOwnershipStore(value: unknown, scope: SkillScope, canonicalRoot: string): SkillOwnershipStore {
  exactFields(value, ['schemaVersion', 'kind', 'catalogId', 'scope', 'targetRoot', 'projections'], 'store');
  if (value.schemaVersion !== 1 || value.kind !== 'liftoff-skills-ownership' || value.catalogId !== 'liftoff-canonical-skills') {
    invalid('unsupported schema, record kind, or canonical catalog identity.');
  }
  if (value.scope !== scope || value.targetRoot !== canonicalRoot || path.resolve(canonicalRoot) !== canonicalRoot) {
    invalid('scope or canonical target differs from the independently selected target.');
  }
  if (!isRecord(value.projections) || Object.keys(value.projections).length > CANONICAL_SKILL_IDS.length * SUPPORTED_SKILL_HOSTS.length) {
    invalid('projection inventory is malformed or oversized.');
  }
  const projections: Record<string, SkillProjectionRecord> = {};
  const folded = new Set<string>();
  for (const [destination, raw] of Object.entries(value.projections)) {
    exactFields(raw, [
      'logicalId', 'skillId', 'host', 'pathParts', 'relativeDestination',
      'canonicalContentHash', 'projectedContentHash', 'projectedMode', 'catalogVersion', 'catalogDigest',
      'consumers', 'installedByPlan', 'updatedByPlan'
    ], destination);
    if (!CANONICAL_SKILL_IDS.includes(raw.skillId as SkillProjectionRecord['skillId']) ||
        !SUPPORTED_SKILL_HOSTS.includes(raw.host as SkillHostId) ||
        raw.logicalId !== `canonical-skill:${String(raw.skillId)}`) {
      invalid(`unregistered canonical logical identity or host at ${destination}.`);
    }
    const skillId = raw.skillId as SkillProjectionRecord['skillId'];
    const host = raw.host as SkillHostId;
    const parts = validateSkillPathParts(raw.pathParts);
    const expected = registeredSkillPathParts(skillId, host, scope);
    const key = destination.normalize('NFC').toLowerCase();
    if (folded.has(key) || destination !== expected.join('/') || parts.join('/') !== destination ||
        raw.relativeDestination !== destination || isFrameworkOrUserSkill(destination)) {
      invalid(`unregistered, aliased, or inconsistent path at ${destination}.`);
    }
    folded.add(key);
    if (!Array.isArray(raw.consumers) || raw.consumers.length === 0 ||
        raw.consumers.some((consumer) => !SUPPORTED_SKILL_HOSTS.includes(consumer as SkillHostId) ||
          registeredSkillPathParts(skillId, consumer as SkillHostId, scope).join('/') !== destination) ||
        canonicalJson(raw.consumers) !== canonicalJson(orderedSkillHosts(raw.consumers as SkillHostId[])) ||
        raw.consumers[0] !== host) {
      invalid(`inconsistent selected consumers at ${destination}.`);
    }
    for (const field of ['canonicalContentHash', 'projectedContentHash', 'catalogDigest', 'installedByPlan', 'updatedByPlan']) {
      if (!isUpdatePlanFingerprint(raw[field])) invalid(`${field} at ${destination} is not a full lowercase SHA-256 identity.`);
    }
    if (typeof raw.catalogVersion !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9a-z.-]+)?$/u.test(raw.catalogVersion)) {
      invalid(`unsupported canonical catalog version at ${destination}.`);
    }
    if (!Number.isInteger(raw.projectedMode) || (raw.projectedMode as number) < 0 ||
        (raw.projectedMode as number) > 0o777 || ((raw.projectedMode as number) & 0o111) !== 0) {
      invalid(`unsafe projected file mode at ${destination}.`);
    }
    projections[destination] = {
      logicalId: raw.logicalId as string, skillId, host, pathParts: parts, relativeDestination: destination,
      canonicalContentHash: raw.canonicalContentHash as string, projectedContentHash: raw.projectedContentHash as string,
      projectedMode: raw.projectedMode as number, catalogVersion: raw.catalogVersion,
      catalogDigest: raw.catalogDigest as string, consumers: [...raw.consumers as SkillHostId[]],
      installedByPlan: raw.installedByPlan as string, updatedByPlan: raw.updatedByPlan as string
    };
  }
  return { ...emptyOwnershipStore(scope, canonicalRoot), projections };
}

export async function loadOwnershipStore(scope: SkillScope, targetRoot: string): Promise<SkillOwnershipStore> {
  const canonicalRoot = await canonicalSkillRoot(targetRoot);
  const { snapshot } = await captureSkillFile(canonicalRoot, skillOwnershipPathParts);
  if (snapshot.content === undefined) return emptyOwnershipStore(scope, canonicalRoot);
  if (snapshot.mode !== (process.platform === 'win32' ? 0o666 : 0o600)) {
    invalid('the ownership record must retain its private regular-file mode.');
  }
  let value: unknown;
  try { value = JSON.parse(snapshot.content.toString('utf8')); }
  catch { return invalid('malformed JSON; existing bytes were preserved.'); }
  const store = validateOwnershipStore(value, scope, canonicalRoot);
  if (canonicalJson(store) !== snapshot.content.toString('utf8')) {
    invalid('the record does not retain its exact canonical serialization.');
  }
  return store;
}

export async function verifySkillOwnershipAuthority(
  store: SkillOwnershipStore, authority: SkillOwnershipAuthorityStore
): Promise<void> {
  const digest = canonicalSha256(store);
  const record = await authority.read(digest);
  if (!record) invalid('the current ownership bytes have no matching private identity-bound approval; a project-local hash claim is not ownership.');
  const value = record.value;
  exactFields(value, ['schemaVersion', 'kind', 'scope', 'targetRoot', 'ownershipDigest', 'planFingerprint', 'catalogDigest'], 'private authority');
  if (record.projectRoot !== store.targetRoot || value.schemaVersion !== 1 ||
      value.kind !== 'liftoff-skills-ownership-authority' || value.scope !== store.scope ||
      value.targetRoot !== store.targetRoot || value.ownershipDigest !== digest ||
      !isUpdatePlanFingerprint(value.planFingerprint) || !isUpdatePlanFingerprint(value.catalogDigest)) {
    invalid('the private record does not authorize this exact scope, target, and ownership inventory.');
  }
}

export async function recordSkillOwnershipAuthority(
  store: SkillOwnershipStore, planFingerprint: string, catalogDigest: string,
  authority: SkillOwnershipAuthorityStore
): Promise<void> {
  if (!isUpdatePlanFingerprint(planFingerprint) || !isUpdatePlanFingerprint(catalogDigest)) {
    invalid('private ownership approval needs exact plan and catalog identities.');
  }
  const ownershipDigest = canonicalSha256(store);
  await authority.write(ownershipDigest, {
    schemaVersion: 1, kind: 'liftoff-skills-ownership-authority',
    scope: store.scope, targetRoot: store.targetRoot, ownershipDigest, planFingerprint, catalogDigest
  });
  await verifySkillOwnershipAuthority(store, authority);
}

export function isFrameworkOrUserSkill(relativeDestination: string): boolean {
  const parts = relativeDestination.replace(/\\/g, '/').split('/');
  return parts.some((part) => /^(?:openspec|opsx|speckit|specify)(?:-|$)/iu.test(part) || part === '.specify');
}

export interface DiskInspection {
  exists: boolean;
  isFile: boolean;
  contentHash?: string;
  mode?: number;
}

export async function inspectFileOnDisk(absolutePath: string): Promise<DiskInspection> {
  let details;
  try { details = await lstat(absolutePath); }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return { exists: false, isFile: false };
    }
    throw error;
  }
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1) return { exists: true, isFile: false };
  const captured = await captureSkillFile(path.dirname(absolutePath), [path.basename(absolutePath)]);
  if (captured.observation.state !== 'file') throw new Error('Skill input disappeared while inspecting.');
  return { exists: true, isFile: true, contentHash: captured.observation.contentHash, mode: captured.observation.mode };
}
