import path from 'node:path';
import type {
  CanonicalSkillId,
  PlannedSkillAction,
  SkillCatalog,
  SkillDeliveryIntent,
  SkillDeliveryPlan,
  SkillDiscoveryObservation,
  SkillHostId,
  SkillOwnershipStore,
  SkillProjection,
  SkillScope
} from '../../domain/skills/contracts.js';
import { CANONICAL_SKILL_IDS, SUPPORTED_SKILL_HOSTS } from '../../domain/skills/contracts.js';
import { validateEnrichedSkillCatalog } from '../../domain/skills/catalog.js';
import { registeredSkillPathParts } from '../../domain/skills/identity.js';
import { governanceAgentIntegrations } from '../../domain/project/catalog.js';
import { canonicalJson, canonicalSha256, sha256Hex } from '../../domain/governance/activation/canonical-json.js';
import { loadCanonicalSkillCatalog } from '../../adapters/packaged-assets/skill-assets.js';
import { projectSkillForHost } from '../../adapters/skills/host-projections.js';
import {
  canonicalSkillRoot,
  captureSkillDirectories,
  captureSkillFile,
  detectOverlappingPersonalRoots,
  skillDiscoveryPathParts,
  type CapturedSkillFile
} from '../../adapters/skills/discovery.js';
import type { ProjectFileMutation, ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import { userScopeMutationLockPath } from '../../adapters/filesystem/project-lock.js';
import { createSkillsOwnershipAuthorityStore } from '../../adapters/filesystem/update-previews.js';
import { getPackageRoot } from '../../adapters/packaged-assets/package-root.js';
import {
  loadOwnershipStore,
  orderedSkillHosts,
  skillOwnershipPathParts,
  validateOwnershipStore,
  verifySkillOwnershipAuthority,
  type SkillOwnershipAuthorityStore
} from './ownership.js';
import { liftoffVersion } from '../../version.js';

const REVIEW_WINDOW_MS = 15 * 60 * 1000;
const knownPlans = new WeakMap<SkillDeliveryPlan, PreparedSkillPlan>();
const recoveryPaths = [
  ['.liftoff', 'reviewed-update-transaction.json'],
  ['.liftoff', 'reviewed-repair-transaction.json'],
  ['.liftoff', 'reviewed-adoption-transaction.json'],
  ['.liftoff', 'reviewed-skills-transaction.json'],
  ['.liftoff-init.lock']
] as const;

export interface PlanDeliveryOptions {
  scope: SkillScope;
  targetRoot: string;
  hosts: readonly SkillHostId[];
  skillIds?: readonly CanonicalSkillId[];
  intent?: SkillDeliveryIntent;
}

export interface SkillPlanningDependencies {
  now?: () => Date;
  loadCatalog?: () => SkillCatalog;
  shadowRoot?: string;
  ownershipAuthority?: SkillOwnershipAuthorityStore;
  catalogRoot?: string;
}

export interface PreparedSkillPlan {
  options: PlanDeliveryOptions;
  dependencies: SkillPlanningDependencies;
  store: SkillOwnershipStore;
  snapshots: readonly ProjectFileSnapshot[];
  projections: ReadonlyMap<string, SkillProjection>;
}

export function skillPlanState(plan: SkillDeliveryPlan): PreparedSkillPlan {
  const prepared = knownPlans.get(plan);
  if (!prepared) throw new Error('Skills execution requires an immutable plan produced by the current planner, not a supplied plan document.');
  return prepared;
}

function freeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

function checkedOptions(options: PlanDeliveryOptions): PlanDeliveryOptions {
  if (!['user', 'project'].includes(options.scope) || !['install', 'update', 'remove'].includes(options.intent ?? 'install')) {
    throw new Error('Unknown skill delivery scope or operation.');
  }
  if (!Array.isArray(options.hosts) || options.hosts.length === 0 ||
      options.hosts.some((host) => !SUPPORTED_SKILL_HOSTS.includes(host)) ||
      new Set(options.hosts).size !== options.hosts.length) {
    throw new Error('Skill delivery requires an explicit, duplicate-free host selection.');
  }
  if (options.skillIds !== undefined && (!Array.isArray(options.skillIds) || options.skillIds.length === 0 ||
      options.skillIds.some((id) => !CANONICAL_SKILL_IDS.includes(id)) ||
      new Set(options.skillIds).size !== options.skillIds.length)) {
    throw new Error('Skill delivery requires registered, duplicate-free canonical skill identities.');
  }
  return {
    scope: options.scope, targetRoot: options.targetRoot, hosts: orderedSkillHosts(options.hosts),
    skillIds: CANONICAL_SKILL_IDS.filter((id) => options.skillIds === undefined || options.skillIds.includes(id)),
    intent: options.intent ?? 'install'
  };
}

export function checkedSkillCatalog(
  load: () => SkillCatalog = () => loadCanonicalSkillCatalog({ reload: true })
): SkillCatalog {
  return validateEnrichedSkillCatalog(load());
}

export async function captureCanonicalSkillInputs(
  catalog: SkillCatalog, requestedRoot = getPackageRoot()
): Promise<SkillDiscoveryObservation> {
  const root = await canonicalSkillRoot(requestedRoot);
  const catalogFile = await captureSkillFile(root, ['assets', 'skills', 'catalog.json']);
  if (catalogFile.snapshot.content === undefined) throw new Error('The packaged canonical skill catalog is missing.');
  let metadata: unknown;
  try { metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(catalogFile.snapshot.content)); }
  catch { throw new Error('The packaged canonical skill catalog is not valid UTF-8 JSON.'); }
  const expectedMetadata = {
    schemaVersion: catalog.schemaVersion, catalogVersion: catalog.catalogVersion,
    skills: catalog.skills.map((skill) => {
      const { content: _content, contentHash: _hash, ...definition } = skill;
      return definition;
    })
  };
  if (canonicalJson(metadata) !== canonicalJson(expectedMetadata)) {
    throw new Error('Packaged canonical catalog metadata changed or does not match the loaded catalog. Review with a fresh catalog; cached metadata is not authority.');
  }
  const resourceCatalog = await captureSkillFile(root, ['assets', 'templates', 'catalog.json']);
  const files = [catalogFile.observation, resourceCatalog.observation];
  for (const skill of catalog.skills) {
    const input = await captureSkillFile(root, ['assets', 'skills', skill.id, 'SKILL.md']);
    if (input.snapshot.content === undefined ||
        new TextDecoder('utf-8', { fatal: true }).decode(input.snapshot.content).replace(/\r\n/g, '\n') !== skill.content) {
      throw new Error(`Packaged canonical skill source changed or is missing: ${skill.id}. Cached content is not authority.`);
    }
    files.push(input.observation);
  }
  return { root, files, directories: await captureSkillDirectories(root, files.map((file) => file.pathParts)) };
}

