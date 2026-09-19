import { applicationObject } from '../../adapters/azure/application-provisioning.js';
import { AzureArmError } from '../../adapters/azure/activation-rest.js';
import { githubRepository, GitHubActivationError, positiveId } from '../../adapters/github/activation-rest.js';
import type { WorkflowRunBinding } from '../../adapters/github/workflow-dispatch.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import type { ActivationConfiguration, PhaseOutputBindings, TransitionOperation } from '../../domain/governance/activation/types.js';
import type {
  GovernanceTransitionInspection, PhaseAdapterExecutionInput, PhasePlanBuild, PhasePlanningInput
} from '../../governance-activation/transition-ports.js';
import { sourceSha } from '../../governance-activation/github-config.js';
import {
  applicationArtifactBindingInputs, applicationArtifactOperations, requiredApplicationArtifacts,
  type ApplicationArtifactInputs, type ApplicationArtifactRole, type RequiredApplicationArtifact
} from './application-artifact-inputs.js';
import {
  applicationBuildWorkflowDispatchInputs, applicationBuildWorkflowJob, applicationBuildWorkflowRecipe,
  renderApplicationBuildWorkflow, type ApplicationBuildWorkflowRecipe
} from './application-build-workflow.js';
import type { VerifiedApplicationBuild } from './application-build-report.js';
import { AzureActivationAdmissionError } from './authority.js';

export const applicationArtifactSetProtocol = 'application-artifact-set/1' as const;

export interface ApplicationArtifactSourceSubject {
  repository: string;
  repositoryId: number;
  sourceSha: string;
}

export interface ApplicationArtifactRoleConfiguration {
  componentId: string;
  workflow: WorkflowRunBinding;
  /** Exact existing renderer recipe, including context, Dockerfile and operator-supplied immutable pins. */
  build: ApplicationBuildWorkflowRecipe;
  /** The independently reviewed registry-readback principal, not the federated build principal. */
  principalId: string;
  expectedDigest?: string;
}

/** Exact phases['application-artifact-ready'] set-mode schema; no role is caller-optional. */
export interface ApplicationArtifactSetConfiguration {
  schemaVersion: 1;
  mode: 'artifact-set';
  source: ApplicationArtifactSourceSubject;
  artifacts: {
    backend: ApplicationArtifactRoleConfiguration;
    frontend?: ApplicationArtifactRoleConfiguration;
  };
}

export interface ApplicationArtifactRoleInputs extends RequiredApplicationArtifact {
  build: ApplicationBuildWorkflowRecipe;
  application: ApplicationArtifactInputs;
}

export interface ApplicationArtifactSetInputs {
  schemaVersion: 1;
  protocol: typeof applicationArtifactSetProtocol;
  source: ApplicationArtifactSourceSubject;
  artifacts: readonly ApplicationArtifactRoleInputs[];
}

export interface ApplicationArtifactRoleEvidence {
  role: ApplicationArtifactRole;
  componentId: string;
  componentDigest: string;
  recipeDigest: string;
  context: string;
  dockerfile: string;
  workflow: WorkflowRunBinding;
  source: ApplicationArtifactSourceSubject & { treeSha: string };
  provenance: VerifiedApplicationBuild;
  artifact: { id: number; name: string; digest: string };
  dispatchCheckpointDigest: string;
  originalPlanDigest: string;
  originalApprovalEnvelopeHash: string;
}

export interface ApplicationArtifactSetEvidence {
  schemaVersion: 1;
  kind: 'application-artifact-ready.v1';
  mode: 'artifact-set';
  protocol: typeof applicationArtifactSetProtocol;
  setDigest: string;
  source: ApplicationArtifactSourceSubject & { treeSha: string };
  requiredRoles: readonly ApplicationArtifactRole[];
  artifacts: readonly ApplicationArtifactRoleEvidence[];
}

export interface ApplicationArtifactSetReference {
  evidenceId: string;
  headerDigest: string;
  bodyDigest: string;
  planPathParts: readonly string[];
  savedPlanDigest: string;
  setDigest: string;
}

/** Role selection is explicit; this cannot be implicitly converted to a backend image reference. */
export interface ApplicationArtifactRoleReference {
  set: ApplicationArtifactSetReference;
  role: ApplicationArtifactRole;
}

export const applicationArtifactSetRuntimePrerequisites = [
  'Every configured manifest frontend is required alongside its actual backend component.',
  'Publish each exact existing application-build-workflow recipe through the owner-controlled source producer, then bind its actual workflow ID and one common commit.',
  'Set mode retains the original whole phase plan and private approval issuance for every role; no role-specific approval or replacement plan is synthesized.',
  'Only complete sets expose immutable image outputs. Private partial receipts are locators for independent continuation readback, not supplied success or live deployment authority.',
  'Deployment, health, promotion and rehearsal integrations must select a typed role reference rather than reuse legacy azure.artifact outputs.',
  'Source implementation and local protocol fixtures do not qualify a provider, native package, release, registry permission or application deployment.'
] as const;

