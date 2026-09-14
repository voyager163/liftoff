import path from 'node:path';
import type { LiftoffManifest } from '../../domain/project/contracts.js';
import { isManagedCoreLogicalName, retiredManagedCoreIdentities } from '../../domain/project/artifact-lifecycle.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { applicationTargetLayoutId, repairContractVersion } from '../../domain/repair/identity.js';
import { buildArtifacts } from '../../templates.js';
import { buildProjectPlan } from '../project/planning.js';
import {
  ApplicationFiles, ApplicationInspectionError, applicationDigest, applicationExclusion, applicationFailure,
  applicationParts, applicationPathFold, applicationPathKey, canonicalApplicationRoot
} from './application-files.js';
import { applicationText, inspectApplicationReferences } from './application-references.js';
import {
  applicationBounds, type ApplicationComponent, type ApplicationInventoryReport,
  type ApplicationLayoutInspection, type ApplicationTargetArtifact, type ApplicationTargetLayout
} from './application-types.js';

export const applicationInventoryLimitations = [
  'Targets describe the current generator for the recorded workload, not a historical source-layout version or permission to replace source with starters.',
  'Reference discovery covers bounded known literal and relative locations only. Dynamic imports, aliases, generated code, package resolution and runtime behavior require developer review and exact staged checks.',
  'Excluded state, credential, control, dependency and output paths are not read or copied. Binary files are byte-bound but have no reference scan.',
  'Inspection and preview execute no project code, Git commands, filters, hooks, network operations or file mutations.'
];

export function currentApplicationTargets(manifest: LiftoffManifest): {
  target: ApplicationTargetLayout;
  protectedPaths: Set<string>;
  examplePaths: Set<string>;
} {
  const workload = manifest.project.workload;
  const fallbackAgents = manifest.project.agents.length ? manifest.project.agents : ['github-copilot'];
  const plan = buildProjectPlan({
    projectName: manifest.project.name,
    projectType: workload.kind,
    apiStack: workload.apiStack,
    ...(workload.kind === 'genai' ? { pattern: workload.pattern } : {}),
    cloud: workload.cloud,
    region: workload.region,
    includeFrontend: workload.frontend,
    environments: [...workload.environments],
    specWorkflow: manifest.project.specWorkflow,
    agents: [...fallbackAgents],
    ...(manifest.project.defaultAgent ? { defaultAgent: manifest.project.defaultAgent } : {}),
    governanceProfile: manifest.governance.profile === 'unspecified' ? 'none' : manifest.governance.profile
  }, { requireProjectName: true });
  if (manifest.project.agents.length === 0) {
    plan.agents = [];
    plan.defaultAgent = undefined;
  }
  const generated = buildArtifacts(plan);
  const foldedKey = (parts: readonly string[]) => parts.map(applicationPathFold).join('/');
  const protectedPaths = new Set([
    ...generated.filter((item) => item.lifecycle !== 'project').map((item) => foldedKey(item.pathParts)),
    ...manifest.managedArtifacts.map((item) => foldedKey(item.pathParts)),
    ...manifest.projectArtifacts.filter((item) => item.category === 'infrastructure' ||
      isManagedCoreLogicalName(item.logicalName)).map((item) => foldedKey(item.pathParts)),
    ...retiredManagedCoreIdentities.map((item) => foldedKey(item.pathParts))
  ]);
  const examplePaths = new Set(generated.filter((item) => item.lifecycle === 'project' &&
    ['.env.example', 'runtime.config.example.json', 'local.settings.example.json'].includes(item.pathParts.at(-1)!))
    .map((item) => foldedKey(item.pathParts)));
  const artifacts: ApplicationTargetArtifact[] = [];
  const names = new Set<string>(), paths = new Set<string>();
  for (const artifact of generated) {
    if (artifact.lifecycle !== 'project' || applicationExclusion(artifact.pathParts, protectedPaths, examplePaths)) continue;
    const parts = applicationParts(artifact.pathParts);
    const key = foldedKey(parts);
    if (names.has(artifact.logicalName) || paths.has(key)) {
      throw new ApplicationInspectionError('The generated application target inventory contains an identity collision.');
    }
    names.add(artifact.logicalName);
    paths.add(key);
    const first = parts[0]!;
    const component: ApplicationComponent = ['backend', 'frontend', 'functions', 'database'].includes(first)
      ? first as ApplicationComponent : 'project';
    const componentRootPathParts = component === 'project' ? [] :
      component === 'functions' && parts.length > 2 ? parts.slice(0, 2) : parts.slice(0, 1);
    artifacts.push({
      logicalName: artifact.logicalName, category: artifact.category, pathParts: parts,
      provisioningGroup: artifact.provisioningGroup, component, componentRootPathParts
    });
  }
  artifacts.sort((a, b) => a.logicalName.localeCompare(b.logicalName, 'en'));
  if (!artifacts.length) throw new ApplicationInspectionError('No supported current application target identities exist for this workload.');
  const body = { id: applicationTargetLayoutId, version: 1 as const, workload: structuredClone(workload), artifacts };
  return { target: { ...body, digest: canonicalSha256(body) }, protectedPaths, examplePaths };
}

