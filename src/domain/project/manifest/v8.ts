import { createModernActivationIdentityReader } from '../../governance/activation/modern-identity.js';
import type { ModernActivationSourceContract, ModernGovernanceProfile, ReadableModernActivationIdentity } from '../../governance/activation/modern-record-contracts.js';
import type { ManifestActiveLayout, ManifestLayoutDescriptor, ManifestManagedArtifact, ManifestProjectArtifact } from '../contracts.js';
import { isRetiredManagedCoreLogicalName } from '../artifact-lifecycle.js';
import { FileSystemError } from '../errors.js';
import { isRetiredPowerAppsWorkload, retiredPowerAppsMessage } from '../retired-workload.js';
import { createManifestArtifactReader } from './artifacts.js';
import type { ManifestContractContext } from './context.js';
import { denseArray, exactRecord, isRecord, requiredString, SEMVER_PATTERN } from './fields.js';
import { validateManifestSourceHistoryReference, type ManifestSourceHistoryReference } from './history.js';
import { validateActivationTargetHistoryReference, type ActivationTargetHistoryReference } from './activation-target-history.js';
import { manifestActiveLayoutDigest, manifestLayoutBounds, manifestPathAliasKey, validateManifestActiveLayout, validateManifestPathParts } from './layout.js';
import { manifestPluginMetadataMatches, readManifestPluginMetadata, type ManifestPluginMetadata } from './plugins.js';
import { createManifestV8ProjectReader, type ManifestV8ProjectLeaf } from './v8-project.js';

export const manifestV8ProvenanceMaximumEntries = 16_384;

export interface ManifestAdoptionObservation {
  readonly logicalName: string;
  readonly pathParts: readonly string[];
  readonly observedHash: `sha256:${string}`;
}

export type ManifestV8Governance =
  | { readonly profile: 'none'; readonly state: 'disabled' }
  | {
      readonly profile: ModernGovernanceProfile;
      readonly policyVersion: string;
      readonly state: 'handoff-generated' | 'handoff-partial';
      readonly activationIdentity: ReadableModernActivationIdentity;
    };

type ReadonlyArtifact<T extends { pathParts: string[] }> = Readonly<Omit<T, 'pathParts'>> & {
  readonly pathParts: readonly string[];
};

export type LiftoffManifestV8 = ManifestV8ProjectLeaf & {
  readonly artifactVersion: 8;
  readonly generatedBy: 'Mission Control Liftoff';
  readonly liftoffVersion: string;
  readonly governance: ManifestV8Governance;
  readonly plugins: ManifestPluginMetadata;
  readonly activeLayout: ManifestActiveLayout;
  readonly managedArtifacts: readonly ReadonlyArtifact<ManifestManagedArtifact>[];
  readonly projectArtifacts: readonly ReadonlyArtifact<ManifestProjectArtifact>[];
  readonly adoptionObservations: readonly ManifestAdoptionObservation[];
  readonly sourceManifestHistory?: ManifestSourceHistoryReference;
  readonly activationTargetHistory?: ActivationTargetHistoryReference;
};

export interface ManifestV8SourceContract {
  readonly plugins: ManifestPluginMetadata;
  readonly layoutDescriptor: ManifestLayoutDescriptor;
  readonly managedArtifacts: readonly {
    readonly logicalName: string;
    readonly category: string;
    readonly pathParts: readonly string[];
  }[];
  readonly requiredHandoffLogicalNames: readonly string[];
  readonly readableProjectLogicalNames: readonly string[];
  readonly governanceSource: ModernActivationSourceContract | { readonly profile: 'none' };
}

export interface ManifestV8ReaderContext {
  readonly catalog: ManifestContractContext['catalog'];
  resolveSourceContract(input: {
    readonly selection: ManifestV8ProjectLeaf & { readonly profile: 'none' | ModernGovernanceProfile };
    readonly recordedPlugins: ManifestPluginMetadata;
  }): ManifestV8SourceContract;
}