function legacyPaths(skillId: CanonicalSkillId, host: SkillHostId): readonly (readonly string[])[] {
  const operation = skillId === 'governance-assess' ? 'assessment'
    : skillId === 'setup' || skillId === 'repair' ? skillId : undefined;
  return operation === undefined ? [] : [governanceAgentIntegrations[host][operation].pathParts];
}

export async function createSkillDeliveryPlan(
  request: PlanDeliveryOptions, dependencies: SkillPlanningDependencies = {}
): Promise<SkillDeliveryPlan> {
  const options = checkedOptions(request);
  const targetRoot = await canonicalSkillRoot(options.targetRoot);
  const { scope, hosts, intent = 'install' } = options;
  const now = (dependencies.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) throw new Error('The skill review clock is invalid.');
  const start = Math.floor(now.getTime() / REVIEW_WINDOW_MS) * REVIEW_WINDOW_MS;
  const validFrom = new Date(start).toISOString();
  const expiresAt = new Date(start + REVIEW_WINDOW_MS).toISOString();
  const catalog = checkedSkillCatalog(dependencies.loadCatalog);
  const catalogDigest = canonicalSha256(catalog);
  const catalogInputs = await captureCanonicalSkillInputs(catalog, dependencies.catalogRoot);
  const store = await loadOwnershipStore(scope, targetRoot);
  const captured = new Map<string, CapturedSkillFile>();
  const capture = async (parts: readonly string[]): Promise<CapturedSkillFile> => {
    const key = parts.join('/');
    if (!captured.has(key)) captured.set(key, await captureSkillFile(targetRoot, parts));
    return captured.get(key)!;
  };
  const ownership = await capture(skillOwnershipPathParts);
  if (ownership.snapshot.content !== undefined &&
      canonicalJson(store) !== ownership.snapshot.content.toString('utf8')) {
    throw new Error('Skills ownership changed during planning; existing bytes were preserved.');
  }
  const ownershipAuthority = dependencies.ownershipAuthority ?? createSkillsOwnershipAuthorityStore(targetRoot, scope,
    scope === 'user' ? { homedir: targetRoot, env: {}, clock: dependencies.now } : { clock: dependencies.now });
  if (ownership.snapshot.content !== undefined) await verifySkillOwnershipAuthority(store, ownershipAuthority);
  const blockers: string[] = [];
  for (const parts of recoveryPaths) {
    if ((await capture(parts)).observation.state === 'file') {
      blockers.push(`Unfinished transaction or initialization lock blocks skill changes: ${parts.join('/')}. Preserve it and use its registered recovery operation.`);
    }
  }
  const manifestPaths = new Set<string>();
  if (scope === 'project') {
    const manifest = await capture(['liftoff.manifest.json']);
    if (manifest.snapshot.content !== undefined) {
      const { parseManifest } = await import('../project/manifest.js');
      const parsed = parseManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifest.snapshot.content)));
      for (const artifact of [...parsed.managedArtifacts, ...parsed.projectArtifacts]) manifestPaths.add(artifact.pathParts.join('/'));
    }
  }
  const groups = new Map<string, { projection: SkillProjection; selected: SkillHostId[] }>();
  const incompatibleProjections = new Set<string>();
  for (const skill of catalog.skills.filter((entry) => options.skillIds!.includes(entry.id))) {
    for (const host of hosts) {
      if (!skill.supportedHosts.includes(host)) throw new Error(`Canonical skill ${skill.id} does not support selected host ${host}.`);
      const projection = projectSkillForHost(skill, host, scope);
      if (projection.pathParts.join('/') !== registeredSkillPathParts(skill.id, host, scope).join('/') ||
          projection.relativeDestination !== projection.pathParts.join('/') ||
          projection.canonicalHash !== skill.contentHash ||
          projection.contentHash !== sha256Hex(projection.renderedContent)) {
        throw new Error(`Skill projection does not match its registered content/path contract: ${skill.id}/${host}`);
      }
      const existing = groups.get(projection.relativeDestination);
      if (existing) {
        if (intent !== 'remove' && (existing.projection.renderedContent !== projection.renderedContent ||
            existing.projection.canonicalHash !== projection.canonicalHash)) {
          incompatibleProjections.add(projection.relativeDestination);
        }
        existing.selected.push(host);
      } else groups.set(projection.relativeDestination, { projection, selected: [host] });
    }
  }
  const actions: PlannedSkillAction[] = [];
  const projections = new Map<string, SkillProjection>();
  const disclosures = scope === 'user' ? detectOverlappingPersonalRoots(hosts) : [];
  const observingHosts = (action: PlannedSkillAction): SkillHostId[] => SUPPORTED_SKILL_HOSTS.filter((host) =>
    skillDiscoveryPathParts(action.skillId, host, scope).some((parts) => parts.join('/') === action.relativeDestination));
  for (const [destination, { projection, selected }] of groups) {
    projections.set(destination, projection);
    const disk = (await capture(projection.pathParts)).observation;
    const record = store.projections[destination];
    let consumers = record ? [...record.consumers] : [...selected];
    if (intent === 'install') consumers = orderedSkillHosts([...consumers, ...selected]);
    if (intent === 'remove') consumers = record ? record.consumers.filter((host) => !selected.includes(host)) : [];
    const base: PlannedSkillAction = {
      skillId: projection.skillId, host: selected[0], scope, relativeDestination: destination,
      absolutePath: path.join(targetRoot, ...projection.pathParts), action: 'retain', consumers,
      ownershipChanged: false,
      ...(disk.contentHash === undefined ? {} : { existingContentHash: disk.contentHash }),
      ...(disk.mode === undefined ? {} : { existingMode: disk.mode })
    };
    if (incompatibleProjections.has(destination)) {
      actions.push({
        ...base, action: 'blocked',
        reason: 'Selected hosts produce incompatible bytes at this shared physical projection. A compatible registered host projection is required; no copy was chosen.'
      });
      continue;
    }
    if (manifestPaths.has(destination)) {
      actions.push({ ...base, action: 'blocked', reason: 'This exact file belongs to the project manifest. Use its reviewed managed update or a registered transport migration; skills delivery cannot acquire that identity.' });
      continue;
    }
    let legacyConflict: string | undefined;
    if (scope === 'project' && intent !== 'remove') {
      for (const host of selected) {
        for (const parts of legacyPaths(projection.skillId, host)) {
          if (parts.join('/') !== destination && (await capture(parts)).observation.state === 'file') legacyConflict = parts.join('/');
        }
      }
    }
    if (legacyConflict !== undefined) {
      actions.push({ ...base, action: 'blocked', reason: `Existing invocation at ${legacyConflict} must retain its registered identity until a compatible reviewed transport migration exists.` });
    } else if (record && (disk.state !== 'file' || disk.contentHash !== record.projectedContentHash || disk.mode !== record.projectedMode)) {
      actions.push({ ...base, action: 'conflict-modified', reason: 'Managed bytes, mode, or presence changed. Preserve the file and ownership record; no automatic overwrite, restoration, or deletion is authorized.' });
    } else if (intent === 'remove') {
      actions.push(record ? {
        ...base, action: consumers.length ? 'retain' : 'remove',
        ownershipChanged: canonicalJson(consumers) !== canonicalJson(record.consumers),
        reason: consumers.length ? `Retain the physical file for its remaining consumers: ${consumers.join(', ')}.` : 'Remove this exact unchanged managed projection.'
      } : { ...base, reason: 'No selected managed projection is installed; unowned files remain untouched.' });
    } else if (record && intent === 'update' && !selected.some((host) => record.consumers.includes(host))) {
      actions.push({ ...base, reason: 'None of the selected hosts is an installed consumer. Adding a consumer requires install.' });
    } else if (!record && intent === 'update' && disk.state === 'absent') {
      actions.push({ ...base, consumers: [], reason: 'Not installed; update does not acquire new projections or consumers.' });
    } else if (!record && disk.state === 'file' &&
        (intent !== 'install' || disk.contentHash !== projection.contentHash || disk.mode === undefined || (disk.mode & ~0o666) !== 0)) {
      actions.push({ ...base, action: 'collision-unowned', reason: 'An unowned file occupies the destination. Only install can propose exact registered byte-identical adoption; unknown or modified bytes are never overwritten.' });
    } else {
      let incompatibleConsumer = false;
      for (const consumer of consumers) {
        const skill = catalog.skills.find((entry) => entry.id === projection.skillId)!;
        const shared = projectSkillForHost(skill, consumer, scope);
        if (shared.relativeDestination !== destination || shared.renderedContent !== projection.renderedContent) {
          incompatibleConsumer = true;
        }
      }
      if (incompatibleConsumer) {
        actions.push({
          ...base, action: 'blocked',
          reason: 'Installed consumers do not share compatible canonical bytes. Preserve the existing physical projection until a compatible target is registered.'
        });
        continue;
      }
      const targetMode = disk.mode ?? 0o644;
      const action = !record ? disk.state === 'file' ? 'adopt' : 'create'
        : disk.contentHash === projection.contentHash ? 'retain' : 'update';
      actions.push({
        ...base, action, targetContentHash: projection.contentHash, targetMode,
        ownershipChanged: !record || record.projectedContentHash !== projection.contentHash ||
          record.canonicalContentHash !== projection.canonicalHash || record.projectedMode !== targetMode ||
          canonicalJson(consumers) !== canonicalJson(record.consumers),
        reason: action === 'adopt' ? 'Review exact byte-identical adoption of this registered canonical identity; the file itself will not be rewritten.'
          : action === 'retain' ? 'Registered bytes are already current.' : undefined
      });
    }
  }
  if (intent !== 'remove') {
    for (const action of actions) {
      for (const host of observingHosts(action)) {
        for (const parts of skillDiscoveryPathParts(action.skillId, host, scope)) {
          const destination = parts.join('/');
          if (destination === action.relativeDestination) continue;
          const observed = (await capture(parts)).observation;
          const planned = groups.get(destination)?.projection;
          if (observed.state !== 'file' && planned === undefined) continue;
          disclosures.push(`Invocation overlap for ${host}: ${path.join(targetRoot, ...parts)} and ${action.absolutePath}; alternate discovery paths are not delivery ownership.`);
          if ((observed.state === 'file' && observed.contentHash !== action.targetContentHash) ||
              (planned !== undefined && planned.contentHash !== action.targetContentHash)) {
            action.action = 'blocked';
            action.ownershipChanged = false;
            action.reason = `Conflicting host invocation at ${path.join(targetRoot, ...parts)}; preserve the competing projection and resolve discovery before delivery.`;
          }
        }
      }
    }
  }
  const discovery: SkillDeliveryPlan['discovery'][number][] = [];
  if (dependencies.shadowRoot !== undefined) {
    const root = await canonicalSkillRoot(dependencies.shadowRoot);
    if (root !== targetRoot) {
      const external = new Map<string, CapturedSkillFile>();
      for (const action of actions) {
        for (const host of observingHosts(action)) {
          const opposite = scope === 'user' ? 'project' : 'user';
          const paths = [...skillDiscoveryPathParts(action.skillId, host, opposite),
            ...opposite === 'project' ? legacyPaths(action.skillId, host) : []];
          for (const parts of paths) {
            const key = parts.join('/');
            if (!external.has(key)) external.set(key, await captureSkillFile(root, parts));
            const observed = external.get(key)!.observation;
            if (observed.state === 'file') {
              disclosures.push(`Invocation overlap: ${path.join(root, ...parts)} and ${action.absolutePath}; neither discovery root is host-isolated.`);
              if (intent !== 'remove' && observed.contentHash !== action.targetContentHash) {
                action.action = 'blocked';
                action.ownershipChanged = false;
                action.reason = `Conflicting personal/project invocation at ${path.join(root, ...parts)}; resolve discovery before delivery.`;
              }
            }
          }
        }
      }
      discovery.push({
        root, files: [...external.values()].map((entry) => entry.observation),
        directories: await captureSkillDirectories(root, [...external.values()].map((entry) => entry.snapshot.pathParts))
      });
    }
  }
  const summary = {
    create: actions.filter((action) => action.action === 'create').length,
    adopt: actions.filter((action) => action.action === 'adopt').length,
    update: actions.filter((action) => action.action === 'update').length,
    retain: actions.filter((action) => action.action === 'retain').length,
    remove: actions.filter((action) => action.action === 'remove').length,
    ownership: actions.filter((action) => action.ownershipChanged).length,
    blocked: actions.filter((action) => ['blocked', 'collision-unowned', 'conflict-modified'].includes(action.action)).length + blockers.length
  };
  const fields = {
    schemaVersion: 1 as const, kind: 'liftoff-skills-plan' as const, contractVersion: 1 as const,
    cliVersion: liftoffVersion, scope, targetRoot, intent, hosts, skillIds: options.skillIds!,
    catalogVersion: catalog.catalogVersion, catalogDigest, catalogInputs, validFrom, expiresAt,
    actions: actions.map((action) => {
      const { reason, ...rest } = action;
      return reason === undefined ? rest : { ...rest, reason };
    }),
    files: [...captured.values()].map((entry) => entry.observation),
    directories: await captureSkillDirectories(targetRoot, [...captured.values()].map((entry) => entry.snapshot.pathParts),
      [[path.basename(await userScopeMutationLockPath(targetRoot))]]),
    discovery, blockers, overlappingDiscoveryDisclosures: [...new Set(disclosures)],
    hasCollisions: actions.some((action) => action.action === 'collision-unowned'),
    hasConflicts: blockers.length > 0 || actions.some((action) => ['blocked', 'conflict-modified'].includes(action.action)),
    summary
  };
  const plan: SkillDeliveryPlan = freeze({ ...fields, fingerprint: canonicalSha256(fields) });
  knownPlans.set(plan, {
    options: { ...options, targetRoot }, dependencies: { ...dependencies, ownershipAuthority }, store,
    snapshots: [...captured.values()].map((entry) => entry.snapshot), projections
  });
  return plan;
}

