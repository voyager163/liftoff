import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { liftoffVersion } from '../../version.js';
import { canonicalJson } from '../../domain/governance/activation/canonical-json.js';
import { createModernActivationIdentityReader } from '../../domain/governance/activation/modern-identity.js';
import type { ModernGovernanceProfile } from '../../domain/governance/activation/modern-record-contracts.js';
import { isRetiredManagedCoreArtifactIdentity } from '../../domain/project/artifact-lifecycle.js';
import type { GeneratedArtifact, HistoricalLiftoffManifest, ManifestActiveLayout } from '../../domain/project/contracts.js';
import { FileSystemError } from '../../domain/project/errors.js';
import { toSafeProjectName } from '../../domain/project/planning.js';
import { denseArray, exactRecord, isRecord, requiredString } from '../../domain/project/manifest/fields.js';
import { manifestHistoryMaximumSourceBytes, validateManifestSourceHistoryReference, type ManifestSourceHistoryReference } from '../../domain/project/manifest/history.js';
import { validateActivationTargetHistoryReference, type ActivationTargetHistoryReference } from '../../domain/project/manifest/activation-target-history.js';
import { manifestActiveLayoutDigest, validateManifestActiveLayout } from '../../domain/project/manifest/layout.js';
import { readManifestPluginMetadata } from '../../domain/project/manifest/plugins.js';
import { createManifestV8Reader, type LiftoffManifestV8, type ManifestAdoptionObservation } from '../../domain/project/manifest/v8.js';
import { createManifestV8ProjectReader, type ManifestV8ProjectLeaf } from '../../domain/project/manifest/v8-project.js';
import { projectCatalog } from './catalog.js';
import { freshActiveLayoutForComposition, parseManifest, resolveModernManifestV8SourceContract } from './manifest.js';
import { composeModernManifestPlugins, type ExpectedArtifact } from './plugins.js';

export type ManagedManifestDecision =
  | {
      readonly kind: 'bytes';
      readonly logicalName: string;
      readonly category: string;
      readonly pathParts: readonly string[];
      readonly content: string;
    }
  | { readonly kind: 'retain'; readonly logicalName: string }
  | { readonly kind: 'retire'; readonly logicalName: string }
  | { readonly kind: 'retire-alias'; readonly logicalName: string };

export type ManifestV8WriteRequest =
  | {
      readonly origin: 'fresh';
      readonly selection: ManifestV8ProjectLeaf & { readonly profile: 'none' | ModernGovernanceProfile };
      readonly generatedArtifacts: readonly GeneratedArtifact[];
      readonly activeLayout?: ManifestActiveLayout;
    }
  | {
      readonly origin: 'adoption';
      readonly selection: ManifestV8ProjectLeaf & { readonly profile: 'none' | ModernGovernanceProfile };
      readonly activeLayout: ManifestActiveLayout;
      readonly managed: readonly Extract<ManagedManifestDecision, { readonly kind: 'bytes' }>[];
      readonly adoptionObservations: readonly ManifestAdoptionObservation[];
    }
  | {
      readonly origin: 'historical-successor';
      readonly source: unknown;
      readonly profile: 'none' | 'single-maintainer-gitflow';
      readonly activeLayout: ManifestActiveLayout;
      readonly sourceManifestHistory: ManifestSourceHistoryReference;
      readonly managed: readonly ManagedManifestDecision[];
    }
  | {
      readonly origin: 'maintenance'; readonly source: unknown; readonly managed: readonly ManagedManifestDecision[];
      readonly activationTargetHistory?: ActivationTargetHistoryReference;
    }
  | {
      readonly origin: 'workflow-transition';
      readonly source: unknown;
      readonly selection: ManifestV8ProjectLeaf & {
        readonly profile: 'none' | ModernGovernanceProfile;
      };
      readonly activeLayout: ManifestActiveLayout;
      readonly managed: readonly ManagedManifestDecision[];
    };

export interface ManifestV8Candidate {
  readonly manifest: LiftoffManifestV8;
  readonly content: string;
  readonly digest: string;
}

const hash = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');
const projectReader = createManifestV8ProjectReader(projectCatalog);
const rootReader = createManifestV8Reader({ catalog: projectCatalog, resolveSourceContract: resolveModernManifestV8SourceContract });
const identityReader = createModernActivationIdentityReader(projectCatalog);

