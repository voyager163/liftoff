import { pathExists } from '../../adapters/filesystem/governance-records.js';
import { readProjectFile } from '../../adapters/filesystem/project-files.js';
import { resolveProjectPath } from '../../adapters/filesystem/project-paths.js';
import { selectLatestPhaseEvidence } from '../../domain/governance/activation/evidence.js';
import { currentActivationIdentity } from '../../domain/governance/activation/graph.js';
import { type PhaseId, type PhaseState, phaseIds, phaseScope } from '../../domain/governance/activation/types.js';
import { governanceActivationPolicyVersion } from '../../domain/governance/policy/identity.js';
import { validateGovernancePolicy } from '../../domain/governance/policy/policy-contract.js';
import { governanceArtifactPaths } from '../../domain/project/catalog.js';
import type { LiftoffManifest } from '../../domain/project/contracts.js';
import { validateArtifactPathParts } from '../../domain/project/paths.js';
import {
  projectGovernanceChangeTasks,
  projectOpenSpecTaskCheckboxes
} from '../../governance-activation/task-projection.js';
import { errorMessage } from '../../governance-activation/transition-process.js';
import { type GovernanceInspection, managedPhaseGraphPathParts } from './inspection.js';

type CheckStatus = 'passed' | 'failed' | 'skipped';

export interface VerificationCheck {
  id: string;
  status: CheckStatus;
  issues: readonly string[];
}

export type SetupCompletionStatus = 'not-started' | 'in-progress' | 'complete';

const terminalEvidenceStates = new Set<PhaseState>([
  'verified',
  'failed',
  'inapplicable',
  'retained',
  'disposed'
]);

const successfulSetupStates = new Set<PhaseState>([
  'approved',
  'verified',
  'inapplicable',
  'retained',
  'disposed'
]);

const terminalPhaseStates = new Set<PhaseState>([
  ...successfulSetupStates,
  'failed'
]);

export function verificationPhaseIds(inspection: GovernanceInspection): readonly PhaseId[] {
  return phaseIds.filter((id) => phaseScope(id) === inspection.scope ||
    inspection.scope === 'activation' && phaseScope(id) === 'local');
}

function validatePolicyIdentity(inspection: GovernanceInspection): VerificationCheck {
  const issues: string[] = [];
  if (inspection.manifest.governance.profile !== 'none' && inspection.manifest.governance.profile !== 'unspecified') {
    if (inspection.manifest.governance.policyVersion !== governanceActivationPolicyVersion) {
      issues.push(
        `Manifest governance policyVersion ${inspection.manifest.governance.policyVersion ?? 'missing'} does not match ${governanceActivationPolicyVersion}.`
      );
    }
  }
  return { id: 'manifest-policy-identity', status: issues.length === 0 ? 'passed' : 'failed', issues };
}

async function validateManagedPolicy(projectRoot: string, manifest: LiftoffManifest): Promise<VerificationCheck> {
  if (manifest.governance.profile === 'none' || manifest.governance.profile === 'unspecified') {
    return { id: 'managed-policy', status: 'skipped', issues: [] };
  }
  const bytes = await readProjectFile(projectRoot, [...governanceArtifactPaths.policy]);
  const issues: string[] = [];
  if (bytes === undefined) {
    issues.push(`${governanceArtifactPaths.policy.join('/')} is missing.`);
  } else {
    try {
      validateGovernancePolicy(bytes.toString('utf8'));
    } catch (error) {
      issues.push(errorMessage(error));
    }
  }
  return { id: 'managed-policy', status: issues.length === 0 ? 'passed' : 'failed', issues };
}

function validateStateEvidence(inspection: GovernanceInspection): VerificationCheck {
  const issues: string[] = [];
  if (inspection.stateSource === 'not-started') {
    return { id: 'state-evidence', status: 'passed', issues };
  }
  for (const phaseId of verificationPhaseIds(inspection)) {
    const stored = inspection.state.phases[phaseId];
    if (!terminalEvidenceStates.has(stored.state)) {
      continue;
    }
    const records = inspection.evidence.filter((record) => record.header.phaseId === phaseId);
    const current = selectLatestPhaseEvidence(records, inspection.contexts[phaseId]);
    if (!current.selected || current.selected.header.result !== stored.state) {
      issues.push(`Phase ${phaseId} is stored as ${stored.state} but has no current matching authoritative evidence.`);
    }
  }
  return { id: 'state-evidence', status: issues.length === 0 ? 'passed' : 'failed', issues };
}