export function artifactSetAssert(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new AzureActivationAdmissionError(`application-artifact-set-${code}`, message);
}

export function applicationArtifactSetDigest(config: ApplicationArtifactSetInputs): string {
  return canonicalSha256(config);
}

/** Pure historical/current configuration reader; it never changes an execution phase or approval. */
export function applicationArtifactSetConfiguration(
  inspection: Pick<GovernanceTransitionInspection, 'manifest' | 'state'>,
  configuration: ActivationConfiguration | undefined
): ApplicationArtifactSetInputs {
  const data = applicationObject(configuration?.phases['application-artifact-ready'], 'Application artifact set', [
    'schemaVersion', 'mode', 'source', 'artifacts'
  ]);
  artifactSetAssert(data.schemaVersion === 1 && data.mode === 'artifact-set', 'configuration',
    'Artifact sets require the explicit versioned artifact-set mode.');
  const required = requiredApplicationArtifacts(inspection.manifest);
  const source = applicationObject(data.source, 'Common application source', ['repository', 'repositoryId', 'sourceSha']);
  const subject: ApplicationArtifactSourceSubject = {
    repository: githubRepository(source.repository), repositoryId: positiveId(source.repositoryId),
    sourceSha: sourceSha(source.sourceSha)
  };
  const remote = inspection.state.remoteBinding;
  artifactSetAssert(remote && remote.name === subject.repository && remote.id === String(subject.repositoryId) &&
    (configuration?.repository?.name === undefined || configuration.repository.name === subject.repository),
  'repository', 'Every artifact must share the exact independently bound application repository and commit.');
  const roles = required.map((entry) => entry.role);
  const supplied = applicationObject(data.artifacts, 'Required application role bindings', roles);
  artifactSetAssert(Object.keys(supplied).length === roles.length && roles.every((role) => Object.hasOwn(supplied, role)),
    'required-roles', 'The reviewed set must bind every required role exactly once; a configured frontend cannot be skipped.');
  const artifacts = required.map((requirement): ApplicationArtifactRoleInputs => {
    const entry = applicationObject(supplied[requirement.role], 'Application role binding', [
      'componentId', 'workflow', 'build', 'principalId', 'expectedDigest'
    ]);
    const build = applicationBuildWorkflowRecipe(entry.build);
    const registry = /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.ContainerRegistry\/registries\/([^/]+)$/u.exec(build.registry.resourceId);
    artifactSetAssert(registry, 'registry', 'Each role requires its exact canonical build registry resource.');
    const application = applicationArtifactBindingInputs({
      principalId: entry.principalId, resourceGroup: registry[2], acrName: registry[3],
      imageName: build.registry.repository, workflow: entry.workflow,
      artifactName: build.artifactName, platform: build.platform, maxRunMinutes: build.limits.maxRunMinutes,
      dispatchInputs: applicationBuildWorkflowDispatchInputs(build, subject.sourceSha),
      ...(entry.expectedDigest === undefined ? {} : { expectedDigest: entry.expectedDigest })
    }, {
      azure: configuration?.azure ?? {}, budget: configuration?.budget,
      repository: subject.repository, repositoryId: remote.id
    });
    const root = requirement.component.rootPathParts.join('/') || '.';
    const workflow = application.workflow;
    artifactSetAssert(entry.componentId === requirement.component.id &&
      build.context === root && (root === '.' || build.dockerfile.startsWith(`${root}/`)) &&
      build.repository === subject.repository && build.repositoryId === subject.repositoryId &&
      build.workflowPath === workflow.workflowPath && build.actorId === workflow.actorId && build.ref === workflow.ref &&
      workflow.sourceSha === subject.sourceSha &&
      (workflow.producerSourceSha === undefined || workflow.producerSourceSha === subject.sourceSha) &&
      canonicalSha256(workflow.expectedJobs) === canonicalSha256([applicationBuildWorkflowJob]) &&
      workflow.workflowDigest === canonicalSha256(renderApplicationBuildWorkflow(build)) &&
      build.azure.tenantId === application.azure.tenantId && registry[1] === application.azure.subscriptionId &&
      build.registry.resourceId === application.registryResourceId && build.registry.location === application.region &&
      canonicalSha256(build.budget) === canonicalSha256(application.budget),
    'role-binding', 'Every role must bind its actual component boundary, exact renderer bytes, common source, workflow/actor, registry and whole-phase budget.');
    return { ...requirement, build, application };
  });
  for (const select of [
    (entry: ApplicationArtifactRoleInputs) => entry.application.workflow.workflowPath.toLowerCase(),
    (entry: ApplicationArtifactRoleInputs) => String(entry.application.workflow.workflowId),
    (entry: ApplicationArtifactRoleInputs) => entry.application.artifactName,
    (entry: ApplicationArtifactRoleInputs) => `${entry.application.registryResourceId.toLowerCase()}/${entry.application.imageName}`,
    (entry: ApplicationArtifactRoleInputs) => entry.component.id
  ]) {
    artifactSetAssert(new Set(artifacts.map(select)).size === artifacts.length, 'role-alias',
      'Required roles must have distinct workflow registrations, paths, report names, component identities and registry repositories.');
  }
  const roots = artifacts.map((entry) => entry.build.context.toLowerCase());
  artifactSetAssert(!roots.some((root, i) => roots.some((other, j) => i !== j &&
    (root === '.' || root === other || other.startsWith(`${root}/`)))), 'component-boundaries',
  'Role build contexts must be non-overlapping actual manifest component boundaries.');
  return { schemaVersion: 1, protocol: applicationArtifactSetProtocol, source: subject, artifacts };
}

