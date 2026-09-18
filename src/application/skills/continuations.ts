import {
  createStructuredContinuation, type StructuredContinuationV1
} from '../../protocol/continuation.js';
import { ProtocolValidationError } from '../../protocol/schema.js';
import { ContinuationError } from '../../domain/execution/continuation.js';
import { parseCommandTokens, UsageError } from '../../domain/execution/command-line.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import {
  CANONICAL_SKILL_IDS, type SkillHostId, type SkillScope
} from '../../domain/skills/contracts.js';
import { skillsDeliveryRecipe, skillAliasRetirementRecipe } from '../../domain/skills/identity.js';
import type { ReviewedUpdateTransactionInspection } from '../../adapters/filesystem/reviewed-update-transaction.js';
import { liftoffVersion } from '../../version.js';
import {
  SkillsRequestError, validateSkillsCommandRequest,
  type SkillsCommandOptions, type SkillsSubcommand
} from './request.js';
import type { SkillsCommandResult } from './use-case.js';

type ContinuationContext = Omit<StructuredContinuationV1, 'schemaVersion' | 'executable' | 'displayCommand'>;

export interface SkillsContinuationGuidance {
  executable: null;
  reasonCode: 'user-target-not-addressable' | 'recovery-not-addressable' | 'operation-blocked' | 'context-not-admitted';
  message: string;
  context?: ContinuationContext;
}

export interface SkillsFollowUps {
  nextActions: readonly StructuredContinuationV1[];
  nextActionGuidance: readonly SkillsContinuationGuidance[];
}

export interface SkillsFollowUpTarget {
  cwd: string;
  targetRoot: string;
  scope: SkillScope;
  machine: boolean;
}

interface Selection {
  hosts?: readonly SkillHostId[];
  skillId?: SkillsCommandOptions['skillId'];
}

