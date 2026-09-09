import { canonicalJson, canonicalSha256, sha256Hex } from '../domain/governance/activation/canonical-json.js';
import { currentActivationIdentity, canonicalPhaseGraph } from '../domain/governance/activation/graph.js';
import { canonicalApprovalEnvelopeHash, evaluateApprovalForTransitionPlan, transitionPlanForPhase } from '../domain/governance/activation/approvals.js';
import { inspectCurrentActivationEvidence } from '../governance-activation/read-only.js';
import { governanceChangeMetadataFileName, validateGovernanceChangeMetadata } from '../governance-activation/source-of-truth.js';
import {
  phaseIds,
  type ApprovalEnvelope
} from '../domain/governance/activation/types.js';
import type { CommandRunner } from '../process-runner.js';
import { loadAssessmentCatalog } from './catalog.js';
import {
  inspectAssessmentProject,
  ordinaryGitAssessmentProject,
  type AssessmentProject
} from './project.js';
import {
  inspectAssessmentGit,
  repositoryName,
  type AssessmentGitFacts
} from '../adapters/git/governance-assessment.js';
import { AssessmentFiles, AssessmentInputError, parseAssessmentJson } from './readers.js';
import { parseAssessmentWorkflow, type ParsedWorkflow } from './yaml.js';
import { collectLiveAssessment } from './live.js';
import { classifyFinding, assembleAssessmentReport } from '../domain/governance/assessment/report.js';
import {
  actionReferences, effectiveProtectedRefs, effectiveRequiredContextBindings, failOpenFlags, pinnedActions,
  protectedRefs, requiredCheckContexts, requiredContextBindings,
  runnerAlignment, securityPipeline, singleMaintainer, tagControls, workflowPermissions, observedRequiredContexts,
  type PredicateResult
} from '../domain/governance/assessment/predicates.js';
import { isRecord, jsonValue, notObserved, observed, sanitizeAssessmentText, source } from '../domain/governance/assessment/sanitize.js';
import type {
  AssessmentDiagnostic, AssessmentFinding, AssessmentProjectIdentity, AssessmentReport, AssessmentTarget,
  ControlDefinition, FindingScope, JsonValue, Layer, LiveAssessmentResult, LiveAssessmentScope, Observation
} from './types.js';

const documentationPaths = [
  ['CONTRIBUTING.md'], ['docs', 'operations', 'github-governance.md'],
  ['docs', 'security', 'scanning.md'], ['docs', 'operations', 'alerting.md'],
  ['docs', 'operations', 'service-health.md'], ['docs', 'security', 'audit-evidence.md'],
  ['docs', 'ai-acceptable-use.md']
] as const;

type CurrentActivationInspection = Awaited<
  ReturnType<typeof inspectCurrentActivationEvidence>
>;

function activationAuthorityFingerprint(
  inspection: CurrentActivationInspection
): string {
  if (inspection.status === 'not-started') {
    return canonicalSha256({ status: inspection.status });
  }
  const firstContext = inspection.contexts[phaseIds[0]];
  const stable = JSON.parse(JSON.stringify({
    status: inspection.status,
    state: inspection.state,
    snapshot: inspection.snapshot,
    migration: inspection.migration,
    records: inspection.records,
    reviewedPlans: firstContext.reviewedPlans ?? [],
    selections: inspection.selections
  })) as JsonValue;
  return canonicalSha256(stable);
}

interface LocalFacts {
  workflows: ParsedWorkflow[];
  rulesets: Record<string, unknown>[];
  workflowSource: Observation['source'];
  ruleSource: Observation['source'];
  codeowners: Observation;
  documentation: Observation;
  baseline: string | null;
}

async function localFacts(files: AssessmentFiles, project: AssessmentProject, capturedAt: string): Promise<LocalFacts> {
  const workflowParts = await files.list(['.github', 'workflows'], ['.yml', '.yaml']);
  const workflows: ParsedWorkflow[] = [];
  const workflowDigests: Record<string, JsonValue> = {};
  for (const parts of workflowParts) {
    const text = await files.read(parts);
    if (text === null) throw new AssessmentInputError('inputs-changed', 'Workflow disappeared during inspection.', parts.join('/'));
    workflows.push(parseAssessmentWorkflow(text, parts.join('/')));
    workflowDigests[parts.join('/')] = sha256Hex(text);
  }
  const rulesets: Record<string, unknown>[] = [];
  const ruleDigests: Record<string, JsonValue> = {};
  for (const parts of await files.list(['governance', 'rulesets'], ['.json'])) {
    const text = await files.read(parts);
    if (text === null) throw new AssessmentInputError('inputs-changed', 'Ruleset disappeared during inspection.', parts.join('/'));
    const value = parseAssessmentJson(text, parts.join('/'));
    if (!isRecord(value) || !['branch', 'tag', 'push'].includes(String(value.target)) ||
        !['active', 'disabled', 'evaluate'].includes(String(value.enforcement)) || !Array.isArray(value.rules) ||
        !Array.isArray(value.bypass_actors)) {
      throw new AssessmentInputError('malformed-ruleset', 'Ruleset payload has invalid target, enforcement, rule, or bypass fields.', parts.join('/'));
    }
    rulesets.push(value);
    ruleDigests[parts.join('/')] = sha256Hex(text);
  }
  const codeownerFiles: string[] = [];
  for (const parts of [['CODEOWNERS'], ['.github', 'CODEOWNERS'], ['docs', 'CODEOWNERS']]) {
    if (await files.read(parts) !== null) codeownerFiles.push(parts.join('/'));
  }
  const missingDocs: string[] = [];
  const docFacts: Record<string, JsonValue> = {};
  for (const parts of documentationPaths) {
    const text = await files.read(parts);
    docFacts[parts.join('/')] = text === null ? null : sha256Hex(text);
    if (text === null) missingDocs.push(parts.join('/'));
  }
  const runbooks = await files.list(['docs', 'runbooks'], ['.md']);
  if (runbooks.length === 0) missingDocs.push('docs/runbooks/*.md');
  let baseline: string | null = null;
  if (project.state?.activeChange) {
    const active = project.state.activeChange;
    const parts = active.kind === 'openspec'
      ? ['openspec', 'changes', active.id, governanceChangeMetadataFileName]
      : ['specs', active.id, governanceChangeMetadataFileName];
    const text = await files.read(parts);
    if (text !== null) {
      try {
        const metadata = validateGovernanceChangeMetadata(parseAssessmentJson(text, parts.join('/')));
        if (metadata.changeId !== active.id ||
            metadata.workflowKind !== active.kind ||
            canonicalJson(metadata.activationIdentity) !== canonicalJson(project.state.identity)) {
          throw new Error('Active governance metadata does not match the recorded change and identity.');
        }
        baseline = metadata.baselineSha === '0'.repeat(64) ? null : metadata.baselineSha;
        if (baseline && project.inputSnapshot && baseline !== project.inputSnapshot.baselineSha) {
          project.diagnostics.push({
            code: 'current-input-mismatch',
            severity: 'warning',
            source: parts.join('/'),
            message: 'The recorded governance baseline does not match the independently recomputed current input snapshot; evidence-backed scope is withheld.'
          });
          baseline = null;
        }
      }
      catch (error) {
        project.diagnostics.push({
          code: 'unverified-active-baseline', severity: 'warning', source: parts.join('/'),
          message: sanitizeAssessmentText(error instanceof Error ? error.message : 'Active governance metadata cannot be interpreted.')
        });
      }
      project.bindingBaseline = baseline;
    }
  }
  const docObservation = observed(missingDocs.length === 0, source('file', 'docs and CONTRIBUTING.md', capturedAt, docFacts));
  docObservation.reason = missingDocs.length ? `Missing documentation inventory: ${missingDocs.join(', ')}` : 'Required documentation inventory exists; content and rehearsals need separate proof.';
  return {
    workflows, rulesets,
    workflowSource: source('file', '.github/workflows', capturedAt, workflowDigests),
    ruleSource: source('file', 'governance/rulesets', capturedAt, ruleDigests),
    codeowners: observed(codeownerFiles.length > 0, source('file', 'CODEOWNERS inventory', capturedAt, codeownerFiles)),
    documentation: docObservation, baseline
  };
}

