import os from 'node:os';
import path from 'node:path';
import {
  CANONICAL_SKILL_IDS,
  type CanonicalSkillDefinition,
  type SkillDeliveryPlan,
  type SkillOwnershipStore,
  type SkillProjectionRecord,
  type SkillScope
} from '../../domain/skills/contracts.js';
import { canonicalJson } from '../../domain/governance/activation/canonical-json.js';
import { canonicalSkillRoot, captureSkillFile } from '../../adapters/skills/discovery.js';
import {
  createSkillsTransactionApprovalStore,
  createSkillsOwnershipAuthorityStore,
  type UpdatePreviewOptions
} from '../../adapters/filesystem/update-previews.js';
import {
  inspectReviewedUpdateTransaction,
  type ReviewedUpdateTransactionInspection
} from '../../adapters/filesystem/reviewed-update-transaction.js';
import {
  checkedSkillCatalog,
  captureCanonicalSkillInputs,
  createSkillDeliveryPlan,
  type SkillPlanningDependencies
} from './planning.js';
import {
  executeSkillDeliveryPlan,
  recoverSkillDeliveryTransaction,
  type SkillExecutionDependencies,
  type SkillExecutionResult,
  type SkillsRecoveryOutcome
} from './execution.js';
import type { LegacyIntegrationEntry, SkillMigrationPlan } from './migration.js';
import { loadOwnershipStore, orderedSkillHosts, verifySkillOwnershipAuthority, skillOwnershipPathParts } from './ownership.js';
import {
  validateSkillsOptions,
  type SkillsCommandOptions,
  type SkillsSubcommand
} from './request.js';
import { hasUsableApprovalTerminal, requestUpdateApproval, type UpdateApprovalContext } from '../update/approval.js';
import { formatSkillsPlan, formatSkillsRecovery, formatRegisteredSkillMigrationPlan } from './output.js';
import type { ExecutionContext } from '../context.js';
import type { RegisteredSkillMigrationPlan } from './registered-migration.js';
import { skillsLifecycleFollowUps, type SkillsFollowUps } from './continuations.js';

export { parseRequestedHosts } from './request.js';
export type { SkillsCommandOptions } from './request.js';

export interface SkillsUseCaseDependencies extends Omit<SkillExecutionDependencies, 'approvalStore' | 'approvalContext'>,
  Omit<SkillPlanningDependencies, 'shadowRoot'> {
  homeDirectory?: string;
  approvalStore?: SkillExecutionDependencies['approvalStore'];
  approvalStorage?: UpdatePreviewOptions;
  presentMigrationPlan?: (plan: RegisteredSkillMigrationPlan) => void | Promise<void>;
}

export interface SkillsInspection {
  scope: SkillScope;
  targetRoot: string;
  managedCount: number;
  projections: readonly {
    record: SkillProjectionRecord;
    status: 'current' | 'modified' | 'missing';
  }[];
  legacyIntegrations: readonly LegacyIntegrationEntry[];
  transaction: ReviewedUpdateTransactionInspection;
}

interface SkillsResultHeader extends Partial<SkillsFollowUps> {
  schemaVersion: 1;
  command: 'skills';
  subcommand: SkillsSubcommand;
}

export type SkillsCommandResult = SkillsResultHeader & (
  | {
    outcome: 'listed'; ok: true; exitCode: 0;
    result: { catalogVersion: string; skills: readonly Omit<CanonicalSkillDefinition, 'content'>[] };
  }
  | { outcome: 'inspected'; ok: boolean; exitCode: 0 | 1; result: SkillsInspection }
  | { outcome: 'planned'; ok: true; exitCode: 0 | 2; authorization: 'not-requested' | 'required'; result: SkillDeliveryPlan }
  | { outcome: 'blocked-plan'; ok: false; exitCode: 1; result: SkillDeliveryPlan }
  | { outcome: 'executed'; ok: boolean; exitCode: 0 | 1 | 2; result: SkillExecutionResult }
  | { outcome: 'migration-blocked'; ok: false; exitCode: 1; result: SkillMigrationPlan }
  | { outcome: 'migration-not-required'; ok: true; exitCode: 0 | 2; result: SkillMigrationPlan }
  | { outcome: 'migration-update-required'; ok: false; exitCode: 2; result: SkillMigrationPlan; reason?: string }
  | { outcome: 'migration-planned'; ok: true; exitCode: 2; authorization: 'not-requested' | 'required'; result: RegisteredSkillMigrationPlan }
  | { outcome: 'migration-executed'; ok: boolean; exitCode: 0 | 1 | 2; result: SkillExecutionResult }
  | { outcome: 'recovery-required'; ok: false; exitCode: 1 | 2; result: ReviewedUpdateTransactionInspection }
  | { outcome: 'recovered'; ok: boolean; exitCode: 0 | 1 | 2; result: SkillsRecoveryOutcome }
);