// Copy JSON data without invoking hooks before handing it to the historical parsed-JSON reader.
function sourceData(value: unknown): unknown {
  let remainingBytes = manifestHistoryMaximumSourceBytes;
  let remainingNodes = 1_048_576;
  const spend = (bytes: number) => {
    remainingBytes -= bytes;
    if (remainingBytes < 0) throw new FileSystemError('Source manifest exceeds the 8 MiB JSON input bound.');
  };
  function copy(value: unknown, depth: number): unknown {
    if (types.isProxy(value)) throw new FileSystemError('Source manifest cannot contain proxies.');
    if (depth > 64 || --remainingNodes < 0) throw new FileSystemError('Source manifest exceeds the bounded JSON depth or node count.');
    if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
      typeof value === 'number' && Number.isFinite(value)) {
      spend(Buffer.byteLength(JSON.stringify(value), 'utf8'));
      return value;
    }
    if (Array.isArray(value)) {
      const entries = denseArray(value, remainingNodes, 'Source manifest array');
      spend(2 + Math.max(0, entries.length - 1));
      return entries.map((entry) => copy(entry, depth + 1));
    }
    if (!isRecord(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      throw new FileSystemError('Source manifest must contain only plain own-data JSON values.');
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > remainingNodes) throw new FileSystemError('Source manifest exceeds the bounded JSON node count.');
    spend(2 + Math.max(0, keys.length - 1));
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string') throw new FileSystemError('Source manifest cannot contain symbol fields.');
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || !property.enumerable || !Object.hasOwn(property, 'value')) {
        throw new FileSystemError('Source manifest requires own enumerable data fields.');
      }
      spend(Buffer.byteLength(JSON.stringify(key), 'utf8') + 1);
      result[key] = copy(property.value, depth + 1);
    }
    return result;
  }
  return copy(value, 0);
}

function targetFor(
  leaf: ManifestV8ProjectLeaf, profile: 'none' | ModernGovernanceProfile,
  recordedPlugins?: LiftoffManifestV8['plugins']
) {
  const workload = leaf.project.workload;
  const composition = composeModernManifestPlugins({
    workload: workload.kind, ...(workload.kind === 'genai' ? { variant: workload.pattern } : {}),
    stack: workload.apiStack, cloud: workload.cloud, workflow: leaf.project.specWorkflow,
    agents: leaf.project.agents, frontend: workload.frontend ? 'included' : 'omitted',
    governanceProfile: profile, environments: workload.environments
  }, { safeProjectName: toSafeProjectName(leaf.project.name) });
  const plugins = recordedPlugins ?? readManifestPluginMetadata({
    schemaVersion: 1, resolutionDigest: composition.resolution.digest, selections: composition.resolution.plugins
  }, { stack: workload.apiStack, cloud: workload.cloud, workflow: leaf.project.specWorkflow, agents: leaf.project.agents });
  const source = resolveModernManifestV8SourceContract({ selection: { ...leaf, profile }, recordedPlugins: plugins });
  const staticHashes = new Map<string, string>();
  if ('identity' in source.governanceSource) {
    staticHashes.set('repository-governance-policy', source.governanceSource.identity.policyDigest);
    staticHashes.set('repository-governance-phase-graph', `sha256:${hash(canonicalJson(source.governanceSource.graph))}`);
  }
  return { composition, source, plugins, staticHashes };
}

function contentReader() {
  let remaining = 32 * 1024 * 1024;
  return (value: unknown): string => {
    if (typeof value !== 'string') throw new FileSystemError('Manifest artifact content must be a string.');
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > 8 * 1024 * 1024 || (remaining -= bytes) < 0) {
      throw new FileSystemError('Manifest artifact bytes exceed the 8 MiB per-file or 32 MiB aggregate bound.');
    }
    return value;
  };
}

function exactArtifactIdentity<T extends Pick<ExpectedArtifact, 'category' | 'pathParts'>>(
  record: Record<string, unknown>, declared: T | undefined
): T {
  if (!declared || record.category !== declared.category) {
    throw new FileSystemError('Manifest artifact is not an exact applicable target declaration.');
  }
  const parts = denseArray(record.pathParts, 32, 'Manifest artifact path');
  if (parts.length !== declared.pathParts.length || parts.some((part, index) => part !== declared.pathParts[index])) {
    throw new FileSystemError('Manifest artifact path does not match its exact target declaration.');
  }
  return declared;
}