function boundPlan(project: AssessmentProject, phaseId: ControlDefinition['phaseIds'][number], now: Date) {
  const currentContext = project.evidenceContexts?.[phaseId];
  const selection = project.activationSelections?.[phaseId];
  const selected = selection?.issues.length === 0 ? selection.selected : null;
  const payload = selected?.payload;
  if (!project.state || !currentContext || !selected ||
      !isRecord(payload) || typeof payload.planDigest !== 'string' ||
      typeof payload.savedPlanDigest !== 'string' ||
      project.identity.availability !== 'known') return null;
  const candidates = (currentContext.reviewedPlans ?? []).filter((plan) =>
    plan.phaseId === phaseId &&
    plan.planDigest === payload.planDigest &&
    canonicalSha256(plan) === payload.savedPlanDigest &&
    plan.baselineDigest === currentContext.baselineSha &&
    canonicalJson(plan.identity) === canonicalJson(currentActivationIdentity) &&
    Date.parse(plan.createdAt) <= now.getTime() &&
    Date.parse(plan.createdAt) <= Date.parse(project.state!.phases[phaseId].updatedAt)
  ).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const plan = candidates[0];
  if (!plan || plan.baselineDigest === '0'.repeat(64) || plan.inputDigest === '1'.repeat(64) ||
      plan.baselineDigest !== currentContext.baselineSha ||
      plan.inputDigest !== currentContext.inputDigest ||
      plan.transitionDigest !== currentContext.transition.transitionDigest ||
      candidates.some((candidate) => candidate.createdAt === plan.createdAt && candidate.planDigest !== plan.planDigest)) return null;
  return plan;
}

export function selectBoundAssessmentEvidence(project: AssessmentProject, phaseId: ControlDefinition['phaseIds'][number], now: Date) {
  const plan = boundPlan(project, phaseId, now);
  const selection = project.activationSelections?.[phaseId];
  const selected = selection?.issues.length === 0 ? selection.selected : null;
  if (!plan || !project.state || !selected ||
      selected.header.result !== project.state.phases[phaseId].state) return null;
  return selected;
}

function applicability(control: ControlDefinition, project: AssessmentProject, now: Date): AssessmentFinding['applicability'] {
  if (control.applicability === 'always') return 'applicable';
  if (control.applicability === 'api') return project.kind === 'liftoff' ? 'applicable' : 'unknown';
  const discovery = selectBoundAssessmentEvidence(project, 'phase-0-complete', now);
  if (!project.state || discovery?.header.result !== 'verified') return 'unknown';
  return (control.applicability === 'private-dast'
    ? project.state.applicability.privateStagingDast
    : project.state.applicability.statePath === 'bootstrap-local') ? 'applicable' : 'inapplicable';
}

function approvalBindsRepository(
  project: AssessmentProject,
  approval: ApprovalEnvelope,
  repository: string,
  now: Date
): boolean {
  const currentBaseline = project.inputSnapshot?.baselineSha ??
    project.bindingBaseline;
  if (!project.state || !currentBaseline) return false;
  const plan = boundPlan(project, approval.phaseId, now);
  const phase = canonicalPhaseGraph.phases.find((entry) => entry.id === approval.phaseId);
  const authority = plan && phase ? transitionPlanForPhase(phase, project.state, {
    phaseId: phase.id,
    baselineSha: plan.baselineDigest,
    inputDigest: plan.inputDigest,
    transitionDigest: plan.transitionDigest
  }) : null;
  return approval.baselineSha === currentBaseline &&
    project.identity.availability === 'known' &&
    Date.parse(approval.approvedAt) <= now.getTime() &&
    Date.parse(approval.expiresAt) > now.getTime() &&
    project.state.phases[approval.phaseId].approvals.includes(approval.id) &&
    Boolean(plan && authority && phase?.approvalGate.required) &&
    authority?.planDigest === approval.planDigest &&
    !evaluateApprovalForTransitionPlan(authority!, [approval], { now }).approvalRequired &&
    plan!.approval.envelopeId === approval.id &&
    plan!.approval.envelopeHash === canonicalApprovalEnvelopeHash(approval) &&
    approval.destinations.some((destination) =>
      destination.type === 'repository' &&
      (destination.repository ?? destination.identity).toLowerCase() === repository.toLowerCase()
    );
}

