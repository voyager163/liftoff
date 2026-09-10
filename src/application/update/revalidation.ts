import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { loadManifest } from '../project/manifest.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { selectLatestPhaseEvidence } from '../../domain/governance/activation/evidence.js';
import { phaseById } from '../../domain/governance/activation/operations.js';
import { validateManifestActivationForExecution } from '../../domain/governance/activation/validators.js';
import type { ActivationIdentity, PhaseId, SavedTransitionPlan } from '../../domain/governance/activation/types.js';
import type { LiftoffManifest } from '../../domain/project/contracts.js';
import { inspectGovernanceTransition } from '../../governance-activation/commands.js';
import {
  previewLocalSeedPhase,
  type LocalSeedCommand,
  type LocalSeedPhaseId,
  type LocalSeedPhasePreview
} from '../../governance-activation/seed-lifecycle.js';
import {
  evidencePathParts, evidenceWriteOperation, safeTimestamp, stateWriteOperation
} from '../../governance-activation/transition-records.js';
import {
  executeApplyNext, type ApplyNextExecutionResult, type GovernanceTransitionInspection
} from '../../governance-activation/transitions.js';
import { NodeCommandRunner, formatCommand, type CommandResult, type CommandRunner, type RunCommandOptions } from '../../process-runner.js';
import {
  acceptDeclaredCommandOutputs, captureRetainedProjectInputs, changedRetainedProjectInputs,
  localValidationOutputPolicy, outputsForLocalCommand, type RetainedProjectInput
} from './protected-source.js';
import { formatUpdateCommand } from './command-guidance.js';
import { commandShellForPlatform, formatShellCommand } from '../../adapters/process/shell-command.js';

const localPhases: readonly LocalSeedPhaseId[] = ['seed-valid', 'seed-verified', 'seed-archived'];
const successfulStates = new Set(['verified', 'approved', 'inapplicable', 'retained', 'disposed']);
const commandTimeoutMs = 120_000;
const commandOutputLimit = 2 * 1024 * 1024;

export interface LocalRevalidationPhaseResult {
  phaseId: LocalSeedPhaseId;
  status: 'verified' | 'already-complete' | 'blocked';
  blockers: readonly string[];
  evidence: ApplyNextExecutionResult['evidence'];
  savedPlan: ApplyNextExecutionResult['savedPlan'];
}

export interface LocalRevalidationProgress {
  status: 'running' | 'blocked' | 'complete';
  phaseId: LocalSeedPhaseId | null;
  phaseResults: readonly LocalRevalidationPhaseResult[];
  nextIncompletePhase: PhaseId | null;
  blockers: readonly string[];
}

export interface LocalRevalidationResult extends Omit<LocalRevalidationProgress, 'status'> {
  status: 'blocked' | 'complete';
  nextAction: string;
}

export interface LocalRevalidationPreview {
  schemaVersion: 1;
  scope: 'local-seed-revalidation';
  projectRoot: string;
  targetIdentity: ActivationIdentity;
  targetManifestDigest: string;
  protectedInputBinding: string;
  phases: readonly LocalSeedPhasePreview[];
  reusedPhases: readonly { phaseId: LocalSeedPhaseId; evidenceId: string; headerDigest: string }[];
  inspectionCommands: readonly LocalSeedCommand[];
  recordWrites: {
    plans: 'governance/plans/<phase>-<fresh-timestamp>-<plan-digest>.json';
    evidence: 'governance/evidence/<phase>-<fresh-timestamp>.json';
    state: 'governance/activation-state.json';
    limit: 'At most one new plan and evidence record per listed phase; existing records are never replaced.';
  };
  commandLimits: { timeoutMs: number; maxOutputBytes: number };
  outputPolicy: typeof localValidationOutputPolicy;
  effects: readonly string[];
  boundary: 'Stop before Git publication, provider reads, credentials, or independently approved governance transitions.';
  fingerprint: string;
}