function validatePhaseTerminalStates(inspection: GovernanceInspection): VerificationCheck {
  const issues: string[] = [];
  for (const phase of inspection.graph.graph.phases.filter((phase) => verificationPhaseIds(inspection).includes(phase.id))) {
    const allowed = phase.terminalStates as readonly string[];
    const stored = inspection.state.phases[phase.id].state;
    const selected = selectLatestPhaseEvidence(
      inspection.evidence.filter((record) => record.header.phaseId === phase.id),
      inspection.contexts[phase.id]
    ).selected;
    if (selected && !allowed.includes(selected.header.result)) {
      issues.push(
        `Evidence ${selected.evidenceId} reports ${selected.header.result}, ` +
          `which is not an allowed terminal state for ${phase.id}.`
      );
    }
    if (terminalPhaseStates.has(stored) && !allowed.includes(stored)) {
      issues.push(`Phase ${phase.id} is stored as ${stored}, which is not an allowed terminal state.`);
    }
    const calculated = inspection.readiness.phases[phase.id].state;
    if (
      calculated !== 'identity-incompatible' &&
      terminalPhaseStates.has(calculated) &&
      !allowed.includes(calculated)
    ) {
      issues.push(`Phase ${phase.id} resolves to ${calculated}, which is not an allowed terminal state.`);
    }
  }
  return {
    id: 'phase-terminal-state',
    status: issues.length === 0 ? 'passed' : 'failed',
    issues
  };
}

function validateEvidenceFreshnessCheck(inspection: GovernanceInspection): VerificationCheck {
  const issues = verificationPhaseIds(inspection).flatMap((phaseId) => {
    const freshness = inspection.evidenceFreshness[phaseId];
    return freshness.status === 'fresh'
      ? []
      : freshness.issues.map((issue) => `${phaseId}: ${issue}`);
  });
  return { id: 'evidence-freshness', status: issues.length === 0 ? 'passed' : 'failed', issues };
}

function archivedSeedIntegrityCheck(inspection: GovernanceInspection): VerificationCheck {
  if (inspection.archivedSeedIntegrity.status === 'invalid') {
    return {
      id: 'archived-seed-integrity',
      status: 'failed',
      issues: inspection.archivedSeedIntegrity.issues
    };
  }
  return {
    id: 'archived-seed-integrity',
    status: inspection.archivedSeedIntegrity.status === 'valid' ? 'passed' : 'skipped',
    issues: []
  };
}

function validateReadinessCheck(inspection: GovernanceInspection): VerificationCheck {
  if (inspection.readiness.identityCompatible) {
    return { id: 'readiness', status: 'passed', issues: [] };
  }
  return {
    id: 'readiness',
    status: 'failed',
    issues: [inspection.readiness.identityBlocker ?? 'Activation identity is incompatible.']
  };
}

function extractPhaseTaskMappings(markdown: string): Array<{ phaseId: PhaseId; taskId: string }> {
  const phaseIdSet = new Set<string>(phaseIds);
  const mappings: Array<{ phaseId: PhaseId; taskId: string }> = [];
  const pattern = /^\s*[-*]\s+\[[ xX]\]\s+(\S+).*<!--\s*liftoff-phase:\s*([a-z0-9-]+)\s*-->/u;
  for (const line of markdown.split(/\r?\n/u)) {
    const match = line.match(pattern);
    if (!match) continue;
    const phaseId = match[2]!;
    if (!phaseIdSet.has(phaseId)) {
      throw new Error(`Task projection references unknown phase ${phaseId}.`);
    }
    mappings.push({ phaseId: phaseId as PhaseId, taskId: match[1]! });
  }
  return mappings;
}