export function resolveAssessmentLiveScope(project: AssessmentProject, git: AssessmentGitFacts, now: Date): LiveAssessmentScope {
  let repository = git.originState === 'verified' ? git.repository : null;
  let remoteBindingVerified = false;
  if (git.repository && project.state?.remoteBinding) {
    const remote = project.state.remoteBinding;
    const bound = repositoryName(remote.name, remote.id);
    const matchingPush = git.pushUrls.length === 1 &&
      git.pushUrls[0] === remote.pushUrl &&
      project.inputSnapshot?.git.pushUrls.length === 1 &&
      project.inputSnapshot.git.pushUrls[0] === remote.pushUrl;
    if (!bound ||
        `${git.repository.owner}/${git.repository.name}`.toLowerCase() !==
          `${bound.owner}/${bound.name}`.toLowerCase() ||
        !matchingPush) {
      project.diagnostics.push({
        code: 'repository-binding-conflict',
        severity: 'warning',
        source: 'Git/activation state',
        message: 'Git fetch/push origin and the verified remote repository binding disagree; evidence-backed provider scope is withheld.'
      });
    } else {
      repository = { ...git.repository, id: bound.id };
      remoteBindingVerified = true;
    }
  }
  const scope: LiveAssessmentScope = {
    repository,
    refs: repository ? ['develop', 'main'] : [],
    ...(repository ? { refPrefixes: ['release/', 'hotfix/'] } : {}),
    environments: project.project ? [...project.project.workload.environments] : [],
    runner: null, azure: []
  };
  if (!repository || !project.state) return scope;
  if (!remoteBindingVerified) {
    project.diagnostics.push({
      code: 'remote-binding-unavailable',
      severity: 'warning',
      source: 'activation state',
      message: 'No matching verified remote repository binding is available; evidence-backed runner and Azure reads are withheld.'
    });
    return scope;
  }
  const fullName = `${repository.owner}/${repository.name}`;
  const azureBindings = new Map<string, LiveAssessmentScope['azure'][number]>();
  const conflictingAzureBindings = new Set<string>();
  for (const approval of project.approvals) {
    if (!approvalBindsRepository(project, approval, fullName, now)) continue;
    const environments = approval.destinations.filter((destination) => destination.type === 'environment' &&
      ['dev', 'staging', 'prod'].includes(destination.identity)).map((destination) => destination.identity);
    if (new Set(environments).size !== 1) continue;
    const environment = environments[0];
    if (environment !== 'dev' && environment !== 'staging' && environment !== 'prod') continue;
    const selected = selectBoundAssessmentEvidence(project, approval.phaseId, now);
    const payload = selected?.payload;
    const assessmentScope = isRecord(payload) && isRecord(payload.assessmentScope)
      ? payload.assessmentScope
      : null;
    if (!assessmentScope || !Array.isArray(assessmentScope.azure)) {
      if (
        approval.resources.some((resource) => resource.identity.startsWith('/subscriptions/')) &&
        !project.diagnostics.some((entry) =>
          entry.code === 'unbound-resource-role' && entry.source === approval.phaseId
        )
      ) {
        project.diagnostics.push({
          code: 'unbound-resource-role',
          severity: 'warning',
          source: approval.phaseId,
          message: 'Approved ARM resources lacked a current body-committed evidence payload with explicit assessment environment and role; Azure reads were withheld.'
        });
      }
      continue;
    }
    for (const value of assessmentScope.azure) {
      if (!isRecord(value) ||
          Object.keys(value).some((key) => ![
            'subscriptionId', 'environment', 'resourceId', 'resourceType', 'role'
          ].includes(key)) ||
          typeof value.subscriptionId !== 'string' ||
          value.environment !== environment ||
          typeof value.resourceId !== 'string' ||
          typeof value.resourceType !== 'string' ||
          !['state', 'application', 'runner-network'].includes(String(value.role))) {
        continue;
      }
      const subscriptionId = value.subscriptionId as string;
      const resourceId = value.resourceId as string;
      const resourceType = value.resourceType as string;
      const match = resourceId.match(/^\/subscriptions\/([a-f0-9-]{36})\/resourceGroups\/[^/]+\/providers\/([A-Za-z0-9.]+)\/([A-Za-z0-9]+)\/[^/]+(?:\/[A-Za-z0-9]+\/[^/]+)*$/iu);
      if (!match ||
          match[1]!.toLowerCase() !== subscriptionId.toLowerCase() ||
          !approval.resources.some((resource) =>
            resource.identity.toLowerCase() === resourceId.toLowerCase()
          ) ||
          !approval.destinations.some((destination) =>
            destination.type === 'subscription' &&
            (destination.subscriptionId ?? destination.identity).toLowerCase() === subscriptionId.toLowerCase()
          )) {
        continue;
      }
      const binding = {
        subscriptionId,
        environment: environment as LiveAssessmentScope['azure'][number]['environment'],
        resourceId,
        resourceType,
        role: value.role as LiveAssessmentScope['azure'][number]['role']
      };
      const key = binding.resourceId.toLowerCase();
      const previous = azureBindings.get(key);
      if (
        conflictingAzureBindings.has(key) ||
        previous && (
          previous.environment !== binding.environment ||
          previous.role !== binding.role ||
          previous.resourceType.toLowerCase() !== binding.resourceType.toLowerCase()
        )
      ) {
        azureBindings.delete(key);
        conflictingAzureBindings.add(key);
        project.diagnostics.push({
          code: 'conflicting-resource-binding',
          severity: 'warning',
          source: binding.resourceId,
          message: 'Conflicting body-committed ARM environment, role, or resource-type bindings were excluded before live scope deduplication.'
        });
        continue;
      }
      if (!previous) azureBindings.set(key, binding);
    }
  }
  const runnerRecord = selectBoundAssessmentEvidence(project, 'runner-ready', now);
  const rawRunner = runnerRecord?.payload;
  const runnerApproval = project.approvals.some((approval) =>
    approval.phaseId === 'runner-ready' &&
    approvalBindsRepository(project, approval, fullName, now)
  );
  if (runnerApproval && runnerRecord?.header.result === 'verified' &&
      isRecord(rawRunner) && rawRunner.kind === 'runner-ready.v1' &&
      rawRunner.organization === repository.owner && Number.isInteger(rawRunner.runnerId) && Number(rawRunner.runnerId) > 0 &&
      (rawRunner.groupId === null || Number.isInteger(rawRunner.groupId)) &&
      (rawRunner.networkConfigurationId === null || typeof rawRunner.networkConfigurationId === 'string')) {
    scope.runner = {
      organization: repository.owner, runnerId: Number(rawRunner.runnerId),
      groupId: rawRunner.groupId === null ? null : Number(rawRunner.groupId),
      networkConfigurationId: typeof rawRunner.networkConfigurationId === 'string' ? rawRunner.networkConfigurationId : null
    };
  }
  scope.azure = [...azureBindings.values()]
    .sort((a, b) => a.resourceId.localeCompare(b.resourceId, 'en'));
  return scope;
}