function isLocalPhase(phaseId: PhaseId): phaseId is LocalSeedPhaseId {
  return phaseId === 'seed-valid' || phaseId === 'seed-verified' || phaseId === 'seed-archived';
}

function inspectionCommands(): LocalSeedCommand[] {
  return [
    ['rev-parse', '--show-toplevel'],
    ['rev-parse', '--verify', 'HEAD'],
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    ['remote'],
    ['remote', 'get-url', '--push', '--all', 'origin']
  ].map((args) => ({ command: { executable: 'git', args }, cwdPathParts: [], env: {} }));
}

function executionDescription(): Pick<LocalRevalidationPreview, 'inspectionCommands' | 'recordWrites' | 'commandLimits' | 'outputPolicy' | 'effects' | 'boundary'> {
  return {
    inspectionCommands: inspectionCommands(),
    recordWrites: {
      plans: 'governance/plans/<phase>-<fresh-timestamp>-<plan-digest>.json',
      evidence: 'governance/evidence/<phase>-<fresh-timestamp>.json',
      state: 'governance/activation-state.json',
      limit: 'At most one new plan and evidence record per listed phase; existing records are never replaced.'
    },
    commandLimits: { timeoutMs: commandTimeoutMs, maxOutputBytes: commandOutputLimit },
    outputPolicy: localValidationOutputPolicy,
    effects: [
      'Local validation executes project-controlled code, not a sandbox. Exact commands and environment overrides are listed per phase.',
      'Only already available tools/dependencies are used. No dependency installation, tofu init, seed task edits, or archive replay is authorized.',
      'Checks may write tool/test/build caches and outputs; unexpected protected-input edits are preserved and block evidence.',
      'Repository scripts, tests, and existing outputs are bound before approval. Only listed command-specific generated outputs may change after that approved command executes.',
      'Fresh phase plans, evidence, and activation state are the only engine writes. The coordinator separately records migration progress.'
    ],
    boundary: 'Stop before Git publication, provider reads, credentials, or independently approved governance transitions.'
  };
}