async function activeTaskProjectionCheck(inspection: GovernanceInspection): Promise<VerificationCheck> {
  const issues: string[] = [];
  let inspected = false;
  if (inspection.scope !== 'lifecycle' && inspection.manifest.project.specWorkflow === 'spec-kit') {
    inspected = true;
    const bytes = await readProjectFile(inspection.projectRoot, ['specs', '000-liftoff-bootstrap', 'tasks.md']);
    if (!bytes) return { id: 'task-projection', status: 'failed', issues: ['Spec Kit seed-adoption-required: real bootstrap tasks are missing.'] };
    const expected = inspection.readiness.phases['seed-verified'].state === 'verified';
    const tasks = [...bytes.toString('utf8').matchAll(/^\s*- \[([ xX])\] (B00[1-6]) /gm)];
    issues.push(...tasks.filter((match) => (match[1]!.toLowerCase() === 'x') !== expected)
      .map((match) => `Spec Kit task ${match[2]} differs from the authoritative local baseline projection. Verification did not edit it.`));
  }
  const activeChange = inspection.state.activeChange;
  if (activeChange && activeChange.kind === 'openspec') {
    const pathParts = validateArtifactPathParts(['openspec', 'changes', activeChange.id, 'tasks.md'], 'Active OpenSpec task path');
    const bytes = await readProjectFile(inspection.projectRoot, pathParts);
    if (bytes !== undefined) {
      inspected = true;
      const markdown = bytes.toString('utf8');
      const mappings = extractPhaseTaskMappings(markdown);
      if (mappings.length > 0) {
        const projection = projectOpenSpecTaskCheckboxes(markdown, mappings, inspection.readiness.phases);
        issues.push(...projection.changes.filter((change) => verificationPhaseIds(inspection).includes(change.phaseId)).map((change) =>
          `Task ${change.taskId} for ${change.phaseId} is ${change.fromChecked ? 'checked' : 'unchecked'} but authoritative phase state is ${change.state}.`
        ));
      }
    }
  }
  const source = inspection.sourceOfTruth;
  if (inspection.scope !== 'local' && source.status === 'selected') {
    inspected = true;
    if (!source.selected.metadata) {
      issues.push('The selected current governance source has no validated metadata.');
    } else {
      const pathParts = validateArtifactPathParts([...source.selected.pathParts, 'tasks.md'], 'Current governance task path');
      const bytes = await readProjectFile(inspection.projectRoot, pathParts);
      if (!bytes) issues.push(`Current governance tasks ${pathParts.join('/')} are missing.`);
      else {
        const projection = projectGovernanceChangeTasks(bytes.toString('utf8'), source.selected.metadata, inspection.readiness.phases);
        issues.push(...projection.changes.filter((change) => verificationPhaseIds(inspection).includes(change.phaseId)).map((change) =>
          `Task ${change.taskId} for ${change.phaseId} is ${change.fromChecked ? 'checked' : 'unchecked'} but current authoritative phase state is ${change.state}.`
        ));
      }
    }
  }
  return { id: 'task-projection', status: issues.length ? 'failed' : inspected ? 'passed' : 'skipped', issues };
}

function activeChangeIdentityCheck(inspection: GovernanceInspection): VerificationCheck {
  const activeChange = inspection.state.activeChange;
  if (!activeChange) {
    return { id: 'active-change-identity', status: 'skipped', issues: [] };
  }
  const issues: string[] = [];
  try {
    validateArtifactPathParts(
      activeChange.kind === 'openspec'
        ? ['openspec', 'changes', activeChange.id]
        : ['specs', activeChange.id],
      'Active change path'
    );
  } catch (error) {
    issues.push(errorMessage(error));
  }
  return { id: 'active-change-identity', status: issues.length === 0 ? 'passed' : 'failed', issues };
}

function liveReadbackCheck(inspection: GovernanceInspection): VerificationCheck {
  const issues = inspection.graph.graph.phases.filter((phase) => verificationPhaseIds(inspection).includes(phase.id)).flatMap((phase) => {
    if (phase.evidence.liveReadbackProviders.length === 0) {
      return [];
    }
    const freshness = inspection.evidenceFreshness[phase.id];
    return freshness.status === 'fresh'
      ? []
      : freshness.issues.map((issue) => `${phase.id}: ${issue}`);
  });
  return { id: 'live-readback', status: issues.length === 0 ? 'passed' : 'failed', issues };
}

function credentialPolicyCheck(inspection: GovernanceInspection): VerificationCheck {
  if (inspection.scope !== 'activation') return { id: 'credential-policy', status: 'skipped', issues: [] };
  if (!inspection.credential.applicable) {
    return { id: 'credential-policy', status: 'skipped', issues: [] };
  }
  if (inspection.state.applicability.credentialRequired === 'unknown' &&
    !terminalEvidenceStates.has(inspection.state.phases['credential-ready'].state)) {
    return { id: 'credential-policy', status: 'skipped', issues: inspection.credential.issues };
  }
  return {
    id: 'credential-policy',
    status: inspection.credential.ready ? 'passed' : 'failed',
    issues: inspection.credential.issues
  };
}

