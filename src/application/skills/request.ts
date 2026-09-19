import type { ParsedArgs } from '../../domain/project/contracts.js';
import {
  CANONICAL_SKILL_IDS,
  SUPPORTED_SKILL_HOSTS,
  skillsSubcommands,
  type CanonicalSkillId,
  type SkillHostId,
  type SkillScope,
  type SkillsSubcommand
} from '../../domain/skills/contracts.js';
import { isRecord } from '../../domain/governance/activation/canonical-json.js';
import { isUpdatePlanFingerprint } from '../update/approval.js';

export { skillsSubcommands, type SkillsSubcommand } from '../../domain/skills/contracts.js';

export interface SkillsCommandOptions {
  subcommand?: SkillsSubcommand;
  hosts?: readonly SkillHostId[];
  scope?: SkillScope;
  project?: string;
  skillId?: CanonicalSkillId;
  check?: boolean;
  approvePlan?: string;
  json?: boolean;
}

export class SkillsRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillsRequestError';
  }
}

function invalid(message: string): never {
  throw new SkillsRequestError(message);
}

export function parseRequestedHosts(rawHosts?: string): readonly SkillHostId[] | undefined {
  if (rawHosts === undefined) return undefined;
  if (typeof rawHosts !== 'string' || !rawHosts.trim()) {
    return invalid('Flag --host requires an explicit comma-separated selection: copilot, claude, codex.');
  }
  const hosts = rawHosts.split(',').map((entry) => {
    const host = entry.trim();
    if (host === 'copilot') return 'github-copilot';
    if (SUPPORTED_SKILL_HOSTS.includes(host as SkillHostId)) return host as SkillHostId;
    return invalid(`Unknown skill host '${host}'. Select copilot, claude, or codex explicitly.`);
  });
  if (new Set(hosts).size !== hosts.length) invalid('Flag --host contains a duplicate host.');
  return hosts;
}

export function validateSkillsOptions(value: unknown, help = false): SkillsCommandOptions {
  const fields = ['subcommand', 'hosts', 'scope', 'project', 'skillId', 'check', 'approvePlan', 'json'];
  if (!isRecord(value) || Object.keys(value).some((key) => !fields.includes(key))) {
    return invalid('Skills accepts only subcommand, hosts, scope, project, skillId, check, approvePlan, and json.');
  }
  const subcommand = value.subcommand ?? 'list';
  if (typeof subcommand !== 'string' || !skillsSubcommands.includes(subcommand as SkillsSubcommand)) {
    invalid(`Unknown skills subcommand: ${String(subcommand)}. Use ${skillsSubcommands.join(', ')}.`);
  }
  const scope = value.scope ?? (value.project === undefined ? 'user' : 'project');
  if (scope !== 'user' && scope !== 'project') invalid('Flag --scope expects user or project.');
  if (value.project !== undefined &&
      (typeof value.project !== 'string' || !value.project.trim() || /[\u0000-\u001f\u007f]/u.test(value.project))) {
    invalid('Flag --project requires a nonempty native directory path.');
  }
  if (scope === 'user' && value.project !== undefined) {
    invalid('Flag --project cannot be combined with --scope user.');
  }
  if (value.hosts !== undefined && (!Array.isArray(value.hosts) || value.hosts.length === 0 ||
      value.hosts.some((host) => !SUPPORTED_SKILL_HOSTS.includes(host as SkillHostId)) ||
      new Set(value.hosts).size !== value.hosts.length)) {
    invalid('Skills requires a nonempty, duplicate-free selection of supported hosts.');
  }
  if (!help && !['list', 'inspect'].includes(subcommand as string) && value.hosts === undefined) {
    invalid('Select delivery hosts explicitly with --host <copilot,claude,codex>; no hosts are selected implicitly.');
  }
  if (value.skillId !== undefined && !CANONICAL_SKILL_IDS.includes(value.skillId as CanonicalSkillId)) {
    invalid(`Flag --skill expects a canonical skill identity: ${CANONICAL_SKILL_IDS.join(', ')}.`);
  }
  for (const field of ['check', 'json']) {
    if (value[field] !== undefined && typeof value[field] !== 'boolean') invalid(`Flag --${field} expects a boolean.`);
  }
  if (value.approvePlan !== undefined && !isUpdatePlanFingerprint(value.approvePlan)) {
    invalid('Flag --approve-plan expects exactly 64 lowercase hexadecimal characters from the selected operation preview.');
  }
  if (value.approvePlan !== undefined && (value.check === true || ['list', 'plan', 'inspect'].includes(subcommand as string))) {
    invalid('Exact plan approval cannot be combined with a read-only skills operation or --check.');
  }
  if (value.check === true && ['list', 'inspect'].includes(subcommand as string)) {
    invalid('Flag --check previews install, update, remove, or migrate without changing the selected operation.');
  }
  if (subcommand === 'list' && (value.scope !== undefined || value.project !== undefined)) {
    invalid('Skills list describes the packaged catalog and does not accept a target scope or project.');
  }
  if (!help && subcommand === 'migrate' && scope !== 'project') {
    invalid('Skills migrate requires explicit --scope project or --project; it never selects a project from user scope.');
  }
  return {
    subcommand: subcommand as SkillsSubcommand,
    ...(value.hosts === undefined ? {} : { hosts: [...value.hosts as SkillHostId[]] }),
    ...(subcommand === 'list' ? {} : { scope }),
    ...(value.project === undefined ? {} : { project: value.project as string }),
    ...(value.skillId === undefined ? {} : { skillId: value.skillId as CanonicalSkillId }),
    check: value.check === true,
    json: value.json === true,
    ...(value.approvePlan === undefined ? {} : { approvePlan: value.approvePlan as string })
  };
}

export function validateSkillsCommandRequest(parsed: ParsedArgs): SkillsCommandOptions {
  if (parsed.command !== 'skills' || !Array.isArray(parsed.positional) || parsed.positional.length !== 0 ||
      !isRecord(parsed.flags)) {
    return invalid('Skills expects a registered subcommand and flags, with no positional target arguments.');
  }
  const allowed = ['host', 'scope', 'project', 'skill', 'check', 'approve-plan', 'json', 'help'];
  for (const [flag, value] of Object.entries(parsed.flags)) {
    if (!allowed.includes(flag)) invalid(`Unknown flag for skills: --${flag}.`);
    if (['check', 'json', 'help'].includes(flag) ? typeof value !== 'boolean' : typeof value !== 'string' || !value) {
      invalid(`Invalid value for skills --${flag}.`);
    }
  }
  const flags = parsed.flags;
  return validateSkillsOptions({
    subcommand: parsed.subcommand,
    hosts: parseRequestedHosts(flags.host as string | undefined),
    scope: flags.scope,
    project: flags.project,
    skillId: flags.skill,
    check: flags.check,
    approvePlan: flags['approve-plan'],
    json: flags.json
  }, flags.help === true);
}
