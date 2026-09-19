import path from 'node:path';
import type {
  CanonicalSkillDefinition, CanonicalSkillId, ContextPreservingContinuation, SkillCapabilityCheck, SkillHostId
} from '../../domain/skills/contracts.js';
import {
  isCanonicalSkillHost, strictSkillObject, validateCanonicalSkillDefinition
} from '../../domain/skills/catalog.js';
import { getCanonicalSkill } from '../../adapters/packaged-assets/skill-assets.js';
import { validatePublicCapabilitiesEnvelope, type PublicCapabilitiesEnvelopeV1 } from '../../protocol/capabilities.js';
import { assertNoSecretValues, resolveGovernanceScope } from '../../domain/execution/continuation.js';
import type { ParsedArgs } from '../../domain/project/contracts.js';
import { validateArtifactPathParts } from '../../domain/project/paths.js';
import { validateSkillsCommandRequest } from './request.js';

export type CliCapabilityContract = PublicCapabilitiesEnvelopeV1;

export function negotiateSkillCapability(
  skillOrId: CanonicalSkillDefinition | CanonicalSkillId, value: unknown, host?: SkillHostId
): SkillCapabilityCheck {
  const skill = typeof skillOrId === 'string' ? getCanonicalSkill(skillOrId) : validateCanonicalSkillDefinition(skillOrId);
  const result = (status: SkillCapabilityCheck['status'], details: string): SkillCapabilityCheck => ({
    skillId: skill.id, requiredCapability: skill.requiredCapability, owningEngine: skill.owningEngine,
    commandOutput: skill.commandOutput, commandResultSchema: skill.commandResultSchema,
    ...(skill.contractVersion === undefined ? {} : { contractVersion: skill.contractVersion }),
    status, details, authority: 'none', hostQualification: host === undefined ? 'not-evaluated' : 'unqualified'
  });
  let contract: PublicCapabilitiesEnvelopeV1;
  try { contract = validatePublicCapabilitiesEnvelope(value); }
  catch (error) {
    return result('unsupported', `Invalid installed capability envelope: ${error instanceof Error ? error.message : String(error)}`);
  }
  const matches = contract.capabilities.filter((entry) => entry.id === skill.requiredCapability);
  if (matches.length !== 1) return result('unsupported', `Expected exactly one installed capability ${skill.requiredCapability}.`);
  const installed = matches[0];
  if (installed.owner !== skill.owningEngine) return result('unsupported', 'Installed capability ownership differs from the registered canonical workflow.');
  for (const values of [installed.supportedProfiles, installed.requiredInputs, installed.compatibilityIdentities,
    installed.supportedPlatforms, installed.effectClasses]) {
    if (!Array.isArray(values) || Array.from(values).some((entry) =>
      typeof entry !== 'string' || !entry.trim() || /[\u0000-\u001f\u007f]/u.test(entry)) ||
      new Set(values).size !== values.length) return result('unsupported', 'Installed capability contains malformed or duplicate identity/input metadata.');
  }
  if (installed.readOnly !== (skill.authorizationMechanism === 'read-only')) {
    return result('unsupported', 'Installed capability effects contradict the canonical read-only boundary.');
  }
  let schema: Record<string, unknown>;
  try {
    schema = strictSkillObject(installed.commandSchema, ['resultSchemaVersion'], 'Capability command output',
      ['contractVersion', 'reportContract', 'outputFormat']);
  } catch (error) {
    return result('unsupported', error instanceof Error ? error.message : String(error));
  }
  // The original schema-1 descriptor represented JSON only; human output must be explicit.
  const format = schema.outputFormat ?? 'json';
  if (format !== skill.commandOutput || schema.resultSchemaVersion !== skill.commandResultSchema ||
      schema.contractVersion !== skill.contractVersion ||
      Object.hasOwn(schema, 'contractVersion') !== Object.hasOwn(skill, 'contractVersion')) {
    return result('unsupported', `Command contract mismatch for ${skill.requiredCapability}: expected ${skill.commandOutput} output` +
      (skill.commandResultSchema === null ? ' without a JSON result schema.' : ` schema ${skill.commandResultSchema}.`));
  }
  if (installed.authorization.mechanism !== skill.authorizationMechanism) {
    return result('unsupported', 'Command-specific authorization differs from the canonical workflow; another command’s flags are not substitutes.');
  }
  try {
    const authorization = strictSkillObject(installed.authorization, ['mechanism'], 'Capability authorization',
      ['defaultDecision', 'automationFlags', 'consentRequirements']);
    const expectedDefault = skill.authorizationMechanism === 'read-only' ? 'n/a'
      : skill.authorizationMechanism === 'command-invocation' ? undefined : 'no';
    if (authorization.defaultDecision !== expectedDefault ||
        authorization.automationFlags !== undefined && (!Array.isArray(authorization.automationFlags) ||
          authorization.automationFlags.some((flag) => typeof flag !== 'string' || !/^--[a-z][a-z-]*$/u.test(flag)) ||
          new Set(authorization.automationFlags).size !== authorization.automationFlags.length) ||
        authorization.consentRequirements !== undefined && (!Array.isArray(authorization.consentRequirements) ||
          authorization.consentRequirements.some((entry) => typeof entry !== 'string' || !entry.trim())) ||
        skill.authorizationMechanism === 'reviewed-plan' && Array.isArray(authorization.automationFlags) &&
          authorization.automationFlags.includes('--yes')) {
      return result('unsupported', 'Capability authorization is missing its registered default-No/read-only/invocation boundary.');
    }
  } catch (error) {
    return result('unsupported', error instanceof Error ? error.message : String(error));
  }
  if (host !== undefined && !isCanonicalSkillHost(host)) return result('unsupported', `Unregistered host identity: ${String(host)}`);
  if (!installed.supportedPlatforms.includes(process.platform as (typeof installed.supportedPlatforms)[number])) {
    return result('unsupported', `The installed capability does not advertise this platform: ${process.platform}.`);
  }
  if (installed.qualificationState === 'unqualified') return result('unqualified', 'The installed CLI reports this capability as unqualified.');
  if (installed.qualificationState === 'prerequisite-blocked') return result('prerequisite-blocked', 'The installed CLI reports missing prerequisites.');
  if (installed.qualificationState === 'implementation-missing' || installed.qualificationState === 'planner-only' ||
      installed.executor !== 'built-in' || installed.planner !== 'built-in') {
    return result('plan-only', `Execution is unavailable (${installed.qualificationState}, executor ${installed.executor}); do not fall back to direct edits or another mutator.`);
  }
  if (installed.qualificationState !== 'qualified') return result('unsupported', 'The installed qualification state is not registered.');
  if (host !== undefined) {
    return result('unqualified', `CLI implementation is advertised, but ${host} assistance has no independent native-host qualification evidence here.`);
  }
  return result('executable', 'The CLI advertises this implementation; actual target/input admission and action-specific approval are still required. No authority or executable continuation was inferred.');
}