function predicateObservation(check: PredicateResult, from: Observation['source']): Observation {
  if (check.value === null || from === null) return notObserved(check.reason, from);
  if (check.absent) return absent(sanitizeAssessmentText(check.reason), from);
  const observation = observed(check.value, from);
  if (observation.availability === 'observed') observation.reason = sanitizeAssessmentText(check.reason);
  return observation;
}
function absent(reason: string, from: Observation['source']): Observation {
  return from ? { availability: 'missing', value: null, source: from, reason } : notObserved(reason);
}
function livePredicate(
  live: LiveAssessmentResult, key: string, evaluate: (value: JsonValue) => PredicateResult
): Observation {
  const observation = live.observations[key];
  if (!observation || observation.availability !== 'observed') return observation ?? notObserved(`Live ${key} was not collected.`);
  const converted = predicateObservation(evaluate(observation.value), observation.source);
  if (converted.availability === 'not-observed') converted.value = observation.value;
  else converted.facts = observation.value;
  return converted;
}
function partialLivePredicate(
  live: LiveAssessmentResult,
  key: string,
  evaluate: (value: JsonValue) => PredicateResult
): { observation: Observation; provenDifference: boolean } {
  const observation = live.observations[key];
  if (!observation) {
    return {
      observation: notObserved(`Live ${key} was not collected.`),
      provenDifference: false
    };
  }
  if (observation.availability === 'observed') {
    return {
      observation: livePredicate(live, key, evaluate),
      provenDifference: false
    };
  }
  if (observation.facts !== undefined) {
    const evaluated = evaluate(observation.facts);
    if (evaluated.value === false) {
      return {
        observation: {
          ...observation,
          reason: `${observation.reason ?? 'Live collection was incomplete.'} Independently observed facts prove a difference: ${evaluated.reason}`
        },
        provenDifference: true
      };
    }
  }
  return { observation, provenDifference: false };
}
function bool(value: boolean | null, reason: string): PredicateResult { return { value, reason }; }
function rows(value: unknown): Record<string, unknown>[] | null {
  return Array.isArray(value) && value.every(isRecord) ? value : null;
}

export function findAssessmentException(
  control: ControlDefinition, approvals: readonly ApprovalEnvelope[], scope: FindingScope,
  baseline: string | null, resource: string | undefined, now: Date
): AssessmentFinding['exception'] {
  if (!control.exceptionAllowed || !scope.repository || !baseline || !resource) return null;
  const found = approvals.find((approval) =>
    control.phaseIds.includes(approval.phaseId) && canonicalJson(approval.identity) === canonicalJson(currentActivationIdentity) &&
    approval.baselineSha === baseline && approval.policyExceptions.includes(control.id) &&
    Date.parse(approval.approvedAt) <= now.getTime() && Date.parse(approval.expiresAt) > now.getTime() &&
    approval.resources.some((entry) => entry.type === 'action-reference' && entry.identity === resource) &&
    approval.destinations.some((entry) => entry.type === 'repository' &&
      (entry.repository ?? entry.identity).toLowerCase() === scope.repository!.toLowerCase()) &&
    (scope.environment === null || approval.destinations.some((entry) =>
      entry.type === 'environment' && entry.identity === scope.environment))
  );
  return found ? { id: found.id, expiresAt: found.expiresAt, envelopeDigest: canonicalApprovalEnvelopeHash(found) } : null;
}

export function rejectedAssessmentExceptionDiagnostic(
  control: ControlDefinition,
  approvals: readonly ApprovalEnvelope[],
  exception: AssessmentFinding['exception']
): AssessmentDiagnostic | null {
  if (
    exception !== null ||
    !approvals.some((approval) => approval.policyExceptions.includes(control.id))
  ) {
    return null;
  }
  return {
    code: 'rejected-exception',
    severity: 'warning',
    source: control.id,
    message: 'A recorded exception was rejected because its current identity, baseline, scope, resource, approval time, or expiry did not match this finding.'
  };
}

function evidenceObservation(project: AssessmentProject, git: AssessmentGitFacts, capturedAt: string): Observation {
  if (!project.state) return notObserved('No compatible activation state is available.');
  if (project.invalidEvidence) return notObserved('Some evidence is malformed, sensitive, or uses unsupported schemas.');
  if (git.head) return notObserved('Current-worktree evidence binding cannot be established from stored state alone; historical records are not fresh live proof.');
  const complete = canonicalPhaseGraph.phases.every((phase) => {
    const stored = project.state!.phases[phase.id];
    if (stored.state === 'inapplicable') return false;
    if (stored.state === 'approved') return false;
    const record = selectBoundAssessmentEvidence(project, phase.id, new Date(capturedAt));
    return record?.header.result === stored.state && ['verified', 'retained', 'disposed'].includes(stored.state);
  });
  if (!complete) return notObserved('Baseline/setup progress, approvals, applicability and current readback are not all established.');
  return observed(true, source('evidence', 'governance/evidence', capturedAt, project.evidence.map((record) => record.header.phaseId)));
}

function invalidateUnstableObservations(
  findings: AssessmentFinding[],
  kinds: ReadonlySet<NonNullable<Observation['source']>['kind']>,
  reason: string
): void {
  for (const finding of findings) {
    if (finding.applicability === 'inapplicable') continue;
    let invalidated = false;
    for (const layer of finding.requiredProof) {
      const observation = finding.observations[layer];
      if (observation?.source && kinds.has(observation.source.kind)) {
        finding.observations[layer] = notObserved(reason);
        invalidated = true;
      }
    }
    if (!invalidated) continue;
    finding.exception = null;
    finding.missingProof = finding.requiredProof.filter((layer) =>
      finding.observations[layer]?.availability === 'not-observed'
    );
    const remaining = finding.requiredProof
      .map((layer) => finding.observations[layer])
      .filter((observation): observation is Observation => observation !== undefined);
    const absent = remaining.some((observation) => observation.availability === 'missing');
    const differs = remaining.some((observation) =>
      observation.availability === 'observed' &&
      canonicalJson(observation.value) !== canonicalJson(finding.expected)
    );
    finding.classification = differs
      ? 'conflicting'
      : absent
        ? 'missing'
        : 'not-observed';
    finding.reasons.push(reason);
  }
}