export interface SkillsCommandFailure {
  schemaVersion: 1;
  command: 'skills';
  requestedSubcommand?: string;
  outcome: 'invalid';
  ok: false;
  exitCode: 1;
  result: { message: string };
}

async function inspectSkills(
  store: SkillOwnershipStore,
  options: SkillsCommandOptions,
  pending: ReviewedUpdateTransactionInspection
): Promise<SkillsInspection> {
  const projections: SkillsInspection['projections'][number][] = [];
  for (const record of Object.values(store.projections)) {
    if (options.skillId && options.skillId !== record.skillId ||
        options.hosts && !options.hosts.some((host) => record.consumers.includes(host))) continue;
    const current = await captureSkillFile(store.targetRoot, record.pathParts);
    projections.push({
      record,
      status: current.observation.state === 'absent' ? 'missing'
        : current.observation.contentHash === record.projectedContentHash && current.observation.mode === record.projectedMode ? 'current' : 'modified'
    });
  }
  const legacy = store.scope === 'project'
    ? await (await import('./migration.js')).inspectLegacyIntegrations(store.targetRoot) : [];
  return {
    scope: store.scope, targetRoot: store.targetRoot, managedCount: projections.length, projections,
    legacyIntegrations: legacy.filter((entry) => entry.exists &&
      (!options.hosts || options.hosts.includes(entry.host)) &&
      (!options.skillId || options.skillId === (entry.operation === 'assessment' ? 'governance-assess' : entry.operation))),
    transaction: pending
  };
}

export async function executeSkillsUseCase(
  request: SkillsCommandOptions,
  context?: Partial<ExecutionContext>,
  dependencies: SkillsUseCaseDependencies = {}
): Promise<SkillsCommandResult> {
  const options = validateSkillsOptions(request);
  const subcommand = options.subcommand!;
  const header: SkillsResultHeader = { schemaVersion: 1, command: 'skills', subcommand };
  if (subcommand === 'list') {
    const catalog = checkedSkillCatalog(dependencies.loadCatalog);
    await captureCanonicalSkillInputs(catalog, dependencies.catalogRoot);
    return {
      ...header, outcome: 'listed', ok: true, exitCode: 0,
      result: {
        catalogVersion: catalog.catalogVersion,
        skills: catalog.skills.filter((skill) => (!options.skillId || options.skillId === skill.id) &&
          (!options.hosts || options.hosts.some((host) => skill.supportedHosts.includes(host)))).map((skill) => {
          const { content: _content, ...entry } = skill;
          return entry;
        })
      }
    };
  }

  const cwd = path.resolve(context?.cwd ?? process.cwd());
  const home = path.resolve(dependencies.homeDirectory ?? os.homedir());
  const scope = options.scope!;
  const targetRoot = await canonicalSkillRoot(scope === 'user' ? home : path.resolve(cwd, options.project ?? '.'));
  const result = await executeScopedSkillsUseCase(options, { subcommand, cwd, home, scope, targetRoot }, context, dependencies);
  return {
    ...result,
    ...skillsLifecycleFollowUps(result, options, {
      cwd, scope, targetRoot,
      machine: options.json === true || !hasUsableApprovalTerminal({
        stdin: context?.stdin, stderr: context?.stderr ?? process.stderr
      })
    })
  };
}