function assertStaticHash(logicalName: string, contentHash: string, staticHashes: ReadonlyMap<string, string>): void {
  const expected = staticHashes.get(logicalName);
  if (expected !== undefined && expected !== contentHash) {
    throw new FileSystemError(`Manifest ${logicalName} bytes or retained hash do not match the actual modern static source.`);
  }
}

function generatedInput(value: unknown, expected: readonly ExpectedArtifact[]): GeneratedArtifact[] {
  const byName = new Map(expected.map((entry) => [entry.logicalName, entry]));
  const content = contentReader();
  const names = new Set<string>();
  return denseArray(value, expected.length - 1, 'Fresh generated artifacts').map((entry): GeneratedArtifact => {
    const lifecycle = isRecord(entry) ? Object.getOwnPropertyDescriptor(entry, 'lifecycle')?.value : undefined;
    const record = exactRecord(entry, [
      'logicalName', 'category', 'pathParts', 'content', 'lifecycle', ...(lifecycle === 'project' ? ['provisioningGroup'] : [])
    ], 'Fresh generated artifact');
    const name = requiredString(record, 'logicalName', 'Fresh generated artifact');
    if (name === 'manifest' || names.has(name)) throw new FileSystemError('Fresh artifacts cannot include a manifest override or duplicate identity.');
    names.add(name);
    const declared = exactArtifactIdentity(record, byName.get(name));
    if (record.lifecycle !== declared.lifecycle || declared.lifecycle === 'manifest') {
      throw new FileSystemError('Fresh artifact lifecycle does not match its exact declaration.');
    }
    const common = { logicalName: name, category: declared.category, pathParts: [...declared.pathParts], content: content(record.content) };
    if (declared.lifecycle === 'project') {
      if (!declared.provisioningGroup || record.provisioningGroup !== declared.provisioningGroup) {
        throw new FileSystemError('Fresh project artifact provisioning group does not match its declaration.');
      }
      return { ...common, lifecycle: 'project', provisioningGroup: declared.provisioningGroup };
    }
    return { ...common, lifecycle: declared.lifecycle };
  });
}

function managedInput(
  value: unknown,
  origin:
    | 'adoption'
    | 'historical-successor'
    | 'maintenance'
    | 'workflow-transition',
  source: HistoricalLiftoffManifest | LiftoffManifestV8 | undefined,
  target: ReturnType<typeof targetFor>
) {
  if (!source && origin !== 'adoption') throw new FileSystemError('Managed maintenance requires its actual source manifest.');
  const previous = new Map(source?.managedArtifacts.map((entry) => [entry.logicalName, entry]) ?? []);
  const declared = new Map(target.source.managedArtifacts.map(entry => [entry.logicalName, entry]));
  const names = new Set<string>();
  const content = contentReader();
  const entries = denseArray(value, previous.size + declared.size, 'Managed manifest decisions').flatMap((entry) => {
    const kind = isRecord(entry) ? Object.getOwnPropertyDescriptor(entry, 'kind')?.value : undefined;
    const record = exactRecord(entry, kind === 'bytes'
      ? ['kind', 'logicalName', 'category', 'pathParts', 'content'] : ['kind', 'logicalName'], 'Managed manifest decision');
    const name = requiredString(record, 'logicalName', 'Managed manifest decision');
    if (names.has(name)) throw new FileSystemError('Managed manifest decisions contain a duplicate identity.');
    names.add(name);
    const old = previous.get(name);
    if (record.kind === 'retire') {
      if (origin !== 'workflow-transition' || !old || declared.has(name)) {
        throw new FileSystemError(
          'Workflow transition retirement requires an exact source-only managed identity.'
        );
      }
      return [];
    }
    if (record.kind === 'retire-alias') {
      if (origin !== 'historical-successor' || !old ||
        !isRetiredManagedCoreArtifactIdentity(name, old.category, old.pathParts)) {
        throw new FileSystemError('Only an exact existing historical setup alias may receive retire-alias disposition.');
      }
      return [];
    }
    if (record.kind === 'retain') {
      if (!old) throw new FileSystemError('Retain requires an existing source managed identity.');
      exactArtifactIdentity({ category: old.category, pathParts: old.pathParts }, declared.get(name));
      assertStaticHash(name, old.contentHash, target.staticHashes);
      return [{ ...old, pathParts: [...old.pathParts] }];
    }
    if (record.kind !== 'bytes') throw new FileSystemError('Unknown managed manifest decision kind.');
    const identity = exactArtifactIdentity(record, declared.get(name));
    const contentHash = `sha256:${hash(content(record.content))}`;
    assertStaticHash(name, contentHash, target.staticHashes);
    return [{ logicalName: name, category: identity.category, pathParts: [...identity.pathParts], contentHash }];
  });
  for (const name of previous.keys()) {
    if (!names.has(name)) throw new FileSystemError(`Source managed artifact ${name} requires an explicit disposition.`);
  }
  const byName = new Map(entries.map((entry) => [entry.logicalName, entry]));
  return target.source.managedArtifacts.flatMap((entry) => {
    const selected = byName.get(entry.logicalName);
    return selected ? [selected] : [];
  });
}