export interface SkillContinuationAdmission {
  parseCommand(argv: string[]): ParsedArgs;
  executable?: string;
  userTarget?: string;
}

function safeText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw new Error(`${label} must be nonempty literal text without control characters.`);
  }
  return value;
}

function nativePath(value: unknown, label: string): string {
  const text = safeText(value, label);
  const paths = /^[a-z]:[\\/]/iu.test(text) || text.startsWith('\\\\') ? path.win32 : path.posix;
  if (!paths.isAbsolute(text) || paths.normalize(text) !== text || text.normalize('NFC') !== text ||
      text.startsWith('\\\\?\\') || text.startsWith('\\\\.\\') ||
      paths === path.win32 && !/^[a-z]:\\$/iu.test(paths.parse(text).root) && !/^\\\\[^\\]+\\[^\\]+\\$/u.test(paths.parse(text).root)) {
    throw new Error(`${label} must retain an absolute canonical native path, not a relative or device alias.`);
  }
  if (paths === path.win32) {
    const root = paths.parse(text).root;
    const parts = [
      ...(text.startsWith('\\\\') ? root.slice(2, -1).split('\\') : []),
      ...text.slice(root.length).split('\\').filter(Boolean)
    ];
    if (parts.length > 0) validateArtifactPathParts(parts, label);
    if (parts.some((part) => /[<>:"|?*]/u.test(part))) {
      throw new Error(`${label} contains a Windows device, stream, or path alias.`);
    }
  }
  return text;
}

function resolveFrom(cwd: string, target: string): string {
  const paths = /^[a-z]:\\/iu.test(cwd) || cwd.startsWith('\\\\') ? path.win32 : path.posix;
  return paths.resolve(cwd, target);
}

function assertContinuationScope(parsed: ParsedArgs, scope: string): void {
  let expected: string;
  if (parsed.flags.help === true ||
      ['help', 'version', 'capabilities', 'patterns', 'providers', 'regions'].includes(parsed.command ?? '') ||
      parsed.command === 'repair' && parsed.flags.capabilities === true) {
    expected = 'global';
  } else if (parsed.command === 'skills') {
    const request = validateSkillsCommandRequest(parsed);
    expected = request.subcommand === 'list' ? 'global' : request.scope ?? 'user';
  } else if (parsed.command === 'governance') {
    const governanceScope = resolveGovernanceScope('governance',
      typeof parsed.flags.scope === 'string' ? parsed.flags.scope : undefined);
    if (governanceScope === undefined) throw new Error('Governance continuation has no resolved scope.');
    expected = parsed.subcommand === 'assess' ? 'project'
      : governanceScope;
  } else if (parsed.command === 'installation' || parsed.command === 'upgrade') {
    expected = 'installation';
  } else if (parsed.command === 'doctor' && (scope === 'user' || scope === 'project')) {
    expected = scope;
  } else if (['init', 'plan', 'migrate', 'assess', 'adopt', 'update', 'repair', 'validate'].includes(parsed.command ?? '')) {
    expected = 'project';
  } else {
    throw new Error('Continuation command has no registered canonical scope binding.');
  }
  if (scope !== expected) throw new Error(`Continuation changed the parsed command scope; expected ${expected}.`);
}

export function buildContextPreservingContinuation(
  value: unknown, admission: SkillContinuationAdmission
): ContextPreservingContinuation {
  const input = strictSkillObject(value, ['executable', 'args', 'cwd', 'scope', 'requiredAuthority', 'compatibilityIdentity'],
    'Skill continuation', ['project', 'userTarget', 'source', 'target', 'configRef']);
  if (!admission || typeof admission.parseCommand !== 'function') throw new Error('Continuation requires the production CLI parser; no inferred command fallback is available.');
  const executable = safeText(input.executable, 'Continuation executable');
  if (executable !== (admission.executable ?? 'liftoff')) {
    throw new Error('Continuation substituted the independently bound Liftoff executable.');
  }
  if (executable !== 'liftoff') nativePath(executable, 'Continuation executable');
  if (!Array.isArray(input.args) || input.args.length === 0 || input.args.length > 128) throw new Error('Continuation requires bounded literal arguments.');
  const args = Array.from(input.args, (arg) => safeText(arg, 'Continuation argument'));
  assertNoSecretValues([executable, ...args]);
  const parsed = admission.parseCommand(args);
  const cwd = nativePath(input.cwd, 'Continuation cwd');
  const scope = safeText(input.scope, 'Continuation scope');
  if (!['project', 'user', 'installation', 'local', 'repository', 'activation', 'lifecycle', 'global'].includes(scope)) {
    throw new Error('Continuation scope is not registered.');
  }
  assertContinuationScope(parsed, scope);
  const project = input.project === undefined ? undefined : nativePath(input.project, 'Continuation project');
  const userTarget = input.userTarget === undefined ? undefined : nativePath(input.userTarget, 'Continuation user/installation target');
  const source = input.source === undefined ? undefined : nativePath(input.source, 'Continuation source');
  const target = input.target === undefined ? undefined : nativePath(input.target, 'Continuation target');
  if ((scope === 'user' || scope === 'installation') && (project !== undefined || !userTarget) ||
      !['user', 'installation', 'global'].includes(scope) && !project ||
      !['user', 'installation'].includes(scope) && userTarget !== undefined ||
      scope === 'global' && project !== undefined) {
    throw new Error('Continuation must bind its real project or user/installation target without inventing another scope.');
  }
  if ((scope === 'user' || scope === 'installation') && userTarget !== admission.userTarget) {
    throw new Error('Continuation user/installation target differs from its independently observed binding.');
  }
  const generation = parsed.flags.help !== true && ['init', 'plan', 'migrate'].includes(parsed.command ?? '');
  if (project && !generation) {
    const target = typeof parsed.flags.project === 'string' ? parsed.flags.project : parsed.positional[0];
    if (resolveFrom(cwd, target ?? '.') !== project) throw new Error('Continuation command does not retain its explicit project/cwd binding.');
  }
  if (generation) {
    const name = typeof parsed.flags.project === 'string' ? parsed.flags.project
      : parsed.command === 'init' ? parsed.positional[0] : undefined;
    if (scope !== 'project' || !target || project !== target || typeof name !== 'string' ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) || resolveFrom(cwd, name) !== target) {
      throw new Error('Human generation continuation needs the actual canonical target name/path and its original cwd, not a fabricated JSON result.');
    }
    if (parsed.command === 'migrate') {
      if (!source || !parsed.positional[0] || resolveFrom(cwd, parsed.positional[0]) !== source) {
        throw new Error('Fresh-target continuation lost its exact source binding.');
      }
      const paths = /^[a-z]:\\/iu.test(cwd) || cwd.startsWith('\\\\') ? path.win32 : path.posix;
      for (const [left, right] of [[source, target], [target, source]]) {
        const relative = paths.relative(left, right);
        if (relative === '' || relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative)) {
          throw new Error('Fresh-target source and destination must remain disjoint.');
        }
      }
    } else if (source !== undefined) throw new Error('Initialization cannot acquire a migration source.');
  } else if (source !== undefined || target !== undefined) {
    throw new Error('Source/target generation bindings cannot be attached to an unrelated command.');
  }
  if (scope === 'user' && parsed.command === 'skills' &&
      (parsed.flags.project !== undefined || parsed.flags.scope !== undefined && parsed.flags.scope !== 'user')) {
    throw new Error('Personal skills continuation cannot redirect to a project.');
  }
  if (!Array.isArray(input.requiredAuthority) || input.requiredAuthority.some((entry) => typeof entry !== 'string') ||
      new Set(input.requiredAuthority).size !== input.requiredAuthority.length) throw new Error('Continuation requires explicit duplicate-free authority declarations.');
  const requiredAuthority = input.requiredAuthority.map((entry) => safeText(entry, 'Continuation authority'));
  const compatibilityIdentity = safeText(input.compatibilityIdentity, 'Continuation compatibility identity');
  assertNoSecretValues([...requiredAuthority, compatibilityIdentity]);
  let configRef: ContextPreservingContinuation['configRef'];
  const configured = typeof parsed.flags.inputs === 'string' ? parsed.flags.inputs
    : typeof parsed.flags.config === 'string' ? parsed.flags.config : undefined;
  if (input.configRef !== undefined) {
    const config = strictSkillObject(input.configRef, ['path', 'digest'], 'Continuation configuration');
    const configPath = nativePath(config.path, 'Continuation configuration path');
    if (typeof config.digest !== 'string' || !/^(?:sha256:)?[a-f0-9]{64}$/u.test(config.digest)) {
      throw new Error('Continuation configuration requires its exact SHA-256 binding.');
    }
    const implicitUpdate = parsed.command === 'update' && project ? resolveFrom(project, 'liftoff.config.json') : undefined;
    if ((configured === undefined ? implicitUpdate : resolveFrom(cwd, configured)) !== configPath) {
      throw new Error('Continuation lost or substituted its original configuration reference.');
    }
    configRef = { path: configPath, digest: config.digest };
  } else if (configured !== undefined) throw new Error('Continuation configuration arguments require their bound path and digest.');
  return {
    executable, args, cwd, scope, requiredAuthority, compatibilityIdentity,
    ...(project === undefined ? {} : { project }), ...(userTarget === undefined ? {} : { userTarget }),
    ...(source === undefined ? {} : { source }), ...(target === undefined ? {} : { target }),
    ...(configRef === undefined ? {} : { configRef })
  };
}