function invalidateChangedActivationAuthority(
  findings: AssessmentFinding[],
  controls: readonly ControlDefinition[]
): void {
  const controlsById = new Map(controls.map((control) => [
    control.id,
    control
  ]));
  for (const finding of findings) {
    const control = controlsById.get(finding.controlId);
    const evidenceDerivedApplicability =
      control?.applicability === 'private-dast' ||
      control?.applicability === 'state-path';
    if (
      finding.applicability === 'inapplicable' &&
        !evidenceDerivedApplicability ||
      !(
        evidenceDerivedApplicability ||
        finding.requiredProof.includes('evidence') ||
        finding.controlId.startsWith('azure.') ||
        finding.controlId.startsWith('runner.') ||
        finding.controlId.startsWith('evidence.')
      )
    ) {
      continue;
    }
    if (evidenceDerivedApplicability) {
      finding.applicability = 'unknown';
    }
    finding.classification = 'not-observed';
    finding.exception = null;
    finding.missingProof = [...finding.requiredProof];
    finding.reasons.push(
      'Current activation inputs, evidence references, evidence bodies, or reviewed plans changed during collection; evidence-backed scope and results were withheld.'
    );
    for (const layer of finding.requiredProof) {
      finding.observations[layer] = notObserved(
        'Activation authority changed during collection.'
      );
    }
  }
}

async function managedFindings(
  control: ControlDefinition, project: AssessmentProject, files: AssessmentFiles, scope: FindingScope, capturedAt: string
): Promise<AssessmentFinding[]> {
  const findings: AssessmentFinding[] = [];
  if (project.renderedCore.length === 0) {
    return [classifyFinding({
      control, scope, applicability: 'applicable',
      observations: {
        recorded: notObserved(project.kind === 'git'
          ? 'Ordinary Git repositories have no recorded Liftoff ownership inventory.'
          : 'Historical agent selection is not recorded.'),
        declared: notObserved(project.kind === 'git'
          ? 'No Liftoff managed handoff is inferred for an ordinary Git repository.'
          : 'The current handoff cannot be rendered without inferring agent configuration.')
      }
    })];
  }
  for (const artifact of project.renderedCore) {
    const text = await files.read(artifact.pathParts);
    const expected = `sha256:${sha256Hex(artifact.content)}`;
    const actual = text === null ? null : `sha256:${sha256Hex(text)}`;
    const entry = project.managedEntries.find((record) => record.logicalName === artifact.logicalName);
    const recorded = entry ? observed(entry.contentHash, source('file', 'liftoff.manifest.json', capturedAt, entry.contentHash))
      : notObserved(project.manifest ? 'Artifact is not in the recorded ownership inventory.' : 'Unsupported manifest identity; managed ownership is not being inferred.');
    const declared = actual === null
      ? absent('The exact target managed path is absent.', source('file', artifact.pathParts.join('/'), capturedAt))
      : observed(actual, source('file', artifact.pathParts.join('/'), capturedAt, actual));
    const difference = actual !== null && actual !== expected && entry?.contentHash === actual ? 'outdated'
      : actual !== null && actual !== expected ? 'conflicting'
      : actual === expected && entry && entry.contentHash !== expected ? 'outdated' : undefined;
    findings.push(classifyFinding({
      control, scope: { ...scope, resource: artifact.pathParts.join('/') }, expected,
      applicability: 'applicable', observations: { recorded, declared }, difference
    }));
  }
  return findings;
}