function adoptionInput(value: unknown, target: ReturnType<typeof targetFor>) {
  return denseArray(sourceData(value), target.source.layoutDescriptor.artifacts.length, 'Adoption observations')
    .map((entry) => {
      const record = exactRecord(entry, ['logicalName', 'pathParts', 'observedHash'], 'Adoption observation');
      return { ...record, logicalName: requiredString(record, 'logicalName', 'Adoption observation') };
    })
    .sort((left, right) => left.logicalName < right.logicalName ? -1 : left.logicalName > right.logicalName ? 1 : 0);
}

function assertAdoptionBindings(manifest: LiftoffManifestV8): void {
  if (manifest.activeLayout.state !== 'bound') {
    throw new FileSystemError('Adoption requires explicit bound current paths; unresolved layout is not compatibility.');
  }
  const artifacts = manifest.activeLayout.bindings.filter((binding) => binding.kind === 'artifact');
  const observed = new Map(manifest.adoptionObservations.map((entry) => [entry.logicalName, entry]));
  if (artifacts.length === 0 || artifacts.length !== observed.size) {
    throw new FileSystemError('Adoption requires one exact observation for every bound artifact and no unbound observations.');
  }
  for (const binding of artifacts) {
    const observation = observed.get(binding.logicalName);
    if (!observation || binding.pathParts.join('\0') !== observation.pathParts.join('\0')) {
      throw new FileSystemError(`Adoption observation ${binding.logicalName} must match its exact active path.`);
    }
  }
}