export async function recheckSkillDeliveryPlan(plan: SkillDeliveryPlan): Promise<SkillDeliveryPlan> {
  const original = skillPlanState(plan);
  const now = (original.dependencies.now ?? (() => new Date()))();
  if (now.getTime() < Date.parse(plan.validFrom) || now.getTime() >= Date.parse(plan.expiresAt)) {
    throw new Error('Skills plan expired or is not yet valid; review the current operation before approval.');
  }
  const current = await createSkillDeliveryPlan(original.options, original.dependencies);
  if (canonicalJson(current) !== canonicalJson(plan)) {
    throw new Error('Skills plan changed after review (bytes, modes, directories, catalog, consumers, or target). Review a fresh plan.');
  }
  return current;
}

export function buildSkillMutations(plan: SkillDeliveryPlan): {
  mutations: ProjectFileMutation[];
  store: SkillOwnershipStore;
} {
  const prepared = skillPlanState(plan);
  const store = validateOwnershipStore(JSON.parse(canonicalJson(prepared.store)), plan.scope, plan.targetRoot);
  const mutations: ProjectFileMutation[] = [];
  for (const action of plan.actions) {
    const projection = prepared.projections.get(action.relativeDestination)!;
    if (action.action === 'create' || action.action === 'update') {
      mutations.push({ type: 'write', pathParts: [...projection.pathParts], content: projection.renderedContent, mode: action.targetMode });
    } else if (action.action === 'remove') {
      mutations.push({ type: 'delete', pathParts: [...projection.pathParts] });
    }
    if (!action.ownershipChanged) continue;
    const previous = store.projections[action.relativeDestination];
    if (action.action === 'remove') {
      delete store.projections[action.relativeDestination];
    } else {
      const metadataOnly = action.action === 'retain' && plan.intent === 'remove';
      store.projections[action.relativeDestination] = metadataOnly ? {
        ...previous, host: action.consumers[0], consumers: [...action.consumers], updatedByPlan: plan.fingerprint
      } : {
        logicalId: `canonical-skill:${action.skillId}`, skillId: action.skillId, host: action.consumers[0],
        pathParts: [...projection.pathParts], relativeDestination: action.relativeDestination,
        canonicalContentHash: projection.canonicalHash, projectedContentHash: projection.contentHash,
        projectedMode: action.targetMode!, catalogVersion: plan.catalogVersion, catalogDigest: plan.catalogDigest,
        consumers: [...action.consumers], installedByPlan: previous?.installedByPlan ?? plan.fingerprint,
        updatedByPlan: plan.fingerprint
      };
    }
  }
  if (canonicalJson(store) !== canonicalJson(prepared.store)) {
    validateOwnershipStore(store, plan.scope, plan.targetRoot);
    mutations.push({ type: 'write', pathParts: [...skillOwnershipPathParts], content: canonicalJson(store), mode: 0o600 });
  }
  return { mutations, store };
}