function ownValue(value: unknown, key: string): unknown {
  return isRecord(value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
}

function pathParts(value: unknown, scope: string): readonly string[] {
  return validateManifestPathParts(denseArray(value, manifestLayoutBounds.pathParts, scope), scope);
}

function artifactRecords(value: unknown, fields: readonly string[], maximum: number, scope: string) {
  return denseArray(value, maximum, scope).map((entry, index) => {
    const record = exactRecord(entry, fields, `${scope}[${index}]`);
    return { ...record, pathParts: pathParts(record.pathParts, `${scope}[${index}].pathParts`) };
  });
}

function validateInventoryPaths(
  entries: readonly { readonly logicalName: string; readonly pathParts: readonly string[] }[],
  scope: string
): void {
  const names = new Set<string>();
  const files = new Set<string>();
  const spellings = new Map<string, string>();
  for (const entry of entries) {
    const key = manifestPathAliasKey(entry.pathParts);
    if (names.has(entry.logicalName) || files.has(key)) {
      throw new FileSystemError(`${scope} contains a duplicate logical identity or aliased artifact path.`);
    }
    if (key === 'governance/activation-baseline.json') {
      throw new FileSystemError('governance/activation-baseline.json cannot be a manifest artifact or observation.');
    }
    names.add(entry.logicalName);
    files.add(key);
    for (let length = 1; length <= entry.pathParts.length; length += 1) {
      const prefix = entry.pathParts.slice(0, length);
      const folded = manifestPathAliasKey(prefix), spelling = prefix.join('/');
      const previous = spellings.get(folded);
      if (previous !== undefined && previous !== spelling) {
        throw new FileSystemError(`${scope} contains aliased path spelling.`);
      }
      spellings.set(folded, spelling);
    }
  }
  for (const entry of entries) {
    for (let length = 1; length < entry.pathParts.length; length += 1) {
      if (files.has(manifestPathAliasKey(entry.pathParts.slice(0, length)))) {
        throw new FileSystemError(`${scope} contains a file-prefix conflict.`);
      }
    }
  }
}

function strictLayoutInput(value: unknown, descriptor: ManifestLayoutDescriptor) {
  const layout = exactRecord(value, ['schemaVersion', 'state', 'bindings'], 'Manifest.activeLayout');
  const bindings = denseArray(layout.bindings, descriptor.components.length + descriptor.artifacts.length,
    'Manifest.activeLayout.bindings').map((value, index) => {
    const scope = `Manifest.activeLayout.bindings[${index}]`;
    const kind = ownValue(value, 'kind');
    const entry = exactRecord(value, kind === 'component'
      ? ['kind', 'component', 'pathParts'] : ['kind', 'logicalName', 'pathParts'], scope);
    return { ...entry, pathParts: pathParts(entry.pathParts, `${scope}.pathParts`) };
  });
  return { ...layout, bindings };
}

function freezeArtifacts<T extends { pathParts: string[] }>(entries: readonly T[]): readonly ReadonlyArtifact<T>[] {
  return Object.freeze(entries.map((entry) => Object.freeze({ ...entry, pathParts: Object.freeze([...entry.pathParts]) })));
}

/** Complete source-schema validation; storage truth, installed-target support and approval remain separate. */
export function createManifestV8Reader(context: ManifestV8ReaderContext) {
  const projectReader = createManifestV8ProjectReader(context.catalog);
  const artifacts = createManifestArtifactReader(context.catalog);
  const activationReader = createModernActivationIdentityReader(context.catalog);

  function parseManifestV8(value: unknown): LiftoffManifestV8 {
    const kind = ownValue(ownValue(ownValue(value, 'project'), 'workload'), 'kind');
    if (typeof kind === 'string' && isRetiredPowerAppsWorkload(kind)) {
      throw new FileSystemError(retiredPowerAppsMessage(kind));
    }
    const root = exactRecord(value, [
      'artifactVersion', 'generatedBy', 'liftoffVersion', 'project', 'framework', 'governance',
      'plugins', 'activeLayout', 'managedArtifacts', 'projectArtifacts', 'adoptionObservations',
      ...(isRecord(value) && Object.hasOwn(value, 'sourceManifestHistory') ? ['sourceManifestHistory'] : []),
      ...(isRecord(value) && Object.hasOwn(value, 'activationTargetHistory') ? ['activationTargetHistory'] : [])
    ], 'Manifest v8');
    if (root.artifactVersion !== 8 || root.generatedBy !== 'Mission Control Liftoff') {
      throw new FileSystemError('Manifest v8 requires artifactVersion 8 and generatedBy "Mission Control Liftoff".');
    }
    const liftoffVersion = requiredString(root, 'liftoffVersion', 'Manifest');
    const prerelease = liftoffVersion.match(/^[^-]*-([^+]+)/)?.[1];
    if (!SEMVER_PATTERN.test(liftoffVersion) || prerelease?.split('.').some((part) => /^0\d+$/.test(part))) {
      throw new FileSystemError('Manifest liftoffVersion must be an exact semantic version.');
    }
    const leaf = projectReader.validateManifestV8Project({ project: root.project, framework: root.framework });
    const profile = ownValue(root.governance, 'profile');
    if (profile !== 'none' && profile !== 'single-maintainer-gitflow' && profile !== 'team-gitflow') {
      throw new FileSystemError('Manifest v8 governance requires an explicit recognized profile.');
    }
    const envelope = exactRecord(root.governance, profile === 'none' ? ['profile', 'state'] :
      ['profile', 'policyVersion', 'state', 'activationIdentity'], 'Manifest.governance');
    const plugins = readManifestPluginMetadata(root.plugins, {
      stack: leaf.project.workload.apiStack, cloud: leaf.project.workload.cloud,
      workflow: leaf.project.specWorkflow, agents: leaf.project.agents
    });
    const source = context.resolveSourceContract({ selection: { ...leaf, profile }, recordedPlugins: plugins });
    if (!manifestPluginMetadataMatches(plugins, source.plugins)) {
      throw new FileSystemError('Manifest plugins do not match the complete resolved source contract.');
    }
    const activeLayout = validateManifestActiveLayout(strictLayoutInput(root.activeLayout, source.layoutDescriptor), source.layoutDescriptor);
    const managedArtifacts = artifacts.normalizeManifestManagedArtifacts(artifactRecords(
      root.managedArtifacts, ['logicalName', 'category', 'pathParts', 'contentHash'],
      source.managedArtifacts.length, 'Manifest.managedArtifacts'), 'Manifest.managedArtifacts');
    const projectArtifacts = artifacts.normalizeManifestProjectArtifacts(artifactRecords(root.projectArtifacts, [
      'logicalName', 'category', 'pathParts', 'generatedBy', 'generationHash', 'provisioningGroup'
    ], manifestV8ProvenanceMaximumEntries, 'Manifest.projectArtifacts'));
    artifacts.validateV6AndV7ArtifactAuthority(managedArtifacts, projectArtifacts);
    const declaredManaged = new Map(source.managedArtifacts.map((entry) => [entry.logicalName, entry]));
    for (const entry of managedArtifacts) {
      const declared = declaredManaged.get(entry.logicalName);
      if (isRetiredManagedCoreLogicalName(entry.logicalName) || !declared ||
        declared.category !== entry.category || declared.pathParts.join('\0') !== entry.pathParts.join('\0')) {
        throw new FileSystemError(`Manifest managed artifact ${entry.logicalName} is not an exact applicable current source declaration.`);
      }
    }
    const readableNames = new Set(source.readableProjectLogicalNames);
    const adoptionObservations = artifactRecords(root.adoptionObservations, ['logicalName', 'pathParts', 'observedHash'],
      manifestV8ProvenanceMaximumEntries, 'Manifest.adoptionObservations').map((record, index): ManifestAdoptionObservation => {
      const scope = `Manifest.adoptionObservations[${index}]`;
      const logicalName = requiredString(record, 'logicalName', scope);
      if (!readableNames.has(logicalName) || declaredManaged.has(logicalName)) {
        throw new FileSystemError(`${scope}.logicalName is not a finite readable project identity.`);
      }
      const observedHash = requiredString(record, 'observedHash', scope);
      if (!isObservedHash(observedHash)) throw new FileSystemError(`${scope}.observedHash must be a sha256-prefixed lowercase 64-hex digest.`);
      return Object.freeze({ logicalName, pathParts: record.pathParts, observedHash });
    });
    // Each provenance collection describes its own past observations, not current path ownership.
    validateInventoryPaths(managedArtifacts, 'Manifest.managedArtifacts');
    validateInventoryPaths(projectArtifacts, 'Manifest.projectArtifacts');
    validateInventoryPaths(adoptionObservations, 'Manifest.adoptionObservations');
    let governance: ManifestV8Governance;
    if (profile === 'none') {
      if (envelope.state !== 'disabled' || !('profile' in source.governanceSource) ||
        source.governanceSource.profile !== 'none' || source.requiredHandoffLogicalNames.length !== 0) {
        throw new FileSystemError('Governance none requires disabled state and a source with no governance handoff.');
      }
      governance = Object.freeze({ profile, state: 'disabled' });
    } else {
      const policyVersion = requiredString(envelope, 'policyVersion', 'Manifest.governance');
      if (envelope.state !== 'handoff-generated' && envelope.state !== 'handoff-partial') {
        throw new FileSystemError('Enabled governance requires handoff-generated or handoff-partial state.');
      }
      if (!('identity' in source.governanceSource) ||
        source.governanceSource.identity.profile !== profile ||
        source.governanceSource.identity.workflow !== leaf.project.specWorkflow ||
        source.governanceSource.identity.policyVersion !== policyVersion) {
        throw new FileSystemError('Manifest governance does not match the declared policy/profile/workflow source.');
      }
      const owned = new Set(managedArtifacts.map((entry) => entry.logicalName));
      const missing = source.requiredHandoffLogicalNames.filter((name) => !owned.has(name));
      if (envelope.state === 'handoff-generated' && missing.length ||
        envelope.state === 'handoff-partial' && missing.length === 0) {
        throw new FileSystemError('Manifest governance handoff state does not match its actual owned handoff inventory.');
      }
      const activationIdentity = activationReader.validateReadableModernActivationIdentity({
        recordedIdentity: envelope.activationIdentity, profile, policyVersion, selection: { ...leaf, profile },
        pluginResolutionDigest: plugins.resolutionDigest,
        activeLayoutDigest: manifestActiveLayoutDigest(activeLayout, source.layoutDescriptor)
      });
      if (activationIdentity.phaseGraphHash !== source.governanceSource.identity.phaseGraphHash ||
        activationIdentity.policyDigest !== source.governanceSource.identity.policyDigest) {
        throw new FileSystemError('Manifest activation graph and policy do not match the resolved source contract.');
      }
      governance = Object.freeze({ profile, policyVersion, state: envelope.state, activationIdentity });
    }
    const sourceManifestHistory = Object.hasOwn(root, 'sourceManifestHistory')
      ? validateManifestSourceHistoryReference(root.sourceManifestHistory) : undefined;
    const activationTargetHistory = Object.hasOwn(root, 'activationTargetHistory')
      ? validateActivationTargetHistoryReference(root.activationTargetHistory) : undefined;
    if (activationTargetHistory && (governance.profile === 'none' || sourceManifestHistory?.kind !== 'activation-history')) {
      throw new FileSystemError('Original activation target history requires an enabled activation-history successor.');
    }
    return Object.freeze({
      artifactVersion: 8, generatedBy: 'Mission Control Liftoff', liftoffVersion,
      ...leaf, governance, plugins, activeLayout,
      managedArtifacts: freezeArtifacts(managedArtifacts),
      projectArtifacts: freezeArtifacts(projectArtifacts),
      adoptionObservations: Object.freeze(adoptionObservations),
      ...(sourceManifestHistory ? { sourceManifestHistory } : {}),
      ...(activationTargetHistory ? { activationTargetHistory } : {})
    });
  }

  return { parseManifestV8 };
}

function isObservedHash(value: string): value is `sha256:${string}` {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}
