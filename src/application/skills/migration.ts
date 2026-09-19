import path from 'node:path';
import type { LiftoffManifest, ManifestManagedArtifact } from '../../domain/project/contracts.js';
import {
  SUPPORTED_SKILL_HOSTS,
  CANONICAL_SKILL_IDS,
  type CanonicalSkillId,
  type ContextPreservingContinuation,
  type SkillDirectoryObservation,
  type SkillDiscoveryObservation,
  type SkillFileObservation,
  type SkillHostId
} from '../../domain/skills/contracts.js';
import { governanceAgentIntegrations } from '../../domain/project/catalog.js';
import { retiredManagedCoreIdentities } from '../../domain/project/artifact-lifecycle.js';
import { canonicalJson, canonicalSha256, sha256Hex } from '../../domain/governance/activation/canonical-json.js';
import { canonicalSkillRoot, captureSkillDirectories, captureSkillFile } from '../../adapters/skills/discovery.js';
import { projectSkillForHost } from '../../adapters/skills/host-projections.js';
import { loadManifest } from '../project/manifest.js';
import {
  renderAssessmentIntegration, renderRepairIntegration, renderSetupIntegration
} from '../repository-governance/agent-rendering.js';
import { captureCanonicalSkillInputs, checkedSkillCatalog } from './planning.js';
import { orderedSkillHosts } from './ownership.js';
import { isUpdatePlanFingerprint } from '../update/approval.js';
import {
  reviewedAdoptionTransactionPathParts, reviewedRepairTransactionPathParts,
  reviewedSkillsTransactionPathParts, reviewedUpdateTransactionPathParts
} from '../../domain/project/reviewed-update-artifacts.js';

export const retainedSkillTransportPolicy =
  'The current release retains the registered native project integration identities and paths. ' +
  'A standalone canonical projection is not a successor transport. Content changes at a retained path belong to separately reviewed managed update, not transport migration.';

const issuedMigrationPlans = new WeakMap<SkillMigrationPlan, {
  root: string;
  options: SkillMigrationOptions;
  serialized: string;
}>();

export interface LegacyIntegrationEntry {
  host: SkillHostId;
  operation: 'setup' | 'assessment' | 'repair';
  logicalName: string;
  pathParts: readonly string[];
  relativeDestination: string;
  absolutePath: string;
  invocation: string;
  exists: boolean;
  contentHash?: string;
  recordedHash?: string;
  mode?: number;
  ownership: 'unowned' | 'managed' | 'modified' | 'missing';
}

export interface SkillMigrationItem {
  host: SkillHostId;
  skillId: CanonicalSkillId;
  oldPath: string;
  oldLogicalId: string;
  invocation: string;
  action: 'retain' | 'maintenance' | 'blocked';
  transport: 'retained';
  ownership: LegacyIntegrationEntry['ownership'];
  existingContentHash?: string;
  recordedContentHash?: string;
  maintenanceContentHash: string;
  maintenancePath: string;
  maintenanceLogicalId: string;
  standaloneDiscoveryPath?: string;
  reason: string;
}

export interface SkillMigrationOptions {
  hosts: readonly SkillHostId[];
  skillIds?: readonly CanonicalSkillId[];
}

export interface SkillMaintenanceContinuation extends ContextPreservingContinuation {
  capability: 'update';
  commandResultSchema: 3;
  purpose: 'review-managed-maintenance';
  authority: 'separate-reviewed-update';
}

export interface RegisteredSkillAliasTransition {
  host: SkillHostId;
  sourceLogicalId: string;
  sourcePath: string;
  sourceRecordedHash: string;
  sourceContentHash?: string;
  sourceState: 'absent' | 'unchanged' | 'modified';
  targetLogicalId: string;
  targetPath: string;
  owner: 'update';
  status: 'review-update' | 'blocked';
  reason: string;
}

export interface SkillMigrationPlan {
  schemaVersion: 1;
  kind: 'liftoff-skills-migration-plan';
  projectRoot: string;
  hosts: readonly SkillHostId[];
  execution: 'not-required' | 'owning-update-required' | 'blocked';
  transportPolicy: string;
  registeredTransportsDigest: string;
  manifestVersion: number | null;
  catalogDigest: string;
  catalogInputs: SkillDiscoveryObservation;
  items: readonly SkillMigrationItem[];
  registeredTransitions: readonly RegisteredSkillAliasTransition[];
  files: readonly SkillFileObservation[];
  directories: readonly SkillDirectoryObservation[];
  blockers: readonly string[];
  nextActions: readonly SkillMaintenanceContinuation[];
  fingerprint: string;
  summary: { eligible: 0; retained: number; maintenance: number; registeredTransitions: number; blocked: number };
}