function evaluateControl(
  control: ControlDefinition, project: AssessmentProject, facts: LocalFacts, live: LiveAssessmentResult,
  git: AssessmentGitFacts, liveScope: LiveAssessmentScope, now: Date
): AssessmentFinding {
  const capturedAt = now.toISOString();
  const scope: FindingScope = { repository: liveScope.repository ? `${liveScope.repository.owner}/${liveScope.repository.name}` : null, environment: null, resource: null };
  const observations: Partial<Record<Layer, Observation>> = {};
  let expected = control.expected;
  let exceptionResource: string | undefined;
  let difference: 'conflicting' | undefined;
  const declaredRules = (predicate: (value: unknown) => PredicateResult) => facts.rulesets.length
    ? predicateObservation(predicate(facts.rulesets), facts.ruleSource) : absent('No declared ruleset payloads were found.', facts.ruleSource);
  switch (control.evaluator) {
    case 'identity': {
      expected = jsonValue({ manifest: currentActivationIdentity, state: project.identity.stateSource === 'not-started' ? null : currentActivationIdentity });
      observations.recorded = project.identity.recordedActivationIdentity === null
        ? notObserved('This historical manifest does not record an activation tuple.')
        : observed({ manifest: project.identity.recordedActivationIdentity, state: project.stateIdentity }, source('file', 'manifest and activation identity', capturedAt, { manifest: project.identity.recordedActivationIdentity, state: project.stateIdentity }));
      break;
    }
    case 'default-branch': {
      const remote = live.observations['github.repository'];
      observations.live = remote?.availability === 'observed' && isRecord(remote.value) && typeof remote.value.defaultBranch === 'string' && remote.source
        ? observed(remote.value.defaultBranch, remote.source) : remote ?? notObserved('Live repository default branch was not observed.');
      if (project.state) observations.recorded = observed(project.state.repository.defaultBranch, source('file', 'governance/activation-state.json', capturedAt, project.state.repository.defaultBranch));
      break;
    }
    case 'protected-refs': {
      const repository = live.observations['github.repository'];
      const branch = repository?.availability === 'observed' && isRecord(repository.value) && typeof repository.value.defaultBranch === 'string'
        ? repository.value.defaultBranch : null;
      observations.declared = declaredRules((value) => protectedRefs(value, project.state?.repository.defaultBranch ?? null));
      const rules = live.observations['github.rulesets'];
      const branches = live.observations['github.branches'];
      const families = live.observations['github.ref-families'];
      if (
        rules?.availability === 'observed' &&
        branches?.availability === 'observed' &&
        families?.availability === 'observed'
      ) {
        observations.live = predicateObservation(
          effectiveProtectedRefs(rules.value, branches.value, families.value, branch),
          rules.source
        );
        observations.live.facts = jsonValue({
          rulesets: rules.value,
          branches: branches.value,
          refFamilies: families.value
        });
      } else {
        observations.live = notObserved(
          'Complete repository/inherited rulesets, classic/effective branch protection, and bounded release/hotfix enumeration are required.'
        );
      }
      break;
    }
    case 'single-maintainer':
      observations.declared = declaredRules(singleMaintainer);
      observations.live = livePredicate(live, 'github.rulesets', singleMaintainer);
      break;
    case 'tag-controls': {
      const app = live.observations['github.actions-app'];
      if (app?.availability === 'observed' && isRecord(app.value) && typeof app.value.id === 'number' &&
          app.value.id > 0 && app.value.slug === 'github-actions') {
        const appId = app.value.id;
        observations.declared = declaredRules((value) => tagControls(value, appId));
        observations.live = livePredicate(live, 'github.rulesets', (value) => tagControls(value, appId));
      } else {
        observations.declared = facts.rulesets.length
          ? notObserved('The declared tag actor cannot be verified without the GitHub Actions application identity.', facts.ruleSource)
          : absent('No declared tag rulesets were found.', facts.ruleSource);
        observations.live = notObserved('The GitHub Actions bypass application identity was not observed.');
      }
      break;
    }
    case 'no-codeowners':
      observations.declared = facts.codeowners;
      break;
    case 'required-contexts': {
      const contexts = requiredCheckContexts(facts.rulesets);
      observations.declared = contexts === null ? notObserved('Required context declarations cannot be interpreted.')
        : contexts.length ? predicateObservation(bool(true, `Declared contexts: ${contexts.map((entry) => entry.name).join(', ')}`), facts.ruleSource)
          : absent('No required status check contexts were declared.', facts.ruleSource);
      const rules = live.observations['github.rulesets'];
      const branches = live.observations['github.branches'];
      const families = live.observations['github.ref-families'];
      const repository = live.observations['github.repository'];
      const branch = repository?.availability === 'observed' && isRecord(repository.value) && typeof repository.value.defaultBranch === 'string'
        ? repository.value.defaultBranch : null;
      const familyRefs = families?.availability === 'observed' && isRecord(families.value) &&
        Array.isArray(families.value.refs)
        ? families.value.refs.filter((value): value is string => typeof value === 'string')
        : [];
      const assessedRefs = [...new Set([...liveScope.refs, ...familyRefs])].sort();
      const comparisonRefs = assessedRefs.length ? assessedRefs : ['develop', 'main'];
      const declaredBindings = requiredContextBindings(facts.rulesets, comparisonRefs, branch);
      const rulesetBindings = rules?.availability === 'observed'
        ? requiredContextBindings(rules.value, comparisonRefs, branch)
        : null;
      const enforcedBindings = rules?.availability === 'observed' && branches?.availability === 'observed'
        ? effectiveRequiredContextBindings(rules.value, branches.value, comparisonRefs, branch)
        : rulesetBindings;
      observations.declared.facts = jsonValue(declaredBindings);
      const bindingsDiffer = Boolean(contexts?.length && declaredBindings && rulesetBindings &&
        canonicalJson(declaredBindings) !== canonicalJson(rulesetBindings));
      if (bindingsDiffer) {
        difference = 'conflicting';
        const checks = live.observations['github.checks'];
        const reason = 'Declared and enforced per-ref required context/application bindings differ.';
        observations.live = checks?.availability === 'observed'
          ? predicateObservation(bool(false, reason), rules?.source ?? null)
          : notObserved(`${reason} Check-run proof remains unobserved: ${checks?.reason ?? 'not collected'}`, rules?.source ?? null);
      } else {
        observations.live = rules?.availability === 'observed' &&
          families?.availability === 'observed' &&
          declaredBindings &&
          enforcedBindings
          ? livePredicate(
              live,
              'github.checks',
              (value) => observedRequiredContexts(rules.value, value, branch, branches?.value)
            )
          : notObserved('Live rule and exact commit-bound check observations are required.');
      }
      observations.live.facts = jsonValue({
        enforcedBindings, checkRuns: live.observations['github.checks']?.value ?? null
      });
      break;
    }
    case 'push-protection':
      observations.live = livePredicate(live, 'github.security', (value) => {
        if (!isRecord(value)) return bool(null, 'Security feature metadata is unavailable.');
        const scanning = isRecord(value.secret_scanning) ? value.secret_scanning.status : value.secretScanning;
        const protection = isRecord(value.secret_scanning_push_protection) ? value.secret_scanning_push_protection.status : value.pushProtection;
        return bool(typeof scanning === 'string' && typeof protection === 'string' ? scanning === 'enabled' && protection === 'enabled' : null,
          'Secret scanning and push protection must both be enabled; omitted fields are not evidence of absence.');
      });
      break;
    case 'workflow-permissions':
      observations.declared = facts.workflows.length ? predicateObservation(workflowPermissions(facts.workflows), facts.workflowSource)
        : absent('No workflow files were found.', facts.workflowSource);
      break;
    case 'action-pinning': {
      const check = pinnedActions(facts.workflows);
      observations.declared = predicateObservation(check, facts.workflowSource);
      exceptionResource = check.exceptionResource;
      break;
    }
    case 'fail-open-flags':
      observations.declared = predicateObservation(failOpenFlags(facts.workflows, facts.rulesets), facts.workflowSource);
      break;
    case 'pipeline': {
      observations.declared = predicateObservation(securityPipeline(facts.workflows), facts.workflowSource);
      if (observations.declared.availability === 'not-observed' && facts.workflowSource) {
        const inventory = observed(jsonValue({ actionReferences: actionReferences(facts.workflows) }), facts.workflowSource);
        if (inventory.availability === 'observed') observations.declared.value = inventory.value;
        else observations.declared = inventory;
      }
      observations.live = notObserved('Complete stage-role enforcement requires execution evidence, not a generic green workflow.');
      break;
    }
    case 'environments':
      expected = true;
      observations.live = livePredicate(live, 'github.environments', (value) => {
        const environments = rows(value);
        if (!environments) return bool(null, 'Environment inventory is unavailable.');
        const selected = liveScope.environments.map((name) => environments.find((entry) => entry.name === name));
        if (selected.some((entry) => !entry)) return {
          ...bool(false, 'A declared deployment environment is absent from the complete live inventory.'), absent: true
        };
        return bool(selected.every((entry) => typeof entry?.reviewers === 'number') ? selected.every((entry) => entry?.reviewers === 0) : null,
          'Declared deployment environments must not require human reviewers.');
      });
      break;
    case 'runner': {
      observations.recorded = liveScope.runner ? observed(true, source('evidence', 'runner-ready repository binding', capturedAt, jsonValue(liveScope.runner))) : notObserved('No current, exact runner/group/network binding is available.');
      observations.live = livePredicate(
        live,
        'github.runner',
        (value) => runnerAlignment(value, scope.repository)
      );
      break;
    }
    case 'providers': {
      const evaluation = partialLivePredicate(live, 'azure.providers', (value) => {
        const providers = rows(value);
        return bool(!providers?.length ? null : providers.every((entry) => entry.registrationState === 'Registered'), 'Every explicitly required namespace must have terminal Registered readback.');
      });
      observations.live = evaluation.observation;
      if (evaluation.provenDifference) difference = 'conflicting';
      expected = true;
      break;
    }
    case 'storage': {
      const evaluation = partialLivePredicate(live, 'azure.resources', (value) => {
        const storage = rows(value)?.filter((entry) => String(entry.resourceType).toLowerCase() === 'microsoft.storage/storageaccounts');
        if (!storage?.length) return bool(null, 'No explicit environment/role-bound storage observation is available.');
        const values = storage.map((entry) => {
          const sku = isRecord(entry.sku) ? entry.sku.name : entry.sku;
          if (typeof sku !== 'string' || !['state', 'application'].includes(String(entry.role)) || !['dev', 'staging', 'prod'].includes(String(entry.environment))) return null;
          return sku.endsWith(entry.role === 'state' || entry.environment !== 'dev' ? '_ZRS' : '_LRS');
        });
        return bool(values.includes(false) ? false : values.includes(null) ? null : true, 'State storage requires ZRS; application storage uses Dev LRS and Staging/Production ZRS.');
      });
      observations.live = evaluation.observation;
      if (evaluation.provenDifference) difference = 'conflicting';
      expected = true;
      break;
    }
    case 'network': {
      observations.recorded = liveScope.azure.some((entry) => entry.role === 'runner-network') ? observed(true, source('evidence', 'approved Staging network bindings', capturedAt, jsonValue(liveScope.azure))) : notObserved('No approved Staging network bindings were available.');
      const evaluation = partialLivePredicate(live, 'azure.resources', (value) => {
        const network = rows(value)?.filter((entry) => entry.role === 'runner-network');
        if (!network?.length) return bool(null, 'No bound runner-network readback is available.');
        const subnets = network.filter((entry) => String(entry.resourceType).toLowerCase() === 'microsoft.network/virtualnetworks/subnets');
        if (subnets.some((entry) => isRecord(entry.properties) && entry.properties.defaultOutboundAccess === true)) return bool(false, 'A runner subnet still enables implicit default outbound access.');
        return bool(null, 'Full subnet, route, DNS and exclusive NAT/Firewall proof is required; observed metadata alone is insufficient.');
      });
      observations.live = evaluation.observation;
      if (evaluation.provenDifference) difference = 'conflicting';
      break;
    }
    case 'evidence':
      observations.evidence = evidenceObservation(project, git, capturedAt);
      break;
    case 'documentation':
      observations.declared = facts.documentation;
      break;
    default:
      for (const layer of control.proofLayers) observations[layer] = notObserved(`No supported evaluator exists for ${control.id}; the required proof is not inferred.`);
  }
  const exception = findAssessmentException(
    control,
    project.approvals,
    scope,
    facts.baseline,
    exceptionResource,
    now
  );
  const exceptionDiagnostic = rejectedAssessmentExceptionDiagnostic(
    control,
    project.approvals,
    exception
  );
  if (
    exceptionDiagnostic &&
    !project.diagnostics.some((entry) =>
      entry.code === 'rejected-exception' && entry.source === control.id
    )
  ) {
    project.diagnostics.push(exceptionDiagnostic);
  }
  return classifyFinding({
    control, scope, expected, applicability: applicability(control, project, now), observations, difference,
    exception
  });
}