/** Produces reviewed-candidate data only; caller eligibility, source-history truth and publication are separate. */
export function createManifestV8Candidate(input: unknown): ManifestV8Candidate {
  if (types.isProxy(input)) throw new FileSystemError('Manifest writer request cannot be a proxy.');
  const origin = isRecord(input) ? Object.getOwnPropertyDescriptor(input, 'origin')?.value : undefined;
  if (origin !== 'fresh' && origin !== 'adoption' &&
      origin !== 'historical-successor' && origin !== 'maintenance' &&
      origin !== 'workflow-transition') {
    throw new FileSystemError(
      'Manifest writer requires explicit fresh, adoption, historical-successor, maintenance or workflow-transition origin.'
    );
  }
  const request = exactRecord(input, origin === 'fresh' ? [
    'origin', 'selection', 'generatedArtifacts',
    ...(isRecord(input) && Object.hasOwn(input, 'activeLayout') ? ['activeLayout'] : [])
  ] : origin === 'adoption' ? ['origin', 'selection', 'activeLayout', 'managed', 'adoptionObservations'] :
    origin === 'historical-successor' ? ['origin', 'source', 'profile', 'activeLayout', 'sourceManifestHistory', 'managed'] :
      origin === 'workflow-transition'
        ? ['origin', 'source', 'selection', 'activeLayout', 'managed']
        : ['origin', 'source', 'managed',
        ...(isRecord(input) && Object.hasOwn(input, 'activationTargetHistory') ? ['activationTargetHistory'] : [])
      ], 'Manifest writer request');
  let leaf: ManifestV8ProjectLeaf;
  let profile: 'none' | ModernGovernanceProfile;
  let source: HistoricalLiftoffManifest | LiftoffManifestV8 | undefined;
  let originalReference: ManifestSourceHistoryReference | undefined;
  let activationTargetHistory: ActivationTargetHistoryReference | undefined;
  if (origin === 'fresh' || origin === 'adoption') {
    const label = origin === 'fresh' ? 'Fresh' : 'Adoption';
    const selection = exactRecord(origin === 'adoption' ? sourceData(request.selection) : request.selection,
      ['project', 'framework', 'profile'], `${label} manifest selection`);
    leaf = projectReader.validateManifestV8Project({ project: selection.project, framework: selection.framework });
    if (leaf.framework.state === 'legacy') throw new FileSystemError(`${label} origin cannot claim historical legacy framework uncertainty.`);
    if (selection.profile !== 'none' && selection.profile !== 'single-maintainer-gitflow' && selection.profile !== 'team-gitflow') {
      throw new FileSystemError(`${label} manifest requires an explicit supported profile.`);
    }
    profile = selection.profile as 'none' | ModernGovernanceProfile;
  } else if (origin === 'historical-successor') {
    const raw = sourceData(request.source);
    if (!isRecord(raw) || ![2, 3, 4, 5, 6, 7].some((version) => version === raw.artifactVersion)) {
      throw new FileSystemError('Historical-successor requires an original v2-v7 manifest.');
    }
    source = parseManifest(raw);
    if (request.profile !== 'none' && request.profile !== 'single-maintainer-gitflow' ||
      source.governance.profile !== 'unspecified' && request.profile !== source.governance.profile) {
      throw new FileSystemError('Historical successor cannot switch profile or infer a team transition.');
    }
    profile = request.profile;
    leaf = projectReader.validateManifestV8Project({ project: source.project, framework: source.framework });
    originalReference = validateManifestSourceHistoryReference(request.sourceManifestHistory);
  } else if (origin === 'maintenance') {
    source = rootReader.parseManifestV8(sourceData(request.source));
    profile = source.governance.profile;
    leaf = projectReader.validateManifestV8Project({ project: source.project, framework: source.framework });
    originalReference = source.sourceManifestHistory;
    activationTargetHistory = source.activationTargetHistory;
    if (Object.hasOwn(request, 'activationTargetHistory')) {
      const requested = validateActivationTargetHistoryReference(request.activationTargetHistory);
      if (activationTargetHistory && canonicalJson(requested) !== canonicalJson(activationTargetHistory)) {
        throw new FileSystemError('Maintenance cannot replace its original activation target history.');
      }
      activationTargetHistory = requested;
    }
  } else {
    source = rootReader.parseManifestV8(sourceData(request.source));
    const selection = exactRecord(
      sourceData(request.selection),
      ['project', 'framework', 'profile'],
      'Workflow transition manifest selection'
    );
    leaf = projectReader.validateManifestV8Project({
      project: selection.project,
      framework: selection.framework
    });
    if (selection.profile !== source.governance.profile) {
      throw new FileSystemError(
        'Workflow transition cannot change the governance profile.'
      );
    }
    profile = selection.profile as 'none' | ModernGovernanceProfile;
    const sourceEligible = source.project.specWorkflow === 'manual'
      ? source.framework.state === 'not-required'
      : source.framework.state === 'initialized';
    const targetEligible = leaf.project.specWorkflow === 'manual'
      ? leaf.framework.state === 'not-required'
      : leaf.framework.state === 'initialized';
    if (!sourceEligible ||
        !targetEligible ||
        canonicalJson(source.project.workload) !==
          canonicalJson(leaf.project.workload) ||
        source.project.name !== leaf.project.name) {
      throw new FileSystemError(
        'Workflow transition requires a current Manual or initialized external source and a Manual or initialized external target without changing project identity.'
      );
    }
    originalReference = source.sourceManifestHistory;
    activationTargetHistory = source.activationTargetHistory;
  }
  const target = targetFor(
    leaf,
    profile,
    origin === 'maintenance' && source?.artifactVersion === 8
      ? source.plugins
      : undefined
  );
  const generated = origin === 'fresh' ? generatedInput(request.generatedArtifacts, target.composition.expected) : undefined;
  const managedArtifacts = generated ? generated.filter((entry) => entry.lifecycle === 'managed-core').map((entry) => {
    const contentHash = `sha256:${hash(entry.content)}`;
    assertStaticHash(entry.logicalName, contentHash, target.staticHashes);
    return { logicalName: entry.logicalName, category: entry.category, pathParts: [...entry.pathParts], contentHash };
  }) : managedInput(origin === 'adoption' ? sourceData(request.managed) : request.managed,
    origin === 'adoption' || origin === 'historical-successor' ||
      origin === 'workflow-transition' ? origin : 'maintenance',
    source, target);
  const projectArtifacts = generated ? generated.flatMap((entry) => entry.lifecycle === 'project' ? [{
    logicalName: entry.logicalName, category: entry.category, pathParts: [...entry.pathParts],
    generatedBy: liftoffVersion, generationHash: `sha256:${hash(entry.content)}`, provisioningGroup: entry.provisioningGroup
  }] : []) : origin === 'adoption' ? [] : source!.projectArtifacts;
  let activeLayout = generated ? {
    schemaVersion: 1, state: 'bound',
    bindings: projectArtifacts.map((entry) => ({ kind: 'artifact', logicalName: entry.logicalName, pathParts: entry.pathParts }))
  } : origin === 'historical-successor' || origin === 'adoption' ||
      origin === 'workflow-transition' ? sourceData(request.activeLayout) :
    source?.artifactVersion === 8 ? source.activeLayout : undefined;
  if (generated && Object.hasOwn(request, 'activeLayout')) {
    const requested = validateManifestActiveLayout(sourceData(request.activeLayout), target.source.layoutDescriptor);
    const declared = freshActiveLayoutForComposition(target.composition);
    if (canonicalJson(requested) !== canonicalJson(declared)) {
      throw new FileSystemError('Fresh explicit active layout must match the exact generated runtime layout.');
    }
    activeLayout = requested;
  }
  const adoptionObservations = origin === 'adoption' ? adoptionInput(request.adoptionObservations, target) :
    source?.artifactVersion === 8 ? source.adoptionObservations : [];
  const owned = new Set(managedArtifacts.map((entry) => entry.logicalName));
  const governance = profile === 'none' ? { profile, state: 'disabled' } : (() => {
    if (!('identity' in target.source.governanceSource)) throw new FileSystemError('Enabled target lacks a real modern governance source.');
    const staticIdentity = target.source.governanceSource.identity;
    return {
      profile, policyVersion: staticIdentity.policyVersion,
      state: target.source.requiredHandoffLogicalNames.every((name) => owned.has(name)) ? 'handoff-generated' : 'handoff-partial',
      activationIdentity: identityReader.identityForSource({
        sourceVersion: staticIdentity.liftoffVersion, profile, policyVersion: staticIdentity.policyVersion,
        selection: { ...leaf, profile }, pluginResolutionDigest: target.plugins.resolutionDigest,
        activeLayoutDigest: manifestActiveLayoutDigest(activeLayout, target.source.layoutDescriptor)
      })
    };
  })();
  const manifest = rootReader.parseManifestV8({
    artifactVersion: 8, generatedBy: 'Mission Control Liftoff', liftoffVersion,
    ...leaf, governance, plugins: target.plugins, activeLayout, managedArtifacts, projectArtifacts, adoptionObservations,
    ...(originalReference ? { sourceManifestHistory: originalReference } : {}),
    ...(activationTargetHistory ? { activationTargetHistory } : {})
  });
  if (origin === 'adoption') assertAdoptionBindings(manifest);
  if (source) {
    for (const [name, previous, next] of [
      ['project provenance', source.projectArtifacts, manifest.projectArtifacts],
      ...(source.artifactVersion === 8 ? [[
        'adoption observations',
        source.adoptionObservations,
        manifest.adoptionObservations
      ]] : [])
    ]) {
      if (canonicalJson(previous) !== canonicalJson(next)) throw new FileSystemError(`Manifest writer cannot alter source ${name}.`);
    }
    if (origin !== 'workflow-transition') {
      for (const [name, previous, next] of [
        ['project', source.project, manifest.project],
        ['framework', source.framework, manifest.framework]
      ]) {
        if (canonicalJson(previous) !== canonicalJson(next)) {
          throw new FileSystemError(`Manifest writer cannot alter source ${name}.`);
        }
      }
    }
    if (origin === 'maintenance' && source.artifactVersion === 8) {
      const sourceIdentity = source.governance.profile === 'none' ? null : source.governance.activationIdentity;
      const targetIdentity = manifest.governance.profile === 'none' ? null : manifest.governance.activationIdentity;
      if (canonicalJson(sourceIdentity) !== canonicalJson(targetIdentity) || canonicalJson(source.plugins) !== canonicalJson(manifest.plugins)) {
        throw new FileSystemError('Ordinary maintenance cannot change the complete source contract identity.');
      }
    }
  }
  const content = `${JSON.stringify(manifest, null, 2)}\n`;
  if (generated) target.composition.verify([...generated, {
    logicalName: 'manifest', category: 'manifest', lifecycle: 'manifest', pathParts: ['liftoff.manifest.json'], content
  }]);
  return Object.freeze({ manifest, content, digest: hash(content) });
}