async function readLegacyInventory(projectRoot: string, options?: SkillMigrationOptions): Promise<{
  root: string;
  manifest?: LiftoffManifest;
  entries: LegacyIntegrationEntry[];
  files: SkillFileObservation[];
}> {
  const root = await canonicalSkillRoot(projectRoot);
  const manifestFile = await captureSkillFile(root, ['liftoff.manifest.json']);
  let manifest: LiftoffManifest | undefined;
  let managed: readonly ManifestManagedArtifact[] = [];
  if (manifestFile.snapshot.content !== undefined) {
    manifest = await loadManifest(root);
    const after = await captureSkillFile(root, ['liftoff.manifest.json']);
    if (canonicalJson(after.observation) !== canonicalJson(manifestFile.observation)) {
      throw new Error('Project manifest changed during native skill inspection; review the current source.');
    }
    managed = manifest.managedArtifacts;
  }
  const entries: LegacyIntegrationEntry[] = [];
  const files = [manifestFile.observation];
  for (const host of options?.hosts ?? SUPPORTED_SKILL_HOSTS) {
    for (const operation of ['setup', 'assessment', 'repair'] as const) {
      const skillId = operation === 'assessment' ? 'governance-assess' : operation;
      if (options?.skillIds && !options.skillIds.includes(skillId)) continue;
      const spec = governanceAgentIntegrations[host][operation];
      const relativeDestination = spec.pathParts.join('/');
      const file = await captureSkillFile(root, spec.pathParts);
      files.push(file.observation);
      const record = managed.find((artifact) =>
        artifact.logicalName === spec.logicalName && artifact.pathParts.join('/') === relativeDestination);
      const exists = file.observation.state === 'file';
      entries.push({
        host, operation, logicalName: spec.logicalName, pathParts: [...spec.pathParts],
        relativeDestination, absolutePath: path.join(root, ...spec.pathParts), invocation: spec.invocation,
        exists, ownership: !record ? 'unowned' : !exists ? 'missing'
          : record.contentHash === `sha256:${file.observation.contentHash}` ? 'managed' : 'modified',
        ...(file.observation.contentHash === undefined ? {} : { contentHash: file.observation.contentHash }),
        ...(file.observation.mode === undefined ? {} : { mode: file.observation.mode }),
        ...(record === undefined ? {} : { recordedHash: record.contentHash })
      });
    }
  }
  return { root, manifest, entries, files };
}

export async function inspectLegacyIntegrations(projectRoot: string): Promise<readonly LegacyIntegrationEntry[]> {
  return (await readLegacyInventory(projectRoot)).entries;
}