export function applicationArtifactSetInputs(input: Pick<PhasePlanningInput, 'inspection' | 'phase'>): ApplicationArtifactSetInputs {
  artifactSetAssert(input.phase.id === 'application-artifact-ready', 'phase', 'Artifact sets belong only to application-artifact-ready.');
  return applicationArtifactSetConfiguration(input.inspection, input.inspection.activationInputs ?? input.inspection.state.activationInputs);
}

export function applicationArtifactSetRole(config: ApplicationArtifactSetInputs, role: ApplicationArtifactRole): ApplicationArtifactRoleInputs {
  const selected = config.artifacts.filter((entry) => entry.role === role);
  artifactSetAssert(selected.length === 1, 'role', 'The requested role is not in this exact required artifact set.');
  return selected[0]!;
}

export function applicationArtifactSetOperations(config: ApplicationArtifactSetInputs): TransitionOperation[] {
  const setDigest = applicationArtifactSetDigest(config);
  return config.artifacts.flatMap((entry) => applicationArtifactOperations(entry.application).map((operation) => ({
    ...operation,
    inputs: { ...operation.inputs, artifactSet: {
      protocol: applicationArtifactSetProtocol, setDigest, source: config.source,
      requiredRoles: config.artifacts.map((artifact) => artifact.role), role: entry.role,
      component: entry.component, build: entry.build
    } }
  })));
}

export function assertApplicationArtifactSetOperations(
  input: Pick<PhaseAdapterExecutionInput, 'plan'>, config: ApplicationArtifactSetInputs
): readonly TransitionOperation[] {
  const expected = applicationArtifactSetOperations(config);
  const actual = input.plan.operations.filter((entry) => entry.remote);
  artifactSetAssert(actual.length === expected.length && expected.every((operation) =>
    actual.filter((entry) => canonicalSha256(entry) === canonicalSha256(operation)).length === 1), 'plan',
  'All role dispatches, readbacks, effects and destinations must be exactly present in the original whole reviewed phase plan before any effect.');
  return expected;
}

export function planApplicationArtifactSetReady(input: PhasePlanningInput): PhasePlanBuild {
  try { return { operations: applicationArtifactSetOperations(applicationArtifactSetInputs(input)) }; }
  catch (error) {
    if (!(error instanceof AzureActivationAdmissionError) && !(error instanceof AzureArmError) && !(error instanceof GitHubActivationError)) throw error;
    return { operations: [], blockers: [error.message] };
  }
}

/** Formatting only; qualification requires the concrete executor and registered private set custody. */
export function applicationArtifactSetOutputs(evidence: ApplicationArtifactSetEvidence): PhaseOutputBindings {
  const values: Record<string, string | number | boolean | null> = {
    'application.artifactSet.status': 'completed',
    'application.artifactSet.digest': evidence.setDigest,
    'application.artifactSet.sourceSha': evidence.source.sourceSha,
    'application.artifactSet.treeSha': evidence.source.treeSha,
    'application.artifactSet.requiredCount': evidence.requiredRoles.length
  };
  const resources: PhaseOutputBindings['resources'][number][] = [];
  for (const artifact of evidence.artifacts) {
    const prefix = `application.artifacts.${artifact.role}`;
    const build = artifact.provenance;
    Object.assign(values, {
      [`${prefix}.componentId`]: artifact.componentId, [`${prefix}.imageRef`]: build.imageRef,
      [`${prefix}.digest`]: build.digest, [`${prefix}.configDigest`]: build.configDigest,
      [`${prefix}.registryResourceId`]: build.registryResourceId, [`${prefix}.sourceSha`]: build.sourceSha,
      [`${prefix}.buildRunId`]: build.runId, [`${prefix}.artifactId`]: artifact.artifact.id,
      [`${prefix}.artifactDigest`]: artifact.artifact.digest
    });
    resources.push(
      { provider: 'azure', resourceType: 'containerRegistry', resourceId: build.registryResourceId },
      { provider: 'github', resourceType: 'workflow-run', resourceId: `/repos/${artifact.workflow.repository}/actions/runs/${build.runId}` },
      { provider: 'github', resourceType: 'artifact', resourceId: `/repos/${artifact.workflow.repository}/actions/artifacts/${artifact.artifact.id}` }
    );
  }
  return { values, resources: resources.filter((entry, i) =>
    resources.findIndex((other) => canonicalSha256(other) === canonicalSha256(entry)) === i) };
}
