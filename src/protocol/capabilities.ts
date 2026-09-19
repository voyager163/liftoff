import {
  canonicalEngines,
  engineIds,
  engineOwners,
  isEngineId,
  isEngineOwner,
  type EngineDescriptor,
  type EngineId,
  type EngineOwner
} from '../domain/execution/engines.js';
import {
  assertSchemaVersion,
  assertStrictKeys,
  assertStrictObject,
  ProtocolValidationError,
  publicProtocolSchemaVersion,
  protocolArray,
  protocolChoice,
  protocolReleaseVersion,
  protocolSchemaNumber,
  protocolString,
  protocolStringArray
} from './schema.js';

export const supportedPlatformList = ['darwin', 'win32', 'linux'] as const;
export type SupportedPlatform = (typeof supportedPlatformList)[number];

export const qualificationStates = [
  'qualified',
  'unqualified',
  'prerequisite-blocked',
  'implementation-missing',
  'planner-only'
] as const;
export type QualificationState = (typeof qualificationStates)[number];

export const authorizationMechanisms = [
  'command-invocation',
  'reviewed-plan',
  'flag-consent',
  'read-only'
] as const;
export type AuthorizationMechanism = (typeof authorizationMechanisms)[number];

export const effectClasses = [
  'filesystem-read',
  'filesystem-write',
  'process-execution',
  'network-read',
  'network-write',
  'cloud-state',
  'repository-controls'
] as const;
export type EffectClass = (typeof effectClasses)[number];

export const plannerAvailability = ['built-in', 'unavailable'] as const;
export type PlannerAvailability = (typeof plannerAvailability)[number];

export const executorAvailability = ['built-in', 'injected-only', 'unavailable'] as const;
export type ExecutorAvailability = (typeof executorAvailability)[number];

export const verifierAvailability = ['built-in', 'external', 'unavailable', 'n/a'] as const;
export type VerifierAvailability = (typeof verifierAvailability)[number];

export const recoveryBehaviors = [
  'attributable-journal',
  'workspace-seal',
  'revalidation',
  'none',
  'n/a'
] as const;
export type RecoveryBehavior = (typeof recoveryBehaviors)[number];

export type CommandSchemaDescriptor =
  | { outputFormat?: 'json'; resultSchemaVersion: number; contractVersion?: number; reportContract?: string }
  | { outputFormat: 'human'; resultSchemaVersion: null };

export interface CapabilityAuthorization {
  mechanism: AuthorizationMechanism;
  defaultDecision?: 'no' | 'yes' | 'n/a';
  automationFlags?: readonly string[];
  consentRequirements?: readonly string[];
}

export interface PublicCapabilityV1 {
  schemaVersion: 1;
  id: string;
  engine: EngineId;
  owner: EngineOwner;
  title: string;
  description: string;
  supportedProfiles: readonly string[];
  supportedPlatforms: readonly SupportedPlatform[];
  requiredInputs: readonly string[];
  commandSchema: CommandSchemaDescriptor;
  authorization: CapabilityAuthorization;
  planner: PlannerAvailability;
  executor: ExecutorAvailability;
  verifier: VerifierAvailability;
  recovery: RecoveryBehavior;
  effectClasses: readonly EffectClass[];
  compatibilityIdentities: readonly string[];
  qualificationState: QualificationState;
  readOnly: boolean;
}

export interface PublicCapabilitiesEnvelopeV1 {
  schemaVersion: 1;
  kind: 'liftoff-public-capabilities';
  cliVersion: string;
  capabilities: readonly PublicCapabilityV1[];
  engines: readonly EngineDescriptor[];
}

const capabilityAllowedKeys = [
  'schemaVersion',
  'id',
  'engine',
  'owner',
  'title',
  'description',
  'supportedProfiles',
  'supportedPlatforms',
  'requiredInputs',
  'commandSchema',
  'authorization',
  'planner',
  'executor',
  'verifier',
  'recovery',
  'effectClasses',
  'compatibilityIdentities',
  'qualificationState',
  'readOnly'
] as const;

export function validateCommandSchema(value: unknown): CommandSchemaDescriptor {
  const schema = assertStrictObject(value, 'PublicCapability.commandSchema');
  assertStrictKeys(schema, ['outputFormat', 'resultSchemaVersion', 'contractVersion', 'reportContract'], 'PublicCapability.commandSchema');
  if (schema.outputFormat === 'human') {
    if (schema.resultSchemaVersion !== null || Object.keys(schema).length !== 2) {
      throw new ProtocolValidationError('PublicCapability: human-only output has no JSON result/report schema.');
    }
    return { outputFormat: 'human', resultSchemaVersion: null };
  }
  if (schema.outputFormat !== undefined && schema.outputFormat !== 'json') {
    throw new ProtocolValidationError('PublicCapability.commandSchema has an unsupported output format.');
  }
  return {
    ...(schema.outputFormat === 'json' ? { outputFormat: 'json' as const } : {}),
    resultSchemaVersion: protocolSchemaNumber(schema.resultSchemaVersion, 'PublicCapability.commandSchema.resultSchemaVersion'),
    ...(schema.contractVersion !== undefined ? {
      contractVersion: protocolSchemaNumber(schema.contractVersion, 'PublicCapability.commandSchema.contractVersion')
    } : {}),
    ...(schema.reportContract !== undefined ? {
      reportContract: protocolString(schema.reportContract, 'PublicCapability.commandSchema.reportContract', 128)
    } : {})
  };
}