function activeSourceOfTruthCheck(inspection: GovernanceInspection): VerificationCheck {
  const source = inspection.sourceOfTruth;
  if (inspection.scope === 'local') {
    if (source.status === 'seed-blocked' && !inspection.expectedActiveSeed) {
      return { id: 'active-source-of-truth', status: 'failed', issues: source.blockers };
    }
    return { id: 'active-source-of-truth', status: 'skipped', issues: [] };
  }
  if (inspection.expectedActiveSeed) {
    return {
      id: 'active-source-of-truth',
      status: 'skipped',
      issues: ['The generated bootstrap seed is still active; governance creation remains gated until its baseline and archive phases finish.']
    };
  }
  if (source.status === 'selected' || source.status === 'none') {
    if (source.status === 'selected' && source.reconciliation.status !== 'not-required') {
      return {
        id: 'active-source-of-truth',
        status: 'failed',
        issues: source.reconciliation.issues
      };
    }
    return { id: 'active-source-of-truth', status: 'passed', issues: [] };
  }
  if (source.status === 'seed-blocked' || source.status === 'ambiguous' || source.status === 'incompatible') {
    return {
      id: 'active-source-of-truth',
      status: 'failed',
      issues: source.blockers
    };
  }
  return { id: 'active-source-of-truth', status: 'failed', issues: ['Unknown active source-of-truth status.'] };
}

export async function verifyChecks(inspection: GovernanceInspection): Promise<VerificationCheck[]> {
  const managedGraphPresent = await pathExists(await resolveProjectPath(inspection.projectRoot, [...managedPhaseGraphPathParts]));
  return [
    { id: 'phase-graph', status: 'passed', issues: [] },
    {
      id: 'graph-identity',
      status: inspection.graph.hash === currentActivationIdentity.phaseGraphHash ? 'passed' : 'failed',
      issues: inspection.graph.hash === currentActivationIdentity.phaseGraphHash
        ? []
        : [`Graph hash ${inspection.graph.hash} does not match activation identity.`]
    },
    {
      id: 'managed-graph-source',
      status: managedGraphPresent || inspection.graph.source === 'packaged' ? 'passed' : 'failed',
      issues: []
    },
    validatePolicyIdentity(inspection),
    await validateManagedPolicy(inspection.projectRoot, inspection.manifest),
    {
      id: 'activation-state',
      status: inspection.stateSource === 'not-started' ? 'skipped' : 'passed',
      issues: inspection.stateSource === 'not-started'
        ? ['No user activation state exists; reporting deterministic not-started view.']
        : []
    },
    activeChangeIdentityCheck(inspection),
    activeSourceOfTruthCheck(inspection),
    archivedSeedIntegrityCheck(inspection),
    validateEvidenceFreshnessCheck(inspection),
    validateStateEvidence(inspection),
    validatePhaseTerminalStates(inspection),
    credentialPolicyCheck(inspection),
    liveReadbackCheck(inspection),
    await activeTaskProjectionCheck(inspection),
    validateReadinessCheck(inspection)
  ];
}

export function setupCompletion(inspection: GovernanceInspection): {
  status: SetupCompletionStatus;
  complete: boolean;
  summary: string;
} {
  if (inspection.stateSource === 'not-started') {
    return {
      status: 'not-started',
      complete: false,
      summary: `Verification is consistent, but setup has not started. Next ready phase: ${inspection.readiness.nextReadyPhase ?? 'none'}.`
    };
  }
  if (inspection.readiness.completion[inspection.scope]) {
    return {
      status: 'complete',
      complete: true,
      summary: inspection.scope === 'local'
        ? 'Local setup is complete. Repository publication, cloud deployment, and governance activation are separate approved work.'
        : inspection.scope === 'activation'
          ? 'Governance activation is complete. Delayed retained-state disposal is tracked separately.'
          : 'Lifecycle work is complete.'
    };
  }
  return {
    status: 'in-progress',
    complete: false,
    summary: inspection.readiness.nextReadyPhase
      ? `Verification is consistent, but setup is incomplete. Next ready phase: ${inspection.readiness.nextReadyPhase}.`
      : 'Verification is consistent, but setup is incomplete and currently blocked.'
  };
}