export async function planSkillMigration(
  projectRoot: string, options: SkillMigrationOptions
): Promise<SkillMigrationPlan> {
  if (!options || !Array.isArray(options.hosts) || options.hosts.length === 0 ||
      options.hosts.some((host) => !SUPPORTED_SKILL_HOSTS.includes(host)) ||
      new Set(options.hosts).size !== options.hosts.length) {
    throw new Error('Skill migration inspection requires an explicit supported host selection.');
  }
  if (options.skillIds !== undefined && (!Array.isArray(options.skillIds) || options.skillIds.length === 0 ||
      options.skillIds.some((id) => !CANONICAL_SKILL_IDS.includes(id)) ||
      new Set(options.skillIds).size !== options.skillIds.length)) {
    throw new Error('Skill migration inspection requires exact canonical skill identities.');
  }
  const catalog = checkedSkillCatalog();
  const catalogInputs = await captureCanonicalSkillInputs(catalog);
  const selected: SkillMigrationOptions = {
    hosts: orderedSkillHosts(options.hosts),
    ...(options.skillIds ? { skillIds: CANONICAL_SKILL_IDS.filter((id) => options.skillIds!.includes(id)) } : {})
  };
  const inventory = await readLegacyInventory(projectRoot, selected);
  const files = new Map(inventory.files.map((file) => [file.pathParts.join('/'), file]));
  const config = await captureSkillFile(inventory.root, ['liftoff.config.json']);
  files.set('liftoff.config.json', config.observation);
  const items: SkillMigrationItem[] = [];
  const blockers: string[] = [];
  if (!inventory.manifest) {
    blockers.push('Project transport inspection requires a valid existing Liftoff manifest. File presence is not managed ownership; no project or migration was fabricated.');
  }
  for (const parts of [
    reviewedUpdateTransactionPathParts, reviewedRepairTransactionPathParts,
    reviewedAdoptionTransactionPathParts, reviewedSkillsTransactionPathParts
  ]) {
    const pending = await captureSkillFile(inventory.root, parts);
    files.set(parts.join('/'), pending.observation);
    if (pending.observation.state === 'file') {
      blockers.push(`Existing ${parts.join('/')} requires its original registered recovery before new transport work.`);
    }
  }
  for (const entry of inventory.entries) {
    const skillId = entry.operation === 'assessment' ? 'governance-assess' : entry.operation;
    const projection = projectSkillForHost(catalog.skills.find((skill) => skill.id === skillId)!, entry.host, 'project');
    if (!files.has(projection.relativeDestination)) {
      files.set(projection.relativeDestination, (await captureSkillFile(inventory.root, projection.pathParts)).observation);
    }
    if (!entry.exists && entry.recordedHash === undefined) continue;
    const alternate = projection.relativeDestination !== entry.relativeDestination &&
      files.get(projection.relativeDestination)!.state === 'file';
    const currentContent = `${(entry.operation === 'setup' ? renderSetupIntegration(entry.host)
      : entry.operation === 'assessment' ? renderAssessmentIntegration(entry.host)
        : renderRepairIntegration(entry.host)).trimEnd()}\n`;
    const maintenanceContentHash = sha256Hex(currentContent);
    const blocked = entry.ownership === 'unowned' || entry.ownership === 'modified' || alternate;
    const maintenance = entry.ownership === 'missing' || entry.contentHash !== maintenanceContentHash;
    items.push({
      host: entry.host, skillId, oldPath: entry.relativeDestination, invocation: entry.invocation,
      oldLogicalId: entry.logicalName, transport: 'retained',
      action: blocked ? 'blocked' : maintenance ? 'maintenance' : 'retain', ownership: entry.ownership,
      ...(entry.contentHash === undefined ? {} : { existingContentHash: entry.contentHash }),
      ...(entry.recordedHash === undefined ? {} : { recordedContentHash: entry.recordedHash }),
      maintenanceContentHash, maintenancePath: entry.relativeDestination, maintenanceLogicalId: entry.logicalName,
      ...(alternate ? { standaloneDiscoveryPath: projection.relativeDestination } : {}),
      reason: alternate
        ? `A separate standalone invocation occupies ${projection.relativeDestination}. It is not a registered successor; preserve both copies and resolve discovery before maintenance.`
        : blocked ? `Source is ${entry.ownership}; no migration or overwrite is authorized. ${retainedSkillTransportPolicy}`
          : maintenance ? 'The registered native transport is retained. Its missing or older managed content requires a separate update preview and approval at this same path and logical identity.'
            : 'The registered native path, invocation, logical identity, and managed bytes are current. No transport migration is required.'
    });
  }
  const nextActions: SkillMaintenanceContinuation[] = [];
  const registeredTransitions: RegisteredSkillAliasTransition[] = [];
  if (inventory.manifest && (!selected.skillIds || selected.skillIds.includes('setup'))) {
    for (const host of selected.hosts) {
      const target = governanceAgentIntegrations[host].setup;
      for (const registration of retiredManagedCoreIdentities.filter((entry) => entry.replacementLogicalName === target.logicalName)) {
        const source = inventory.manifest.managedArtifacts.find((entry) =>
          entry.logicalName === registration.logicalName && entry.category === registration.category &&
          entry.pathParts.join('/') === registration.pathParts.join('/'));
        if (!source) continue;
        const observed = await captureSkillFile(inventory.root, source.pathParts);
        files.set(source.pathParts.join('/'), observed.observation);
        const sourceState = observed.observation.state === 'absent' ? 'absent'
          : source.contentHash === `sha256:${observed.observation.contentHash}` ? 'unchanged' : 'modified';
        registeredTransitions.push({
          host, sourceLogicalId: source.logicalName, sourcePath: source.pathParts.join('/'),
          sourceRecordedHash: source.contentHash,
          ...(observed.observation.contentHash ? { sourceContentHash: observed.observation.contentHash } : {}),
          sourceState, targetLogicalId: target.logicalName, targetPath: target.pathParts.join('/'),
          owner: 'update', status: sourceState === 'modified' ? 'blocked' : 'review-update',
          reason: sourceState === 'modified'
            ? 'The exact historically registered alias was modified. It is preserved; skills migration cannot supply force or overwrite permission.'
            : 'This historical alias retirement is already registered with managed update. Its original source record and any applicable successor additions require that command’s complete preview and separate approval.'
        });
      }
    }
  }
  if (inventory.manifest && (items.some((item) => item.action === 'maintenance') ||
      registeredTransitions.some((transition) => transition.status === 'review-update'))) {
    nextActions.push({
      executable: 'liftoff', args: ['update', '--check', '--project', inventory.root, '--json'],
      cwd: inventory.root, scope: 'project', project: inventory.root,
      capability: 'update', commandResultSchema: 3, purpose: 'review-managed-maintenance',
      authority: 'separate-reviewed-update',
      ...(config.observation.contentHash === undefined ? {} : {
        configRef: { path: path.join(inventory.root, 'liftoff.config.json'), digest: config.observation.contentHash }
      })
    });
  }
  const blocked = items.filter((item) => item.action === 'blocked').length +
    registeredTransitions.filter((transition) => transition.status === 'blocked').length + blockers.length;
  const fields = {
    schemaVersion: 1 as const, kind: 'liftoff-skills-migration-plan' as const,
    projectRoot: inventory.root, hosts: selected.hosts,
    execution: blocked ? 'blocked' as const : registeredTransitions.length ? 'owning-update-required' as const : 'not-required' as const,
    transportPolicy: retainedSkillTransportPolicy,
    registeredTransportsDigest: canonicalSha256({ current: governanceAgentIntegrations, retired: retiredManagedCoreIdentities }),
    manifestVersion: inventory.manifest?.artifactVersion ?? null,
    catalogDigest: canonicalSha256(catalog), catalogInputs, items, registeredTransitions, files: [...files.values()],
    directories: await captureSkillDirectories(inventory.root, [...files.values()].map((file) => file.pathParts)),
    blockers, nextActions,
    summary: {
      eligible: 0 as const, blocked, registeredTransitions: registeredTransitions.length,
      retained: items.filter((item) => item.action === 'retain').length,
      maintenance: items.filter((item) => item.action === 'maintenance').length
    }
  };
  const plan: SkillMigrationPlan = { ...fields, fingerprint: canonicalSha256(fields) };
  issuedMigrationPlans.set(plan, {
    root: inventory.root,
    options: { hosts: [...selected.hosts], ...(selected.skillIds ? { skillIds: [...selected.skillIds] } : {}) },
    serialized: canonicalJson(plan)
  });
  return plan;
}