export function validateCapabilityAuthorization(value: unknown): CapabilityAuthorization {
  const authorization = assertStrictObject(value, 'PublicCapability.authorization');
  assertStrictKeys(authorization, ['mechanism', 'defaultDecision', 'automationFlags', 'consentRequirements'], 'PublicCapability.authorization');
  const mechanism = protocolChoice(authorization.mechanism, authorizationMechanisms, 'PublicCapability.authorization.mechanism');
  const defaultDecision = authorization.defaultDecision === undefined ? undefined :
    protocolChoice(authorization.defaultDecision, ['no', 'yes', 'n/a'] as const, 'PublicCapability.authorization.defaultDecision');
  if (mechanism === 'reviewed-plan' && defaultDecision !== 'no' ||
      mechanism === 'read-only' && defaultDecision !== undefined && defaultDecision !== 'n/a') {
    throw new ProtocolValidationError('PublicCapability.authorization does not preserve its command-specific decision boundary.');
  }
  const automationFlags = authorization.automationFlags === undefined ? undefined :
    protocolStringArray(authorization.automationFlags, 'PublicCapability.authorization.automationFlags', 64);
  if (automationFlags?.some((flag) => !/^--[a-z][a-z0-9-]*$/u.test(flag))) {
    throw new ProtocolValidationError('PublicCapability.authorization.automationFlags must contain exact flag names, not commands or values.');
  }
  return {
    mechanism, ...(defaultDecision !== undefined ? { defaultDecision } : {}),
    ...(automationFlags ? { automationFlags } : {}),
    ...(authorization.consentRequirements !== undefined ? {
      consentRequirements: protocolStringArray(authorization.consentRequirements, 'PublicCapability.authorization.consentRequirements', 64)
    } : {})
  };
}

export function validatePublicCapability(value: unknown): PublicCapabilityV1 {
  const record = assertStrictObject(value, 'PublicCapability');
  assertSchemaVersion(record, publicProtocolSchemaVersion, 'PublicCapability');
  assertStrictKeys(record, capabilityAllowedKeys, 'PublicCapability');

  const id = protocolString(record.id, 'PublicCapability.id', 128);
  if (!/^[a-z][a-z0-9-]*$/u.test(id)) {
    throw new ProtocolValidationError('PublicCapability.id must be a stable lowercase capability identifier.');
  }

  if (!isEngineId(record.engine)) {
    throw new ProtocolValidationError(
      `PublicCapability: unknown engine "${String(record.engine)}". Must be one of: ${engineIds.join(', ')}.`
    );
  }

  if (!isEngineOwner(record.owner)) {
    throw new ProtocolValidationError(
      `PublicCapability: unknown engine owner "${String(record.owner)}". Must be one of: ${engineOwners.join(', ')}.`
    );
  }

  const expectedOwner = canonicalEngines[record.engine].owner;
  if (record.owner !== expectedOwner) {
    throw new ProtocolValidationError(
      `PublicCapability: owner mismatch for engine "${record.engine}". Expected "${expectedOwner}", got "${record.owner}".`
    );
  }

  const title = protocolString(record.title, 'PublicCapability.title', 256);
  const description = protocolString(record.description, 'PublicCapability.description');
  const supportedProfiles = protocolStringArray(record.supportedProfiles, 'PublicCapability.supportedProfiles');
  const supportedPlatforms = protocolStringArray(record.supportedPlatforms, 'PublicCapability.supportedPlatforms', 3, true)
    .map((platform) => protocolChoice(platform, supportedPlatformList, 'PublicCapability.supportedPlatforms'));
  const requiredInputs = protocolStringArray(record.requiredInputs, 'PublicCapability.requiredInputs');
  const compatibilityIdentities = protocolStringArray(record.compatibilityIdentities, 'PublicCapability.compatibilityIdentities');
  const commandSchema = validateCommandSchema(record.commandSchema);
  const authorization = validateCapabilityAuthorization(record.authorization);
  const planner = protocolChoice(record.planner, plannerAvailability, 'PublicCapability.planner');
  const executor = protocolChoice(record.executor, executorAvailability, 'PublicCapability.executor');
  const verifier = protocolChoice(record.verifier, verifierAvailability, 'PublicCapability.verifier');
  const recovery = protocolChoice(record.recovery, recoveryBehaviors, 'PublicCapability.recovery');
  const effects = protocolStringArray(record.effectClasses, 'PublicCapability.effectClasses', effectClasses.length)
    .map((effect) => protocolChoice(effect, effectClasses, 'PublicCapability.effectClasses'));
  const qualificationState = protocolChoice(record.qualificationState, qualificationStates, 'PublicCapability.qualificationState');

  if (typeof record.readOnly !== 'boolean') {
    throw new ProtocolValidationError('PublicCapability: "readOnly" must be a boolean.');
  }

  if (record.readOnly) {
    const mutatingEffects = effects.filter((e) =>
      e !== 'filesystem-read' && e !== 'network-read'
    );
    if (mutatingEffects.length > 0) {
      throw new ProtocolValidationError(
        `PublicCapability: readOnly capability cannot have mutating effectClasses: ${mutatingEffects.join(', ')}.`
      );
    }
    if (recovery !== 'n/a' || authorization.mechanism !== 'read-only') {
      throw new ProtocolValidationError(
        `PublicCapability: readOnly capability recovery must be "n/a", got "${String(record.recovery)}".`
      );
    }
  } else if (authorization.mechanism === 'read-only') {
    throw new ProtocolValidationError('A mutating capability cannot acquire read-only authorization.');
  }

  if (qualificationState === 'planner-only' && executor !== 'unavailable') {
    throw new ProtocolValidationError(
      'PublicCapability: "planner-only" state requires executor to be "unavailable".'
    );
  }
  if (qualificationState === 'implementation-missing' && executor !== 'unavailable') {
    throw new ProtocolValidationError(
      'PublicCapability: "implementation-missing" state requires executor to be "unavailable".'
    );
  }

  if (qualificationState === 'qualified' && (planner !== 'built-in' || executor !== 'built-in' || verifier === 'unavailable')) {
    throw new ProtocolValidationError('Qualified capabilities require real built-in planning/execution and an available verification contract.');
  }
  return {
    schemaVersion: 1, id, engine: record.engine, owner: record.owner, title, description,
    supportedProfiles, supportedPlatforms, requiredInputs, commandSchema, authorization,
    planner, executor, verifier, recovery, effectClasses: effects, compatibilityIdentities,
    qualificationState, readOnly: record.readOnly
  };
}