async function executeScopedSkillsUseCase(
  options: SkillsCommandOptions,
  target: { subcommand: Exclude<SkillsSubcommand, 'list'>; cwd: string; home: string; scope: SkillScope; targetRoot: string },
  context: Partial<ExecutionContext> | undefined,
  dependencies: SkillsUseCaseDependencies
): Promise<SkillsCommandResult> {
  const { subcommand, cwd, home, scope, targetRoot } = target;
  const header: SkillsResultHeader = { schemaVersion: 1, command: 'skills', subcommand };
  const storage: UpdatePreviewOptions = {
    ...context?.updatePreview, ...dependencies.approvalStorage,
    homedir: home,
    ...(dependencies.now ? { clock: dependencies.now } : {})
  };
  const approvalStore = dependencies.approvalStore ?? createSkillsTransactionApprovalStore(targetRoot, scope, storage);
  const ownershipAuthority = dependencies.ownershipAuthority ?? createSkillsOwnershipAuthorityStore(targetRoot, scope, storage);
  const pending = await inspectReviewedUpdateTransaction(targetRoot, { transactionKind: 'skills', skillsScope: scope, approvalStore });
  if (subcommand === 'inspect') {
    const store = await loadOwnershipStore(scope, targetRoot);
    if ((await captureSkillFile(targetRoot, skillOwnershipPathParts)).observation.state === 'file') {
      await verifySkillOwnershipAuthority(store, ownershipAuthority);
    }
    const result = await inspectSkills(store, options, pending);
    const ok = result.projections.every((entry) => entry.status === 'current') && pending.status === 'absent';
    return { ...header, outcome: 'inspected', ok, exitCode: ok ? 0 : 1, result };
  }
  const requestedIntent = subcommand === 'plan' ? 'install' : subcommand;
  const approvalContext: UpdateApprovalContext = {
    stdin: options.json ? undefined : context?.stdin,
    stderr: context?.stderr ?? process.stderr,
    approveUpdatePlan: context?.approveUpdatePlan
  };
  if (pending.status !== 'absent') {
    const requestedSkills = options.skillId ? [options.skillId] : [...CANONICAL_SKILL_IDS];
    const identity = pending.skillsIdentity;
    if (options.check || subcommand === 'plan' || pending.status === 'blocked' || !identity ||
        identity.scope !== scope || identity.intent !== requestedIntent ||
        canonicalJson(identity.hosts) !== canonicalJson(orderedSkillHosts(options.hosts!)) ||
        canonicalJson(identity.skillIds) !== canonicalJson(requestedSkills) || !pending.planFingerprint) {
      return { ...header, outcome: 'recovery-required', ok: false, exitCode: 1, result: pending };
    }
    const interactive = !options.json && hasUsableApprovalTerminal(approvalContext);
    if (options.approvePlan === undefined && interactive) approvalContext.stderr.write(formatSkillsRecovery(pending));
    const approval = options.approvePlan === undefined && !interactive ? { status: 'required' as const }
      : await requestUpdateApproval({
        fingerprint: pending.planFingerprint, approvePlan: options.approvePlan,
        message: 'Recover only this original sealed skills transaction, without starting new work?'
      }, approvalContext);
    if (approval.status !== 'approved') {
      return { ...header, outcome: 'recovery-required', ok: false, exitCode: approval.status === 'mismatch' ? 1 : 2, result: pending };
    }
    const result = await recoverSkillDeliveryTransaction(targetRoot, scope, pending.planFingerprint, approvalStore, ownershipAuthority);
    const complete = result.status === 'committed' && result.verified && !result.uncertain;
    return {
      ...header, outcome: 'recovered', ok: complete,
      exitCode: result.status === 'blocked' || result.cleanupFailures.length > 0 ? 1 : complete ? 0 : 2,
      result
    };
  }
  if (subcommand === 'migrate') {
    const { planSkillMigration, executeSkillMigration } = await import('./migration.js');
    const selection = { hosts: options.hosts!, ...(options.skillId ? { skillIds: [options.skillId] } : {}) };
    const inspection = await planSkillMigration(targetRoot, selection);
    let directMigrationReason: string | undefined;
    if (inspection.execution === 'owning-update-required') {
      const { prepareRegisteredSkillMigration } = await import('./registered-migration.js');
      const prepared = await prepareRegisteredSkillMigration(targetRoot, selection, {
        storage: dependencies.workspaceStorage ?? storage, runner: context?.runner, now: dependencies.now ?? context?.updateNow
      });
      if (prepared.status === 'ready') {
        if (options.check) return {
          ...header, outcome: 'migration-planned', ok: true, exitCode: 2,
          authorization: 'not-requested', result: prepared.plan
        };
        const { executeRegisteredSkillMigration } = await import('./migration-execution.js');
        const result = await executeRegisteredSkillMigration(prepared.plan, {
          approvePlan: options.approvePlan, json: options.json
        }, {
          approvalStore, approvalContext, workspaceStorage: dependencies.workspaceStorage ?? storage,
          presentMigrationPlan: dependencies.presentMigrationPlan ??
            ((plan) => { approvalContext.stderr.write(formatRegisteredSkillMigrationPlan(plan)); }),
          onCheckpoint: dependencies.onCheckpoint, onBeforeMutation: dependencies.onBeforeMutation
        });
        return result.outcome === 'approval-required'
          ? {
            ...header, outcome: 'migration-planned', ok: true, exitCode: 2,
            authorization: 'required', result: prepared.plan
          }
          : {
            ...header, outcome: 'migration-executed', ok: result.ok,
            exitCode: result.ok ? 0 : result.outcome === 'declined' ? 2 : 1, result
          };
      }
      directMigrationReason = prepared.reason;
    }
    if (!options.check) await executeSkillMigration(inspection, { approvePlan: options.approvePlan });
    switch (inspection.execution) {
      case 'blocked':
        return { ...header, outcome: 'migration-blocked', ok: false, exitCode: 1, result: inspection };
      case 'owning-update-required':
        return {
          ...header, outcome: 'migration-update-required', ok: false, exitCode: 2, result: inspection,
          ...(directMigrationReason ? { reason: directMigrationReason } : {})
        };
      case 'not-required':
        return {
          ...header, outcome: 'migration-not-required', ok: true,
          exitCode: inspection.summary.maintenance > 0 ? 2 : 0, result: inspection
        };
      default: {
        const unsupported: never = inspection.execution;
        throw new Error(`Unsupported skill transport operation: ${String(unsupported)}`);
      }
    }
  }
  const intent = subcommand === 'plan' ? 'install' : subcommand;
  const plan = await createSkillDeliveryPlan({
    scope, targetRoot, hosts: options.hosts!, intent,
    ...(options.skillId ? { skillIds: [options.skillId] } : {})
  }, {
    now: dependencies.now, loadCatalog: dependencies.loadCatalog, ownershipAuthority, catalogRoot: dependencies.catalogRoot,
    shadowRoot: scope === 'user' ? cwd : home
  });
  if (plan.hasCollisions || plan.hasConflicts || plan.summary.blocked > 0) {
    return { ...header, outcome: 'blocked-plan', ok: false, exitCode: 1, result: plan };
  }
  if (subcommand === 'plan' || options.check) {
    return {
      ...header, outcome: 'planned', ok: true, authorization: 'not-requested',
      exitCode: subcommand === 'plan' || plan.summary.ownership === 0 ? 0 : 2, result: plan
    };
  }
  const result = await executeSkillDeliveryPlan(plan, { approvePlan: options.approvePlan, json: options.json }, {
    approvalStore, approvalContext,
    presentPlan: dependencies.presentPlan ?? ((review) => { approvalContext.stderr.write(formatSkillsPlan(review)); }),
    workspaceStorage: dependencies.workspaceStorage ?? storage,
    onCheckpoint: dependencies.onCheckpoint, onBeforeMutation: dependencies.onBeforeMutation
  });
  if (result.outcome === 'approval-required') {
    return { ...header, outcome: 'planned', ok: true, authorization: 'required', exitCode: 2, result: plan };
  }
  return {
    ...header, outcome: 'executed', ok: result.ok,
    exitCode: result.ok ? 0 : result.outcome === 'declined' ? 2 : 1,
    result
  };
}