export interface SkillMigrationBlockedResult {
  ok: false;
  outcome: 'blocked';
  committed: false;
  uncertain: false;
  migratedCount: 0;
  reason: string;
}

export interface SkillMigrationUnneededResult {
  ok: true;
  outcome: 'not-required';
  committed: false;
  uncertain: false;
  migratedCount: 0;
  reason: string;
}

export interface SkillMigrationUpdateRequiredResult {
  ok: false;
  outcome: 'owning-update-required';
  committed: false;
  uncertain: false;
  migratedCount: 0;
  reason: string;
}

export async function executeSkillMigration(
  plan: SkillMigrationPlan, options: { approvePlan?: string } = {}
): Promise<SkillMigrationBlockedResult | SkillMigrationUnneededResult | SkillMigrationUpdateRequiredResult> {
  if (Object.keys(options).some((key) => key !== 'approvePlan') ||
      options.approvePlan !== undefined && !isUpdatePlanFingerprint(options.approvePlan)) {
    throw new Error('Skill migration accepts only a complete lowercase --approve-plan fingerprint; generic Yes is not authority.');
  }
  const issued = issuedMigrationPlans.get(plan);
  if (!issued) throw new Error('Skill transport inspection must come from the current planner, not a supplied plan document.');
  if (canonicalJson(plan) !== issued.serialized) throw new Error('Skill transport inspection was modified after review.');
  const current = await planSkillMigration(issued.root, issued.options);
  if (canonicalJson(current) !== canonicalJson(plan)) {
    throw new Error('Project skill transport observations changed; review the current inventory before continuing.');
  }
  if (options.approvePlan !== undefined && options.approvePlan !== plan.fingerprint) {
    throw new Error('Skill transport fingerprint does not match this exact current inspection.');
  }
  if (plan.execution === 'not-required') {
    return {
      ok: true, outcome: 'not-required', committed: false, uncertain: false, migratedCount: 0,
      reason: retainedSkillTransportPolicy
    };
  }
  if (plan.execution === 'owning-update-required') {
    return {
      ok: false, outcome: 'owning-update-required', committed: false, uncertain: false, migratedCount: 0,
      reason: 'Use the existing managed-update transition and its own exact review/approval. A skills inspection fingerprint does not authorize that operation.'
    };
  }
  return {
    ok: false, outcome: 'blocked', committed: false, uncertain: false, migratedCount: 0,
    reason: [
      ...plan.blockers, ...plan.items.filter((item) => item.action === 'blocked').map((item) => item.reason),
      ...plan.registeredTransitions.filter((transition) => transition.status === 'blocked').map((transition) => transition.reason)
    ].join(' ')
  };
}
