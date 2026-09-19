import { createHash } from 'node:crypto';
import type { ProjectFileMutation, ProjectFileSnapshot } from '../../adapters/filesystem/project-transaction.js';
import { equivalentHcl, InfrastructureInspectionError, unsupported } from '../../adapters/hcl/semantic.js';
import type { EnvironmentId, LiftoffManifest, ManifestGeneratedProjectArtifact, ManifestProjectArtifact } from '../../domain/project/contracts.js';
import {
  assessInfrastructureLayout, compatibleIndependentInfrastructureGenerationVersions,
  currentInfrastructureIdentities, environmentRootInfrastructureIdentities,
  retiredFlatRootInfrastructureIdentities, type InfrastructureArtifactIdentity, type InfrastructureLayoutKind
} from '../../domain/project/infrastructure-layout.js';
import { liftoffVersion } from '../../version.js';
import {
  InfrastructureFiles, infrastructureFileLimit, infrastructureRoot,
  infrastructureTotalFileLimit, type InfrastructureDirectoryObservation
} from './infra-files.js';
import { inspectLegacySemantics } from './infra-semantics.js';

export interface InfrastructureRepairCandidate {
  layout: InfrastructureLayoutKind;
  blockers: string[];
  snapshots: ProjectFileSnapshot[];
  mutations: ProjectFileMutation[];
  artifacts: ManifestGeneratedProjectArtifact[];
  files: { pathParts: string[]; content: string }[];
  resourceGroups: { environment: EnvironmentId; name: string }[];
  statePaths: string[][];
  /** Include in the approval fingerprint; repeat inspection under the mutation lock. */
  directoryInventory: InfrastructureDirectoryObservation[];
}

function hash(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

function sameIdentity(artifact: ManifestProjectArtifact, identity: InfrastructureArtifactIdentity): artifact is ManifestGeneratedProjectArtifact {
  return typeof artifact.generatedBy === 'string' && typeof artifact.generationHash === 'string' &&
    artifact.logicalName === identity.logicalName && artifact.category === identity.category &&
    artifact.provisioningGroup === identity.provisioningGroup &&
    artifact.pathParts.join('/') === identity.pathParts.join('/');
}

function recorded(manifest: LiftoffManifest, identity: InfrastructureArtifactIdentity): boolean {
  return manifest.projectArtifacts.some((item) => sameIdentity(item, identity) &&
    item.generatedBy.length > 0 && /^sha256:[a-f0-9]{64}$/.test(item.generationHash));
}

function legacyEnvironmentIdentity(environment: EnvironmentId): InfrastructureArtifactIdentity {
  return {
    logicalName: `opentofu-${environment}-tfvars`, category: 'infrastructure',
    pathParts: [...infrastructureRoot, 'environments', `${environment}.tfvars`],
    provisioningGroup: `environment:${environment}`
  };
}

function stateLocations(
  root: string[], backend = { path: ['terraform.tfstate'], backup: ['terraform.tfstate.backup'], workspace: ['terraform.tfstate.d'] }
): string[][] {
  return [
    [...root, '.terraform', 'terraform.tfstate'],
    [...root, '.terraform', 'terraform.tfstate.backup'],
    [...root, '.terraform', 'environment'],
    [...root, 'terraform.tfstate'], [...root, 'terraform.tfstate.backup'],
    [...root, '.terraform.tfstate.lock.info'], [...root, 'terraform.tfstate.d'],
    [...root, ...backend.path], [...root, ...backend.backup], [...root, ...backend.workspace],
    [...root, ...backend.path.slice(0, -1), `.${backend.path.at(-1)}.lock.info`]
  ];
}

function repairReadmeNotice(environments: readonly EnvironmentId[]): string {
  return `<!-- liftoff:infrastructure-repair-notice:v1 -->
# Repaired infrastructure layout

The original project guide is preserved below. Its former Azure-parent working
directory and \`environments/<id>.tfvars\` paths are historical and superseded by
the selected environment roots listed here.

| Environment | OpenTofu working directory, relative to the project root | Command helper |
| --- | --- | --- |
${environments.map((environment) =>
    `| ${environment} | \`${[...infrastructureRoot, 'environments', environment].join('/')}\` | \`liftoff infra plan --env ${environment}\` |`).join('\n')}