const envelopeAllowedKeys = ['schemaVersion', 'kind', 'cliVersion', 'capabilities', 'engines'] as const;

export function validatePublicCapabilitiesEnvelope(value: unknown): PublicCapabilitiesEnvelopeV1 {
  const record = assertStrictObject(value, 'PublicCapabilitiesEnvelope');
  assertSchemaVersion(record, publicProtocolSchemaVersion, 'PublicCapabilitiesEnvelope');
  assertStrictKeys(record, envelopeAllowedKeys, 'PublicCapabilitiesEnvelope');

  if (record.kind !== 'liftoff-public-capabilities') {
    throw new ProtocolValidationError(
      `PublicCapabilitiesEnvelope: kind must be "liftoff-public-capabilities", got "${String(record.kind)}".`
    );
  }

  const cliVersion = protocolReleaseVersion(record.cliVersion, 'PublicCapabilitiesEnvelope.cliVersion');
  const capabilities = protocolArray(record.capabilities, 'PublicCapabilitiesEnvelope.capabilities').map(validatePublicCapability);
  if (new Set(capabilities.map((capability) => capability.id)).size !== capabilities.length) {
    throw new ProtocolValidationError('PublicCapabilitiesEnvelope contains duplicate capability identities.');
  }
  const engines = protocolArray(record.engines, 'PublicCapabilitiesEnvelope.engines', engineIds.length)
    .map((value): EngineDescriptor => {
      const engine = assertStrictObject(value, 'PublicCapabilitiesEnvelope.engine');
      assertStrictKeys(engine, ['id', 'owner', 'title', 'description', 'applicationModule'], 'PublicCapabilitiesEnvelope.engine');
      const id = protocolChoice(engine.id, engineIds, 'PublicCapabilitiesEnvelope.engine.id');
      const owner = protocolChoice(engine.owner, engineOwners, 'PublicCapabilitiesEnvelope.engine.owner');
      const canonical = canonicalEngines[id];
      if (owner !== canonical.owner || engine.applicationModule !== canonical.applicationModule) {
        throw new ProtocolValidationError('PublicCapabilitiesEnvelope engine ownership or application module does not match its registered identity.');
      }
      return {
        id, owner, applicationModule: canonical.applicationModule,
        title: protocolString(engine.title, 'PublicCapabilitiesEnvelope.engine.title', 256),
        description: protocolString(engine.description, 'PublicCapabilitiesEnvelope.engine.description')
      };
    });
  if (engines.length !== engineIds.length || new Set(engines.map((engine) => engine.id)).size !== engineIds.length) {
    throw new ProtocolValidationError(
      `PublicCapabilitiesEnvelope: "engines" must be an array of exactly ${engineIds.length} engine descriptors.`
    );
  }

  return { schemaVersion: 1, kind: 'liftoff-public-capabilities', cliVersion, capabilities, engines };
}
