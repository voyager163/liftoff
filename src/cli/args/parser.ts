import type { ParsedArgs } from '../../domain/project/contracts.js';
import { isUpdatePlanFingerprint } from '../../application/update/approval.js';
import { parseCommandTokens, UsageError, validateCommandPositionals } from '../../domain/execution/command-line.js';
import { phaseIds } from '../../domain/governance/activation/types.js';
import { repairRequestIssue } from '../../application/repair/request.js';
import { SkillsRequestError, validateSkillsCommandRequest } from '../../application/skills/request.js';
import { adoptionRequestIssue } from '../../application/project-evolution/adoption/request.js';
import { readStringFlag } from './readers.js';

export { UsageError } from '../../domain/execution/command-line.js';

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed = parseCommandTokens(argv).parsed;
  const { command, subcommand, positional, flags } = parsed;
  if (!command || argv[0] === '--help' || argv[0] === '--version') return parsed;

  if ((command === 'update' || command === 'validate') && positional.length > 0 && Object.hasOwn(flags, 'project')) {
    throw new UsageError('Provide a project path either positionally or with --project, not both.');
  }

  if (command === 'update') {
    if (Object.hasOwn(flags, 'approve-plan')) {
      if (!isUpdatePlanFingerprint(flags['approve-plan'])) {
        throw new UsageError(
          'Flag --approve-plan expects the complete fingerprint from `liftoff update --check`: ' +
            'exactly 64 lowercase hexadecimal characters.'
        );
      }
      if (flags.check === true) {
        throw new UsageError(
          'Flags --check and --approve-plan cannot be combined. Run `liftoff update --check` first, ' +
            'then approve its exact effective plan with `liftoff update --approve-plan <fingerprint>`.'
        );
      }
    }
    if (flags.check === true && flags.force === true) {
      throw new UsageError(
        'Flags --check and --force cannot be combined. Run `liftoff update --check` ' +
          'to review the normal and eligible forced plans, then explicitly approve the matching ' +
          'forced plan with `liftoff update --force`.'
      );
    }
  }

  if (command === 'repair') {
    if (positional.length && Object.hasOwn(flags, 'project')) {
      throw new UsageError('Provide a project path either positionally or with --project, not both.');
    }
    if ((flags['approve-plan'] !== undefined || flags['verify-plan'] !== undefined || flags.recover === true) &&
        (Object.hasOwn(flags, 'live') || Object.hasOwn(flags, 'subscription'))) {
      throw new UsageError('Apply or recover only the saved repair scope; live/subscription options belong on the check.');
    }
    if (Object.hasOwn(flags, 'allow-dependency-preparation') && !Object.hasOwn(flags, 'verify-plan')) {
      throw new UsageError('Flag --allow-dependency-preparation is permitted only alongside an exact --verify-plan request.');
    }
    const issue = repairRequestIssue({
      project: readStringFlag(flags, 'project') ?? positional[0],
      check: flags.check === true, live: flags.live === true, recover: flags.recover === true, json: flags.json === true,
      subscription: readStringFlag(flags, 'subscription'), approvePlan: readStringFlag(flags, 'approve-plan'),
      capabilities: flags.capabilities === true, inspectLayout: flags['inspect-layout'] === true,
      applicationPatch: readStringFlag(flags, 'application-patch'), verifyPlan: readStringFlag(flags, 'verify-plan'),
      allowNetwork: flags['allow-network'] === true,
      allowDependencyPreparation: flags['allow-dependency-preparation'] === true,
      recipe: readStringFlag(flags, 'recipe')
    }, flags.help === true);
    if (issue) throw new UsageError(issue);
  }

  if (command === 'assess' && positional.length > 0 && Object.hasOwn(flags, 'project')) {
    throw new UsageError('Provide an assessment project either positionally or with --project, not both.');
  }

  if (command === 'adopt') {
    if (positional.length > 0 && Object.hasOwn(flags, 'project')) {
      throw new UsageError('Provide an adoption project either positionally or with --project, not both.');
    }
    const issue = adoptionRequestIssue({
      project: readStringFlag(flags, 'project') ?? positional[0],
      profile: readStringFlag(flags, 'profile'),
      component: readStringFlag(flags, 'component'),
      proposal: readStringFlag(flags, 'proposal'),
      check: flags.check === true,
      approvePlan: readStringFlag(flags, 'approve-plan'),
      verifyPlan: readStringFlag(flags, 'verify-plan'),
      allowDependencyPreparation: flags['allow-dependency-preparation'] === true,
      allowNetwork: flags['allow-network'] === true,
      recover: flags.recover === true,
      json: flags.json === true
    }, flags.help === true);
    if (issue) throw new UsageError(issue);
  }

  if (command === 'skills') {
    try {
      validateSkillsCommandRequest({ command, subcommand, positional, flags });
    } catch (error) {
      if (error instanceof SkillsRequestError) throw new UsageError(error.message);
      throw error;
    }
  }

  if (command === 'installation') {
    if (!subcommand && flags.help !== true) {
      throw new UsageError('Choose installation inspect or installation migrate; installation changes never initialize a project.');
    }
    if (subcommand === 'inspect' && ['to', 'destination', 'launcher', 'check', 'approve-plan', 'recover']
      .some((flag) => Object.hasOwn(flags, flag))) {
      throw new UsageError('Installation inspect accepts only --candidate, --json, and --help; migration authority is separate.');
    }
    if (subcommand === 'migrate') {
      if (flags.recover === true) {
        if (['to', 'candidate', 'destination', 'launcher', 'check', 'approve-plan']
          .some((flag) => Object.hasOwn(flags, flag))) {
          throw new UsageError('Installation recovery inspection uses only its recorded scope; do not combine it with a new migration plan or approval.');
        }
      } else if (flags.help !== true &&
        !['homebrew-cask', 'winget', 'direct'].includes(String(flags.to))) {
        throw new UsageError('Installation migrate requires --to homebrew-cask, winget, or direct.');
      }
      if (Object.hasOwn(flags, 'approve-plan')) {
        if (!isUpdatePlanFingerprint(flags['approve-plan'])) {
          throw new UsageError('Flag --approve-plan expects the complete current migration fingerprint: exactly 64 lowercase hexadecimal characters.');
        }
        if (flags.check === true) {
          throw new UsageError('Installation --check and --approve-plan cannot be combined; review first, then separately approve the exact plan.');
        }
      }
    }
  }

  if (command === 'governance') {
    if (Object.hasOwn(flags, 'scope') && !['local', 'repository', 'activation', 'lifecycle'].includes(String(flags.scope))) {
      throw new UsageError('Flag --scope expects local, repository, activation, or lifecycle.');
    }
    if (Object.hasOwn(flags, 'plan') && !isUpdatePlanFingerprint(flags.plan)) {
      throw new UsageError('Flag --plan expects the complete 64-character lowercase SHA-256 fingerprint from governance plan.');
    }
    if (Object.hasOwn(flags, 'execute') && !['apply-next', 'recover'].includes(subcommand ?? '')) {
      throw new UsageError('Flag --execute is not allowed; it is allowed only for governance apply-next or recover.');
    }
    if (Object.hasOwn(flags, 'plan') && !['approve', 'apply-next', 'credential-enroll', 'recover'].includes(subcommand ?? '')) {
      throw new UsageError('Flag --plan is allowed only for governance approve, apply-next, credential-enroll, or recover.');
    }
    if (Object.hasOwn(flags, 'protected-stdin') && subcommand !== 'credential-enroll') {
      throw new UsageError('Flag --protected-stdin is allowed only for governance credential-enroll.');
    }
    if (Object.hasOwn(flags, 'recover-phase') &&
      (subcommand !== 'plan' || !(phaseIds as readonly string[]).includes(String(flags['recover-phase'])))) {
      throw new UsageError('Flag --recover-phase requires governance plan and one canonical phase ID.');
    }
    if (flags.help !== true && ['approve', 'credential-enroll', 'recover'].includes(subcommand ?? '') && !flags.plan) {
      throw new UsageError(`Governance ${subcommand} requires --plan with the exact reviewed preview fingerprint.`);
    }
    if (Object.hasOwn(flags, 'live') && subcommand !== 'assess') {
      throw new UsageError('Flag --live is allowed only for `liftoff governance assess`.');
    }
    if (positional.length > 0 && Object.hasOwn(flags, 'project')) {
      throw new UsageError('Provide a project path either positionally or with --project, not both.');
    }
    if (subcommand === 'assess') {
      if (['scope', 'inputs', 'plan', 'protected-stdin', 'recover-phase'].some((flag) => Object.hasOwn(flags, flag))) {
        throw new UsageError('Governance assess does not accept execution, configuration, or approval flags.');
      }
      if (Object.hasOwn(flags, 'execute')) {
        throw new UsageError('Flag --execute is not allowed for read-only `liftoff governance assess`.');
      }
    }
  }

  validateCommandPositionals(parsed);
  return parsed;
}