Run these Liftoff helpers from the project root or one of its subdirectories.
They print the matching OpenTofu command; they do not execute it. Each root uses
its own \`<environment>.tfvars\` file and local backend. Select the matching root,
not another environment's values in the same root.

Shared resource definitions remain in \`${[...infrastructureRoot, 'modules', 'application'].join('/')}\`.
Do not run backend initialization, plan, or apply from that module or the Azure
parent directory. Repair does not authorize cloud operations or state migration;
those still require separate subscription-scoped and governance approval.

---

## Original project guide (historical paths)

`;
}

/**
 * Builds a source-preserving recipe, not an undeployed eligibility decision.
 * The caller must bind inventories, observe state metadata and obtain authoritative
 * subscription-scoped group absence before approving or applying any mutations.
 */
export async function inspectInfrastructureRepair(
  projectRoot: string, manifest: LiftoffManifest
): Promise<InfrastructureRepairCandidate> {
  const candidate: InfrastructureRepairCandidate = {
    layout: assessInfrastructureLayout(manifest).kind, blockers: [], snapshots: [],
    mutations: [], artifacts: [], files: [], resourceGroups: [], statePaths: [], directoryInventory: []
  };
  if (manifest.project.workload.kind === 'components') {
    candidate.blockers.push('This adopted component has no declared Azure workload or infrastructure provenance. Use read-only assessment; no cloud or generated environment is inferred.');
    return candidate;
  }
  const reader = new InfrastructureFiles(projectRoot);
  const recordedArtifacts: readonly ManifestProjectArtifact[] = manifest.projectArtifacts;
  const environments = manifest.project.workload.environments;
  const targets = currentInfrastructureIdentities(environments);
  const legacy = [...retiredFlatRootInfrastructureIdentities, ...environments.map(legacyEnvironmentIdentity)];
  const allPaths = new Map([...legacy, ...targets].map((identity) =>
    [identity.pathParts.join('/'), [...identity.pathParts]]));
  const application = [...infrastructureRoot, 'modules', 'application'];
  const environmentRoots = environments.map((environment) => [...infrastructureRoot, 'environments', environment]);
  const stateRoots = [infrastructureRoot, application, [...infrastructureRoot, 'environments'], ...environmentRoots];
  candidate.statePaths = stateRoots.flatMap((root) => stateLocations(root));
  try {
    if (manifest.project.workload.cloud !== 'azure') unsupported('Only recorded Azure infrastructure is supported by this repair recipe.');
    if (!environments.length || environments.length > 3 || new Set(environments).size !== environments.length ||
        environments.some((environment) => !['dev', 'staging', 'prod'].includes(environment))) {
      unsupported('Infrastructure repair requires a bounded set of selected manifest environments.');
    }
    const directories = [
      ['infrastructure'], ['infrastructure', 'opentofu'], infrastructureRoot,
      [...infrastructureRoot, 'modules'], application,
      [...infrastructureRoot, 'environments'], ...environmentRoots
    ];
    const metadataDirectories = stateRoots.map((root) => [...root, '.terraform']);
    const cacheDirectories = ['providers', 'modules', 'plugins'];
    const known = new Set([
      ...allPaths.keys(), ...directories.map((parts) => parts.join('/')),
      ...metadataDirectories.map((parts) => parts.join('/')),
      ...candidate.statePaths.map((parts) => parts.join('/')),
      ...metadataDirectories.flatMap((parts) => cacheDirectories.map((name) => [...parts, name].join('/')))
    ]);
    for (const directory of directories) await reader.inventory(directory, known);
    for (const directory of metadataDirectories) {
      await reader.inventory(directory, known);
      const observation = reader.directoryInventory.at(-1)!;
      for (const entry of observation.entries) {
        // A provider/module cache is not evidence of an initialized backend.
        // Unknown entries remain exact metadata observations, never content reads.
        if (entry.kind !== 'directory' || !cacheDirectories.includes(entry.name)) {
          candidate.statePaths.push([...directory, entry.name]);
        }
      }
    }
    for (const parts of candidate.statePaths) await reader.safePath(parts);
    const environmentDirectory = reader.directoryInventory.find((entry) =>
      entry.pathParts.join('/') === [...infrastructureRoot, 'environments'].join('/'));
    for (const entry of environmentDirectory?.entries ?? []) {
      if (entry.kind !== 'file' && entry.name !== '.terraform' && !environments.includes(entry.name as EnvironmentId)) {
        unsupported(`environments/${entry.name}: unselected or unknown environment root is unsupported.`);
      }
    }
    for (const parts of allPaths.values()) await reader.read(parts);
    if (candidate.layout === 'unknown') {
      unsupported('Recorded provenance does not establish a supported legacy or complete independent infrastructure inventory.');
    }
    const contentAt = (parts: readonly string[]): string | undefined =>
      reader.snapshots.get(parts.join('/'))?.content?.toString('utf8');
    if (candidate.layout === 'independent') {
      for (const identity of legacy) {
        if (contentAt(identity.pathParts) !== undefined) unsupported(`${identity.pathParts.join('/')}: unrecorded legacy configuration remains active.`);
      }
      for (const identity of targets) {
        const content = contentAt(identity.pathParts);
        if (content === undefined) unsupported(`${identity.pathParts.join('/')}: required current infrastructure file is missing.`);
        candidate.files.push({ pathParts: [...identity.pathParts], content });
        const provenance = recordedArtifacts.find((artifact): artifact is ManifestGeneratedProjectArtifact => sameIdentity(artifact, identity));
        if (!provenance) unsupported(`${identity.pathParts.join('/')}: current provenance is missing.`);
        candidate.artifacts.push(structuredClone(provenance));
      }
      return candidate;
    }
    const readme = targets.find((identity) => identity.logicalName === 'opentofu-readme')!;
    for (const identity of [...legacy, readme]) {
      if (!recorded(manifest, identity)) unsupported(`${identity.pathParts.join('/')}: original registered provenance is missing.`);
    }
    const sources: Record<string, string> = {};
    const sourceModes = new Map<string, number | undefined>();
    for (const identity of retiredFlatRootInfrastructureIdentities) {
      const file = identity.pathParts.at(-1)!;
      const original = contentAt(identity.pathParts);
      let chosen = original;
      let chosenParts = identity.pathParts;
      if (original === undefined && file !== 'backend.local.tf') {
        const fallbackPaths = ['main.tf', 'variables.tf', 'outputs.tf', 'versions.tf'].includes(file)
          ? [[...application, file]] : environmentRoots.map((root) => [...root, file]);
        for (const parts of fallbackPaths) {
          const fallback = contentAt(parts);
          if (fallback === undefined) continue;
          if (chosen === undefined) {
            chosen = fallback;
            chosenParts = parts;
          } else if (!await equivalentHcl(chosen, fallback, file)) {
            unsupported(`${file}: conflicting partial-move sources.`);
          }
        }
      }
      if (chosen === undefined) unsupported(`${identity.pathParts.join('/')}: required legacy source is missing; no equivalent recorded move can be established.`);
      sources[file] = chosen;
      sourceModes.set(file, reader.snapshots.get(chosenParts.join('/'))?.mode);
    }
    const values = new Map<EnvironmentId, string>();
    const valuesModes = new Map<EnvironmentId, number | undefined>();
    for (const environment of environments) {
      const old = legacyEnvironmentIdentity(environment);
      const next = environmentRootInfrastructureIdentities(environment).find((identity) => identity.logicalName.endsWith('-tfvars'))!;
      const oldContent = contentAt(old.pathParts);
      const nextContent = contentAt(next.pathParts);
      if (oldContent === undefined && nextContent === undefined) unsupported(`${environment}.tfvars: required environment values are missing.`);
      if (oldContent !== undefined && nextContent !== undefined &&
          !await equivalentHcl(oldContent, nextContent, `${environment}.tfvars`)) {
        unsupported(`${environment}.tfvars: competing legacy and target environment values.`);
      }
      values.set(environment, oldContent ?? nextContent!);
      valuesModes.set(environment, reader.snapshots.get((oldContent === undefined ? next.pathParts : old.pathParts).join('/'))?.mode);
    }
    const semantics = await inspectLegacySemantics(sources, values);
    candidate.resourceGroups = semantics.resourceGroups;
    candidate.statePaths.push(...stateLocations(infrastructureRoot, semantics.backend),
      ...environmentRoots.flatMap((root) => stateLocations(root, semantics.backend)));
    for (const parts of candidate.statePaths) await reader.safePath(parts);
    const desired = new Map<string, { content: string; mode?: number }>();
    const put = (parts: readonly string[], content: string, mode?: number): void => {
      desired.set(parts.join('/'), { content, mode });
    };
    for (const file of ['versions.tf', 'variables.tf', 'main.tf', 'outputs.tf']) {
      put([...application, file], sources[file], sourceModes.get(file));
    }
    const readmeContent = contentAt(readme.pathParts);
    if (readmeContent === undefined) unsupported('README.md: retained infrastructure source is missing.');
    const notice = repairReadmeNotice(environments);
    put(readme.pathParts, readmeContent.startsWith(notice) ? readmeContent : `${notice}${readmeContent}`,
      reader.snapshots.get(readme.pathParts.join('/'))?.mode);
    for (const environment of environments) {
      const root = [...infrastructureRoot, 'environments', environment];
      for (const file of ['versions.tf', '.terraform.lock.hcl', 'providers.tf', 'variables.tf', 'backend.remote.example.tf']) {
        put([...root, file], sources[file], sourceModes.get(file));
      }
      const argumentWidth = Math.max('source'.length, ...semantics.variables.map((name) => name.length));
      const argumentsText = semantics.variables.map((name) =>
        `  ${name.padEnd(argumentWidth)} = ${name === 'environment' ? JSON.stringify(environment) : `var.${name}`}`).join('\n');
      put([...root, 'main.tf'], `module "application" {\n  ${'source'.padEnd(argumentWidth)} = "../../modules/application"\n${argumentsText}\n}\n`, sourceModes.get('main.tf'));
      put([...root, 'outputs.tf'], semantics.outputs.map((output) =>
        `output "${output.name}" {\n  ${'value'.padEnd(output.sensitive ? 'sensitive'.length : 'value'.length)} = module.application.${output.name}\n${output.sensitive ? '  sensitive = true\n' : ''}}\n`
      ).join('\n'), sourceModes.get('outputs.tf'));
      // The empty legacy backend meant local default state, not a remote backend.
      // Make that same relative local scope explicit in each independent root.
      const backend = semantics.implicitLocalBackend
        ? `${sources['backend.local.tf']}\nterraform {\n  backend "local" {\n    path = "terraform.tfstate"\n  }\n}\n`
        : sources['backend.local.tf'];
      put([...root, 'backend.local.tf'], backend, sourceModes.get('backend.local.tf'));
      put([...root, `${environment}.tfvars`], values.get(environment)!, valuesModes.get(environment));
    }
    let targetBytes = 0;
    for (const identity of targets) {
      const planned = desired.get(identity.pathParts.join('/'))!;
      const existing = contentAt(identity.pathParts);
      const isReadme = identity.logicalName === 'opentofu-readme';
      if (!isReadme && existing !== undefined && existing !== planned.content) {
        if (!await equivalentHcl(existing, planned.content, identity.pathParts.join('/'))) {
          unsupported(`${identity.pathParts.join('/')}: conflicting target configuration; repair will not overwrite it.`);
        }
      }
      const actual = isReadme ? planned.content : existing ?? planned.content;
      const fileBytes = Buffer.byteLength(actual, 'utf8');
      targetBytes += fileBytes;
      if (fileBytes > infrastructureFileLimit || targetBytes > infrastructureTotalFileLimit) {
        unsupported(`${identity.pathParts.join('/')}: repaired target exceeds the bounded infrastructure file inventory.`);
      }
      candidate.files.push({ pathParts: [...identity.pathParts], content: actual });
      if (existing === undefined || isReadme && existing !== actual) {
        candidate.mutations.push({ type: 'write', pathParts: [...identity.pathParts], content: actual, mode: planned.mode ?? 0o600 });
      }
      const generationHash = hash(actual);
      const provenance = recordedArtifacts.find((artifact): artifact is ManifestGeneratedProjectArtifact => sameIdentity(artifact, identity) &&
        artifact.generationHash === generationHash &&
        (identity.logicalName === 'opentofu-readme' || compatibleIndependentInfrastructureGenerationVersions.some((version) => version === artifact.generatedBy)));
      candidate.artifacts.push(provenance ?? {
        ...identity, pathParts: [...identity.pathParts], generationHash,
        generatedBy: liftoffVersion
      });
    }
    for (const identity of legacy) {
      if (contentAt(identity.pathParts) !== undefined) candidate.mutations.push({ type: 'delete', pathParts: [...identity.pathParts] });
    }
  } catch (error) {
    candidate.blockers.push(error instanceof InfrastructureInspectionError ? error.message :
      'Infrastructure configuration could not be inspected safely; no repair recipe was authorized.');
    candidate.mutations = [];
    candidate.files = [];
    candidate.artifacts = [];
    candidate.resourceGroups = [];
  } finally {
    candidate.snapshots = [...reader.snapshots.values()];
    candidate.directoryInventory = reader.directoryInventory;
    candidate.statePaths = [...new Map(candidate.statePaths.map((parts) => [parts.join('/'), parts])).values()];
  }
  return candidate;
}