export async function assessGovernance(
  projectRoot: string,
  options: { live?: boolean; runner?: CommandRunner; now?: () => Date } = {}
): Promise<AssessmentReport> {
  const now = options.now ?? (() => new Date());
  const captured = now();
  const files = new AssessmentFiles(projectRoot);
  let target: AssessmentTarget | null = null;
  let projectIdentity: AssessmentProjectIdentity = {
    availability: 'unavailable', manifestVersion: null, cliVersion: null, profile: null,
    policyVersion: null, recordedActivationIdentity: null, stateSource: 'unavailable'
  };
  try {
    const loaded = loadAssessmentCatalog();
    target = loaded.target;
    let project: AssessmentProject;
    let git: AssessmentGitFacts;
    let initialActivationInspection: CurrentActivationInspection | null = null;
    let initialActivationFingerprint: string | null = null;
    try {
      project = await inspectAssessmentProject(files);
      git = await inspectAssessmentGit(projectRoot, options.runner);
    } catch (error) {
      if (!(error instanceof AssessmentInputError) || error.code !== 'project-not-found') {
        throw error;
      }
      git = await inspectAssessmentGit(projectRoot, options.runner);
      if (!git.isRepository) {
        throw new AssessmentInputError(
          'project-not-found',
          'No Liftoff manifest or valid Git worktree was found at the selected boundary.'
        );
      }
      project = ordinaryGitAssessmentProject();
    }
    if (project.manifest) {
      try {
        const activation = await inspectCurrentActivationEvidence(
          projectRoot,
          project.manifest,
          {
            ...(options.runner ? { runner: options.runner } : {}),
            now: captured
          }
        );
        initialActivationInspection = activation;
        initialActivationFingerprint = activationAuthorityFingerprint(activation);
        if (activation.status === 'inspected') {
          project.state = activation.state;
          project.stateIdentity = jsonValue(activation.state.identity);
          project.identity.stateSource = 'user';
          project.inputSnapshot = activation.snapshot;
          project.evidenceContexts = activation.contexts;
          project.evidence = activation.records;
          project.plans = activation.contexts[phaseIds[0]].reviewedPlans
            ? [...activation.contexts[phaseIds[0]].reviewedPlans!]
            : [];
          project.activationSelections = activation.selections;
          if (activation.migration) {
            const complete = activation.migration.revalidation.status === 'complete';
            project.diagnostics.push({
              code: complete ? 'activation-migration-committed' : 'activation-revalidation-blocked',
              severity: complete ? 'info' : 'warning',
              source: 'governance/migration-state.json',
              message: sanitizeAssessmentText(complete
                ? 'Local v2 migration and approved local revalidation are complete. Preserved v1 history is informational, not live enforcement proof.'
                : `Local v2 migration committed; revalidation is ${activation.migration.revalidation.status}. ${activation.migration.revalidation.nextAction} Run liftoff update --check after repairing the named blocker.`)
            });
          }
          for (const [phaseId, selection] of Object.entries(activation.selections)) {
            if (selection.selected && selection.historicalIssues?.length) {
              project.diagnostics.push({
                code: 'historical-evidence-ignored',
                severity: 'info',
                source: phaseId,
                message: sanitizeAssessmentText(
                  selection.historicalIssues.map((issue) => issue.message).join('; ')
                )
              });
            }
            if (selection.issues.length === 0) continue;
            project.invalidEvidence = true;
            project.diagnostics.push({
              code: 'invalid-current-evidence',
              severity: 'warning',
              source: phaseId,
              message: sanitizeAssessmentText(
                selection.issues.map((issue) => issue.message).join('; ')
              )
            });
          }
        }
      } catch (error) {
        project.identity.availability = 'unsupported';
        project.identity.stateSource = 'unsupported';
        project.diagnostics.push({
          code: 'activation-history-diagnostic-only',
          severity: 'warning',
          source: 'activation read-only inspection',
          message: sanitizeAssessmentText(
            error instanceof Error
              ? error.message
              : 'Activation history could not be interpreted as current executable proof.'
          )
        });
      }
    }
    projectIdentity = project.identity;
    const disabled = project.identity.profile === 'none';
    if (disabled) return assembleAssessmentReport({
      projectRoot, mode: options.live ? 'live' : 'local', target, projectIdentity,
      snapshot: { capturedAt: captured.toISOString(), repository: null, localHead: null, worktreeDigest: files.digest(), inputsStable: await files.stable() },
      findings: [], diagnostics: project.diagnostics, disabled: true
    });
    project.diagnostics.push(...git.issues.map((message): AssessmentDiagnostic => ({
      code: 'git-not-observed', severity: 'warning', message, source: 'Git metadata'
    })));
    const facts = await localFacts(files, project, captured.toISOString());
    const scope = resolveAssessmentLiveScope(project, git, captured);
    const repository = scope.repository ? `${scope.repository.owner}/${scope.repository.name}` : null;
    const live: LiveAssessmentResult = options.live ? await collectLiveAssessment(scope, { runner: options.runner, now })
      : { observations: {}, diagnostics: [], refsStable: true };
    const findings: AssessmentFinding[] = [];
    for (const control of loaded.catalog.controls) {
      if (control.evaluator === 'managed-core') {
        findings.push(...await managedFindings(control, project, files, { repository, environment: null, resource: null }, captured.toISOString()));
      } else findings.push(evaluateControl(control, project, facts, live, git, scope, captured));
    }
    const worktreeDigest = files.digest();
    let activationStable = true;
    if (project.manifest && initialActivationInspection && initialActivationFingerprint) {
      try {
        const finalActivation = await inspectCurrentActivationEvidence(
          projectRoot,
          project.manifest,
          {
            ...(options.runner ? { runner: options.runner } : {}),
            now: captured
          }
        );
        activationStable =
          activationAuthorityFingerprint(finalActivation) ===
          initialActivationFingerprint;
      } catch {
        activationStable = false;
      }
    }
    const finalGit = await inspectAssessmentGit(projectRoot, options.runner);
    const filesStable = await files.stable();
    const gitStable = canonicalJson(git) === canonicalJson(finalGit);
    const inputsStable = filesStable && gitStable && activationStable;
    if (!filesStable) {
      invalidateUnstableObservations(
        findings,
        new Set(['file', 'evidence']),
        'Relevant local files changed during collection; rerun assessment for current local proof.'
      );
    }
    if (!gitStable) {
      invalidateUnstableObservations(
        findings,
        new Set(['git']),
        'Relevant Git metadata changed during collection; rerun assessment for current Git proof.'
      );
    }
    if (!activationStable) {
      invalidateChangedActivationAuthority(
        findings,
        loaded.catalog.controls
      );
      project.diagnostics.push({
        code: 'activation-authority-changed',
        severity: 'warning',
        source: 'activation read-only inspection',
        message: 'Current activation inputs, evidence, state references, or reviewed plans changed during collection; dependent proof was withheld.'
      });
    }
    return assembleAssessmentReport({
      projectRoot, mode: options.live ? 'live' : 'local', target, projectIdentity,
      snapshot: { capturedAt: captured.toISOString(), repository, localHead: git.head, worktreeDigest, inputsStable },
      findings, diagnostics: [...project.diagnostics, ...live.diagnostics]
    });
  } catch (error) {
    const diagnostic: AssessmentDiagnostic = {
      code: error instanceof AssessmentInputError ? error.code : 'assessment-error', severity: 'error',
      message: sanitizeAssessmentText(error instanceof Error ? error.message : 'Assessment could not inspect its inputs.'),
      source: error instanceof AssessmentInputError && error.source ? sanitizeAssessmentText(error.source) : null
    };
    return assembleAssessmentReport({
      projectRoot, mode: options.live ? 'live' : 'local', target, projectIdentity,
      snapshot: { capturedAt: captured.toISOString(), repository: null, localHead: null, worktreeDigest: files.digest(), inputsStable: false },
      findings: [], diagnostics: [diagnostic], failed: true
    });
  }
}