export async function inspectApplicationLayout(
  root: string, manifest: LiftoffManifest
): Promise<ApplicationLayoutInspection> {
  const report: ApplicationInventoryReport = {
    schemaVersion: 1, kind: 'liftoff-application-inventory', projectRoot: path.resolve(root),
    repairContractVersion, complete: false, inspectionDigest: '', target: null,
    files: [], directoryInventory: [], references: [], exclusions: [], unresolvedMappings: [],
    referenceCoverage: 'bounded-literals-only', limitations: [...applicationInventoryLimitations],
    blockers: [], bounds: applicationBounds
  };
  let reader: ApplicationFiles | undefined;
  try {
    report.projectRoot = await canonicalApplicationRoot(root);
    const current = currentApplicationTargets(manifest);
    report.target = current.target;
    reader = new ApplicationFiles(report.projectRoot, (parts) =>
      applicationExclusion(parts, current.protectedPaths, current.examplePaths));
    await reader.walk();
    await reader.assertUnchanged();
    report.complete = true;
  } catch (error) {
    report.blockers.push(applicationFailure(error));
  }
  const snapshots = [...(reader?.snapshots.values() ?? [])].filter((item) => item.content !== undefined)
    .sort((a, b) => applicationPathKey(a.pathParts).localeCompare(applicationPathKey(b.pathParts), 'en'));
  report.directoryInventory = [...(reader?.directoryInventory ?? [])]
    .sort((a, b) => applicationPathKey(a.pathParts).localeCompare(applicationPathKey(b.pathParts), 'en'));
  report.exclusions = reader?.exclusions ?? [];
  report.files = snapshots.map((snapshot) => {
    const key = applicationPathKey(snapshot.pathParts);
    const digest = applicationDigest(snapshot.content!);
    const target = report.target?.artifacts.find((item) => applicationPathKey(item.pathParts) === key);
    const recorded = manifest.projectArtifacts.find((item) => applicationPathKey(item.pathParts) === key);
    const identityMatches = recorded && target && recorded.logicalName === target.logicalName &&
      recorded.category === target.category && recorded.provisioningGroup === target.provisioningGroup;
    return {
      pathParts: [...snapshot.pathParts], digest, mode: snapshot.mode!, bytes: snapshot.content!.byteLength,
      text: applicationText(snapshot.content!) !== null, currentTargetLogicalName: target?.logicalName ?? null,
      provenance: recorded ? {
        logicalName: recorded.logicalName, category: recorded.category, pathParts: [...recorded.pathParts],
        generatedBy: recorded.generatedBy, generationHash: recorded.generationHash, provisioningGroup: recorded.provisioningGroup,
        contentMatchesRecordedHash: recorded.generationHash === `sha256:${digest}`,
        identity: identityMatches ? 'current-artifact' as const : 'recorded-only' as const
      } : null
    };
  });
  try {
    report.references = inspectApplicationReferences(snapshots, report.directoryInventory);
  } catch (error) {
    report.complete = false;
    report.blockers.push(applicationFailure(error));
  }
  report.unresolvedMappings = report.files.map((file) => ({
    sourcePathParts: [...file.pathParts],
    decision: file.currentTargetLogicalName ? 'current-path-customization-review' : 'explicit-mapping-required'
  }));
  const { inspectionDigest: _digest, ...body } = report;
  report.inspectionDigest = canonicalSha256({ ...body, manifestDigest: canonicalSha256(manifest) });
  const inspection = { report, snapshots };
  Object.defineProperty(inspection, 'snapshots', { enumerable: false });
  return inspection;
}

export type { ApplicationInventoryReport, ApplicationLayoutInspection } from './application-types.js';