export function skillsLifecycleFollowUps(
  result: SkillsCommandResult, options: SkillsCommandOptions, target: SkillsFollowUpTarget
): SkillsFollowUps {
  const nextActions: StructuredContinuationV1[] = [];
  const nextActionGuidance: SkillsContinuationGuidance[] = [];
  const selection: Selection = { hosts: options.hosts, skillId: options.skillId };
  const compatibility = (command: SkillsSubcommand) => canonicalSha256({
    command: 'skills', schemaVersion: 1, cliVersion: liftoffVersion,
    recipe: command === 'migrate' ? skillAliasRetirementRecipe : skillsDeliveryRecipe
  });
  const emit = (
    command: SkillsSubcommand,
    selected: Selection = selection,
    settings: {
      check?: boolean;
      fingerprint?: string;
      requiredAuthority?: readonly string[];
      compatibilityIdentity?: string;
      guidance?: Pick<SkillsContinuationGuidance, 'reasonCode' | 'message'>;
    } = {}
  ) => {
    const args = [
      'skills', command, '--scope', target.scope,
      ...(target.scope === 'project' ? ['--project', target.targetRoot] : []),
      ...(selected.hosts ? ['--host', selected.hosts.join(',')] : []),
      ...(selected.skillId ? ['--skill', selected.skillId] : []),
      ...(settings.check ? ['--check'] : []),
      ...(settings.fingerprint && target.machine ? ['--approve-plan', settings.fingerprint] : []),
      ...(options.json ? ['--json'] : [])
    ];
    let continuation: StructuredContinuationV1;
    try {
      continuation = createStructuredContinuation({
        executable: 'liftoff', args, cwd: target.cwd,
        scope: target.scope, targetScope: target.scope,
        ...(target.scope === 'user' ? { userInstallTarget: target.targetRoot } : { project: target.targetRoot }),
        requiredAuthority: settings.requiredAuthority ?? [],
        compatibilityIdentity: settings.compatibilityIdentity ?? compatibility(command)
      });
      const admitted = validateSkillsCommandRequest(parseCommandTokens([...continuation.args]).parsed);
      if (continuation.cwd !== target.cwd || continuation.scope !== target.scope || admitted.scope !== target.scope ||
          target.scope === 'project' && (continuation.project !== target.targetRoot || admitted.project !== target.targetRoot) ||
          target.scope === 'user' && (continuation.project !== undefined || continuation.userInstallTarget !== target.targetRoot)) {
        throw new ProtocolValidationError('The continuation cannot retain the exact observed skills context.');
      }
    } catch (error) {
      if (!(error instanceof ProtocolValidationError || error instanceof SkillsRequestError ||
          error instanceof UsageError || error instanceof ContinuationError)) throw error;
      nextActionGuidance.push({
        executable: null, reasonCode: 'context-not-admitted',
        message: 'No executable follow-up was emitted because the shared protocol and skills admission could not retain its exact context. The recorded operation outcome is unchanged.'
      });
      return;
    }
    if (settings.guidance || target.scope === 'user') {
      const { schemaVersion: _schema, executable: _executable, displayCommand: _display, ...context } = continuation;
      nextActionGuidance.push({
        executable: null, context,
        ...(settings.guidance ?? {
          reasonCode: 'user-target-not-addressable' as const,
          message: 'The CLI resolves personal delivery from the executing user home and has no registered physical-home selector. This observed user target and request are guidance only; do not replay them as an executable continuation in a different user context.'
        })
      });
      return;
    }
    nextActions.push(continuation);
  };
  const inspect = (guidance?: Pick<SkillsContinuationGuidance, 'reasonCode' | 'message'>) =>
    emit('inspect', selection, { guidance });
  const blocked = (message: string) => inspect({ reasonCode: 'operation-blocked', message });
  const recover = (pending: ReviewedUpdateTransactionInspection) => {
    const identity = pending.skillsIdentity;
    if (pending.status === 'blocked' || pending.destinations.some((entry) => entry.disposition === 'changed') ||
        !identity || !pending.planFingerprint ||
        identity.scope !== target.scope) {
      inspect({
        reasonCode: 'recovery-not-addressable',
        message: 'The original transaction is not safely addressable by this CLI request. Preserve its journal and resolve the recorded blocker; no recovery command is authorized by this guidance.'
      });
      return;
    }
    const allSkills = identity.skillIds.length === CANONICAL_SKILL_IDS.length &&
      CANONICAL_SKILL_IDS.every((id) => identity.skillIds.includes(id));
    if (identity.skillIds.length !== 1 && !allSkills) {
      inspect({
        reasonCode: 'recovery-not-addressable',
        message: 'The sealed skill subset cannot be expressed by the registered CLI skill selector. Preserve the original request and journal; no broader recovery selection was invented.'
      });
      return;
    }
    emit(identity.intent, {
      hosts: identity.hosts, ...(allSkills ? {} : { skillId: identity.skillIds[0] })
    }, {
      fingerprint: pending.planFingerprint,
      requiredAuthority: ['original-recorded-effect-recovery'],
      compatibilityIdentity: canonicalSha256(identity)
    });
  };
  switch (result.outcome) {
    case 'planned':
      if (result.result.summary.ownership === 0) inspect();
      else emit(result.result.intent, selection, {
        fingerprint: result.result.fingerprint,
        requiredAuthority: ['exact-skills-plan-approval']
      });
      break;
    case 'migration-planned':
      emit('migrate', selection, {
        fingerprint: result.result.fingerprint,
        requiredAuthority: ['exact-skills-plan-approval'],
        compatibilityIdentity: canonicalSha256(result.result.identity)
      });
      break;
    case 'executed':
    case 'migration-executed':
      if (result.result.ok) inspect();
      else if (result.result.outcome !== 'declined') blocked(
        'Resolve the recorded execution/recovery blocker before another operation. Existing effects and recovery material remain authoritative; no retry or cleanup permission is inferred.'
      );
      break;
    case 'blocked-plan':
    case 'migration-blocked':
      blocked('The selected operation is blocked. Preserve unowned or modified files and resolve the reported observation; no mutating follow-up is offered.');
      break;
    case 'recovery-required':
      recover(result.result);
      break;
    case 'inspected':
      if (result.result.transaction.status !== 'absent') recover(result.result.transaction);
      break;
    case 'recovered':
      if (result.result.uncertain || result.result.cleanupFailures.length > 0) blocked(
        'Recovery remains incomplete or uncertain. Preserve the original material and resolve its reported blocker rather than retrying unchanged work.'
      );
      else if (result.result.status === 'rolled-back') {
        const command = options.subcommand === 'plan' ? 'install' : options.subcommand;
        if (command === 'install' || command === 'update' || command === 'remove' || command === 'migrate') {
          emit(command, selection, { check: true });
        }
      } else inspect();
      break;
    case 'listed':
    case 'migration-not-required':
    case 'migration-update-required':
      break;
  }
  return { nextActions, nextActionGuidance };
}