function assertDigest(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a complete lowercase SHA-256 binding.`);
}

export async function previewLocalRevalidation(input: {
  projectRoot: string;
  targetManifest: LiftoffManifest;
  protectedInputBinding: string;
  inspection?: GovernanceTransitionInspection;
}): Promise<LocalRevalidationPreview> {
  validateManifestActivationForExecution(input.targetManifest);
  assertDigest(input.protectedInputBinding, 'Protected input');
  const projectRoot = await realpath(input.projectRoot);
  const identity = 'activationIdentity' in input.targetManifest.governance
    ? input.targetManifest.governance.activationIdentity : undefined;
  if (!identity) throw new Error('Local revalidation requires an explicit current activation target.');
  const phases: LocalSeedPhasePreview[] = [];
  const reusedPhases: LocalRevalidationPreview['reusedPhases'][number][] = [];
  const inspection = input.inspection;
  const canReuse = inspection && inspection.projectRoot === projectRoot &&
    canonicalSha256(inspection.manifest) === canonicalSha256(input.targetManifest) &&
    canonicalSha256(inspection.state.identity) === canonicalSha256(identity);
  for (const phaseId of localPhases) {
    const selected = canReuse && inspection.readiness.phases[phaseId].state === 'verified'
      ? selectLatestPhaseEvidence(inspection.evidence.filter((record) => record.header.phaseId === phaseId), inspection.contexts[phaseId]).selected
      : null;
    if (selected?.header.result === 'verified') {
      reusedPhases.push({ phaseId, evidenceId: selected.evidenceId, headerDigest: selected.headerDigest });
    } else {
      phases.push(await previewLocalSeedPhase(projectRoot, input.targetManifest, phaseId));
    }
  }
  const semantic: Omit<LocalRevalidationPreview, 'fingerprint'> = {
    schemaVersion: 1, scope: 'local-seed-revalidation', projectRoot, targetIdentity: identity,
    targetManifestDigest: canonicalSha256(input.targetManifest), protectedInputBinding: input.protectedInputBinding,
    phases, reusedPhases, ...executionDescription()
  };
  return { ...semantic, fingerprint: canonicalSha256(semantic) };
}

function nextIncompletePhase(inspection: GovernanceTransitionInspection): PhaseId | null {
  return inspection.graph.phases.find((phase) => !successfulStates.has(inspection.readiness.phases[phase.id].state))?.id ?? null;
}

function resumableLocalInspection(inspection: GovernanceTransitionInspection): GovernanceTransitionInspection {
  const phaseId = nextIncompletePhase(inspection);
  if (!phaseId || !isLocalPhase(phaseId) || inspection.readiness.phases[phaseId].state !== 'running' ||
    inspection.readiness.phases[phaseId].blockers.length) return inspection;
  // An interrupted operation is re-executed under fresh approval, never counted as proof.
  return { ...inspection, readiness: { ...inspection.readiness, nextReadyPhase: phaseId } };
}

function commandMatches(expected: LocalSeedCommand, projectRoot: string, command: LocalSeedCommand['command'], options?: RunCommandOptions): boolean {
  return canonicalSha256(expected.command) === canonicalSha256(command) &&
    path.resolve(options?.cwd ?? projectRoot) === path.resolve(projectRoot, ...expected.cwdPathParts) &&
    canonicalSha256(options?.env ?? {}) === canonicalSha256(expected.env) &&
    options?.stdin === undefined && options?.signal === undefined;
}

// The coordinator supplies its approved post-commit input binding and persists progress;
// journal/phase-record writes must not invalidate that binding.
export async function executeLocalRevalidation(input: {
  approvedPreview: LocalRevalidationPreview;
  protectedInputs: {
    binding: string;
    assertUnchanged: () => void | readonly RetainedProjectInput[] | Promise<void | readonly RetainedProjectInput[]>;
    afterCommand?: (command: LocalSeedCommand['command'], options?: RunCommandOptions) =>
      void | readonly RetainedProjectInput[] | Promise<void | readonly RetainedProjectInput[]>;
  };
  runner?: CommandRunner;
  clock?: () => Date;
  onProgress?: (progress: LocalRevalidationProgress) => void | Promise<void>;
}): Promise<LocalRevalidationResult> {
  const approved = input.approvedPreview;
  const runner = input.runner ?? new NodeCommandRunner();
  const clock = input.clock ?? (() => new Date());
  const phaseResults: LocalRevalidationPhaseResult[] = [];
  let current: GovernanceTransitionInspection | undefined;
  let activePhase: LocalSeedPhaseId | null = null;
  let protectedSnapshot: readonly RetainedProjectInput[] | undefined;
  let expectedCommands: readonly LocalSeedCommand[] = [];
  let commandIndex = 0;

  async function assertProtectedInputs(): Promise<void> {
    // Reuse only the inventory freshly checked by the coordinator, never one cached across boundaries.
    const observed = await input.protectedInputs.assertUnchanged();
    if (protectedSnapshot) {
      const changed = changedRetainedProjectInputs(protectedSnapshot,
        observed ?? await captureRetainedProjectInputs(approved.projectRoot));
      if (changed.length) throw new Error(`Protected inputs changed during local revalidation: ${changed.join(', ')}. Edits were preserved; no stale successful evidence is authorized. Run ${formatUpdateCommand(approved.projectRoot, 'check')} again.`);
    }
  }

  const guardedRunner: CommandRunner = {
    async run(command, options) {
      const metadata = inspectionCommands().some((expected) => commandMatches(expected, approved.projectRoot, command, options));
      const expected = expectedCommands[commandIndex];
      if (!metadata && (!expected || !commandMatches(expected, approved.projectRoot, command, options))) {
        throw new Error(`Operation is outside the approved local revalidation command sequence: ${formatCommand(command)}. Obtain a fresh preview.`);
      }
      if (metadata) {
        const result = await runner.run(command, { ...options, timeoutMs: commandTimeoutMs, maxOutputBytes: commandOutputLimit });
        if (canonicalSha256(result.command) !== canonicalSha256(command)) throw new Error('The local runner returned an outcome for a different command.');
        return result;
      }
      await assertProtectedInputs();
      let result: CommandResult;
      try {
        result = await runner.run(command, { ...options, timeoutMs: commandTimeoutMs, maxOutputBytes: commandOutputLimit });
      } finally {
        const observed = await input.protectedInputs.afterCommand?.(command, options);
        if (protectedSnapshot) {
          protectedSnapshot = acceptDeclaredCommandOutputs(
            protectedSnapshot, observed ?? await captureRetainedProjectInputs(approved.projectRoot),
            outputsForLocalCommand(approved.projectRoot, command, options)
          );
        }
        await assertProtectedInputs();
      }
      if (canonicalSha256(result.command) !== canonicalSha256(command)) throw new Error('The local runner returned an outcome for a different command.');
      commandIndex += 1;
      return result;
    }
  };

  const metadataRunner: CommandRunner = {
    async run(command, options) {
      if (!inspectionCommands().some((expected) => commandMatches(expected, approved.projectRoot, command, options))) {
        throw new Error('Revalidation inspection attempted a command outside the local Git metadata allowlist.');
      }
      return runner.run(command, { ...options, timeoutMs: commandTimeoutMs, maxOutputBytes: commandOutputLimit });
    }
  };
  const reinspect = async () => {
    await assertProtectedInputs();
    const inspection = await inspectGovernanceTransition(approved.projectRoot, { runner: guardedRunner, now: clock() });
    await assertProtectedInputs();
    return resumableLocalInspection(inspection);
  };

  function result(status: LocalRevalidationResult['status'], blockers: readonly string[] = []): LocalRevalidationResult {
    const next = current ? nextIncompletePhase(current) : null;
    return {
      status, phaseId: status === 'blocked' ? activePhase : null, phaseResults: [...phaseResults],
      nextIncompletePhase: next, blockers,
      nextAction: status === 'blocked'
        ? `Repair the named local prerequisite or review the separate setup transition, then run ${formatUpdateCommand(approved.projectRoot, 'check')} and approve a fresh plan.`
        : next ? `Local revalidation is complete. Review ${formatShellCommand({
          executable: 'liftoff', args: ['governance', 'plan', '--project', approved.projectRoot]
        }, commandShellForPlatform(process.platform))} for ${next}; update did not execute it.` : 'Local revalidation is complete.'
    };
  }

  try {
    const { fingerprint, ...semantic } = approved;
    if (fingerprint !== canonicalSha256(semantic)) throw new Error('The approved local revalidation preview was changed.');
    if (approved.schemaVersion !== 1 || approved.scope !== 'local-seed-revalidation' ||
      canonicalSha256({
        inspectionCommands: approved.inspectionCommands, recordWrites: approved.recordWrites,
        commandLimits: approved.commandLimits, outputPolicy: approved.outputPolicy,
        effects: approved.effects, boundary: approved.boundary
      }) !== canonicalSha256(executionDescription())) {
      throw new Error('The approved local inspection, record-write, or command-limit descriptions changed; obtain a fresh preview.');
    }
    assertDigest(input.protectedInputs.binding, 'Current protected input');
    if (input.protectedInputs.binding !== approved.protectedInputBinding) throw new Error(`Protected input binding differs from the approved preview; run ${formatUpdateCommand(approved.projectRoot, 'check')} again.`);
    if (await realpath(approved.projectRoot) !== approved.projectRoot) throw new Error('The approved project boundary changed.');
    if (approved.phases.length > localPhases.length ||
      approved.phases.some((phase, index) => !localPhases.includes(phase.phaseId) ||
        index > 0 && localPhases.indexOf(approved.phases[index - 1]!.phaseId) >= localPhases.indexOf(phase.phaseId))) {
      throw new Error('The approved local phase set is not a finite ordered seed revalidation plan.');
    }
    await assertProtectedInputs();
    const manifest = await loadManifest(approved.projectRoot);
    validateManifestActivationForExecution(manifest);
    if (!('activationIdentity' in manifest.governance) || canonicalSha256(manifest) !== approved.targetManifestDigest ||
      canonicalSha256(manifest.governance.activationIdentity) !== canonicalSha256(approved.targetIdentity)) {
      throw new Error('The committed target manifest/activation differs from the approved revalidation preview.');
    }
    protectedSnapshot = await captureRetainedProjectInputs(approved.projectRoot);
    current = await reinspect();
    if (!current.loadedState || current.state.repository.id === 'unbound') {
      throw new Error('Local revalidation starts only after the anchored v2 successor is committed.');
    }
    for (const reused of approved.reusedPhases) {
      const selected = selectLatestPhaseEvidence(current.evidence.filter((record) => record.header.phaseId === reused.phaseId), current.contexts[reused.phaseId]).selected;
      if (current.readiness.phases[reused.phaseId].state !== 'verified' || selected?.evidenceId !== reused.evidenceId ||
        selected.headerDigest !== reused.headerDigest) throw new Error(`Previously reviewed proof for ${reused.phaseId} is no longer current; obtain a fresh preview.`);
      phaseResults.push({
        phaseId: reused.phaseId, status: 'already-complete', blockers: [], savedPlan: null,
        evidence: { evidenceId: selected.evidenceId, pathParts: evidencePathParts(selected.evidenceId), headerDigest: selected.headerDigest, result: selected.header.result }
      });
    }
    for (const phase of approved.phases) {
      activePhase = phase.phaseId;
      await assertProtectedInputs();
      current = await reinspect();
      if (current.readiness.phases[phase.phaseId].state === 'verified') {
        const selected = selectLatestPhaseEvidence(current.evidence.filter((record) => record.header.phaseId === phase.phaseId), current.contexts[phase.phaseId]).selected;
        if (!selected || selected.header.result !== 'verified') throw new Error(`No current authoritative evidence remains for ${phase.phaseId}.`);
        phaseResults.push({
          phaseId: phase.phaseId, status: 'already-complete', blockers: [], savedPlan: null,
          evidence: { evidenceId: selected.evidenceId, pathParts: evidencePathParts(selected.evidenceId), headerDigest: selected.headerDigest, result: selected.header.result }
        });
        continue;
      }
      const next = nextIncompletePhase(current);
      if (next !== phase.phaseId || current.readiness.nextReadyPhase !== phase.phaseId) {
        throw new Error(`The next genuinely incomplete phase is ${next ?? 'none'}, not an executable approved ${phase.phaseId}. ${next ? current.readiness.phases[next].blockers.join(' ') : ''}`);
      }
      const fresh = await previewLocalSeedPhase(approved.projectRoot, current.manifest, phase.phaseId);
      if (canonicalSha256(fresh) !== canonicalSha256(phase)) throw new Error(`The approved ${phase.phaseId} operations or prerequisites changed; obtain a fresh preview.`);
      if (fresh.blockers.length) throw new Error(fresh.blockers.join(' '));
      expectedCommands = fresh.commands;
      commandIndex = 0;
      await input.onProgress?.({
        status: 'running', phaseId: activePhase, phaseResults: [...phaseResults],
        nextIncompletePhase: next, blockers: []
      });
      const execution = await executeApplyNext({
        inspection: current, reinspect, runner: guardedRunner, clock, localRevalidation: true,
        assertProtectedInputs,
        assertReviewedPlan(plan: SavedTransitionPlan) {
          const node = phaseById(current!.graph, phase.phaseId);
          const context = current!.contexts[phase.phaseId];
          const expectedOperations = [
            phase.operation,
            evidenceWriteOperation(node, evidencePathParts(`${phase.phaseId}-${safeTimestamp(plan.createdAt)}`)),
            stateWriteOperation(node)
          ];
          if (plan.phaseId !== phase.phaseId || canonicalSha256(plan.identity) !== canonicalSha256(approved.targetIdentity) ||
            plan.graphHash !== approved.targetIdentity.phaseGraphHash || plan.stateHash !== current!.loadedState?.contentHash ||
            plan.baselineDigest !== context.baselineSha || plan.inputDigest !== context.inputDigest ||
            plan.transitionDigest !== context.transition.transitionDigest || canonicalSha256(plan.operations) !== canonicalSha256(expectedOperations)) {
            throw new Error(`Saved transition operations for ${phase.phaseId} exceed the exact approved local preview.`);
          }
        }
      });
      phaseResults.push({
        phaseId: phase.phaseId, status: execution.applied ? 'verified' : 'blocked',
        blockers: execution.blockers, evidence: execution.evidence, savedPlan: execution.savedPlan
      });
      if (!execution.applied) throw new Error(execution.blockers.join(' ') || execution.message);
      if (commandIndex !== expectedCommands.length) throw new Error(`The ${phase.phaseId} outcome omitted reviewed local checks.`);
      current = await reinspect();
      if (current.readiness.phases[phase.phaseId].state !== 'verified') throw new Error(`The newly produced ${phase.phaseId} proof is not current.`);
    }
    await assertProtectedInputs();
    current = await reinspect();
    const incompleteLocal = localPhases.find((phaseId) => current!.readiness.phases[phaseId].state !== 'verified');
    if (incompleteLocal) {
      activePhase = incompleteLocal;
      throw new Error(`Local phase ${incompleteLocal} remains incomplete and is outside the completed approved operation set.`);
    }
    activePhase = null;
    const complete = result('complete');
    await input.onProgress?.(complete);
    return complete;
  } catch (error) {
    const blocker = error instanceof Error ? error.message : String(error);
    const blockers = [blocker];
    if (current) {
      try {
        current = await inspectGovernanceTransition(approved.projectRoot, { runner: metadataRunner, now: clock() });
        for (const [index, phase] of phaseResults.entries()) {
          if (phase.status !== 'blocked' && current.readiness.phases[phase.phaseId].state !== 'verified') {
            phaseResults[index] = { ...phase, status: 'blocked', blockers: [
              ...current.readiness.phases[phase.phaseId].blockers,
              'Previously observed proof is no longer current after revalidation; preserved inputs require a fresh preview.'
            ] };
          }
        }
      } catch (inspectionError) {
        current = undefined;
        blockers.push(`Current revalidation readiness cannot be inspected: ${inspectionError instanceof Error ? inspectionError.message : String(inspectionError)}`);
      }
    }
    if (activePhase && !phaseResults.some((phase) => phase.phaseId === activePhase && phase.status === 'blocked')) {
      const existing = phaseResults.findIndex((phase) => phase.phaseId === activePhase);
      if (existing >= 0) phaseResults[existing] = { ...phaseResults[existing]!, status: 'blocked', blockers: [blocker] };
      else phaseResults.push({ phaseId: activePhase, status: 'blocked', blockers: [blocker], evidence: null, savedPlan: null });
    }
    const blocked = result('blocked', blockers);
    try {
      await input.onProgress?.(blocked);
    } catch (progressError) {
      return { ...blocked, blockers: [...blocked.blockers, `Revalidation progress could not be persisted: ${progressError instanceof Error ? progressError.message : String(progressError)}`] };
    }
    return blocked;
  }
}
