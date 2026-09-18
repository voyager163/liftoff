import path from 'node:path';
import { canonicalSha256, isRecord } from '../../../domain/governance/activation/canonical-json.js';
import type { AdoptionFrameworkSelection } from '../../../domain/project-evolution/adoption/contracts.js';
import { canonicalizeCodingAgents, getCodingAgent } from '../../project/catalog.js';
import { ApplicationInspectionError, applicationParts } from '../../repair/application-files.js';
import { applicationBounds, type ApplicationPatchDocument, type ApplicationReferenceDisposition, type ApplicationVerificationCommand } from '../../repair/application-types.js';
import { parseApplicationPatch } from '../../repair/application-patch-inspection.js';
import { parseApplicationPreparation } from '../../repair/application-preparation-inputs.js';
import type { ApplicationPreparationRequest } from '../../repair/application-preparation-types.js';
import { parseStrictManifestJson } from '../../../domain/project/manifest/json.js';

export interface AdoptionAddition {
  logicalName: string;
  componentId: string;
  targetPathParts: string[];
  stagedPathParts: string[];
  targetMode: number;
  precondition: 'absent' | 'identical';
  references: ApplicationReferenceDisposition[];
}

export interface AdoptionProposal {
  schemaVersion: 1;
  kind: 'liftoff-adoption-proposal';
  projectRoot: string;
  inspectionDigest: string;
  projectName: string;
  profile: string;
  componentRootPathParts: string[];
  framework: AdoptionFrameworkSelection;
  governanceProfile: 'none' | 'single-maintainer-gitflow';
  dynamicReferencesReviewed: true;
  patch: ApplicationPatchDocument | null;
  additions: AdoptionAddition[];
  verification: { commands: ApplicationVerificationCommand[]; preparation: ApplicationPreparationRequest[] };
}

export function adoptionObject(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some((key) => !fields.includes(key))) {
    throw new ApplicationInspectionError(`${label} must contain only its documented schema-1 fields.`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(value)) {
    throw new ApplicationInspectionError(`${label} requires a concrete portable logical identity.`);
  }
  return value;
}

export function parseAdoptionFramework(value: unknown): AdoptionFrameworkSelection {
  const item = adoptionObject(value, ['workflow', 'agents', 'defaultAgent', 'initialize', 'copilotCloud'], 'Adoption framework');
  if (!['openspec', 'spec-kit'].includes(String(item.workflow)) || !Array.isArray(item.agents) ||
    item.agents.some((agent) => typeof agent !== 'string') ||
    typeof item.initialize !== 'boolean' || typeof item.copilotCloud !== 'boolean') {
    throw new ApplicationInspectionError('Adoption framework requires an explicit workflow, canonical agents and initialization/network-affecting selection.');
  }
  const agents = canonicalizeCodingAgents(item.agents).agents.map((agent) => agent.id);
  if (canonicalSha256(agents) !== canonicalSha256(item.agents)) throw new ApplicationInspectionError('Adoption agents must be unique exact canonical IDs.');
  const defaultAgent = item.defaultAgent === undefined ? undefined : getCodingAgent(String(item.defaultAgent));
  if (item.defaultAgent !== undefined && (!defaultAgent || defaultAgent.id !== item.defaultAgent || !agents.includes(defaultAgent.id)) ||
    item.workflow === 'openspec' && defaultAgent || item.workflow === 'spec-kit' && agents.length > 0 && !defaultAgent ||
    item.copilotCloud && !agents.includes('github-copilot') || item.initialize !== (agents.length > 0)) {
    throw new ApplicationInspectionError('Adoption framework/default-agent initialization selection is inconsistent; no integration state may be invented.');
  }
  return {
    workflow: item.workflow === 'openspec' ? 'openspec' : 'spec-kit', agents,
    ...(defaultAgent ? { defaultAgent: defaultAgent.id } : {}), initialize: item.initialize, copilotCloud: item.copilotCloud
  };
}

export function parseAdoptionProposal(bytes: Buffer): AdoptionProposal {
  if (bytes.length > applicationBounds.patchBytes) throw new ApplicationInspectionError('Adoption proposal exceeds the 64 KiB bound.');
  let parsed: unknown;
  try { parsed = parseStrictManifestJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), 'Adoption proposal'); }
  catch { throw new ApplicationInspectionError('Adoption proposal must be valid UTF-8 JSON.'); }
  const item = adoptionObject(parsed, [
    'schemaVersion', 'kind', 'projectRoot', 'inspectionDigest', 'projectName', 'profile', 'componentRootPathParts',
    'framework', 'governanceProfile', 'dynamicReferencesReviewed', 'patch', 'additions', 'verification'
  ], 'Adoption proposal');
  if (item.schemaVersion !== 1 || item.kind !== 'liftoff-adoption-proposal' ||
    typeof item.projectRoot !== 'string' || !path.isAbsolute(item.projectRoot) || path.resolve(item.projectRoot) !== item.projectRoot ||
    typeof item.inspectionDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(item.inspectionDigest) ||
    typeof item.projectName !== 'string' || !item.projectName.trim() || /[\u0000-\u001f\u007f]/u.test(item.projectName) ||
    item.dynamicReferencesReviewed !== true || !['none', 'single-maintainer-gitflow'].includes(String(item.governanceProfile))) {
    throw new ApplicationInspectionError('Adoption proposal requires exact project, current inspection, supported metadata decisions and explicit reference review.');
  }
  if (!Array.isArray(item.additions) || item.additions.length > applicationBounds.mappings) throw new ApplicationInspectionError('Adoption additions must be a bounded explicit file inventory.');
  const additions: AdoptionAddition[] = item.additions.map((value) => {
    const entry = adoptionObject(value, ['logicalName', 'componentId', 'targetPathParts', 'stagedPathParts', 'targetMode', 'precondition', 'references'], 'Adoption addition');
    if (typeof entry.targetMode !== 'number' || !Number.isInteger(entry.targetMode) || entry.targetMode < 0 || entry.targetMode > 0o777 ||
      !['absent', 'identical'].includes(String(entry.precondition)) || !Array.isArray(entry.references) || entry.references.length > applicationBounds.references) {
      throw new ApplicationInspectionError('Adoption additions require exact ordinary modes, absence/identical preconditions and bounded reference review.');
    }
    const references: ApplicationReferenceDisposition[] = entry.references.map((value) => {
      const reference = adoptionObject(value, ['referenceId', 'disposition', 'afterTargetPathParts'], 'Addition reference');
      if (typeof reference.referenceId !== 'string' || !/^[a-f0-9]{64}$/u.test(reference.referenceId) ||
        reference.disposition !== 'updated') throw new ApplicationInspectionError('Addition references require exact observed candidate IDs and concrete updated targets.');
      return { referenceId: reference.referenceId, disposition: 'updated', afterTargetPathParts: applicationParts(reference.afterTargetPathParts) };
    });
    return {
      logicalName: identifier(entry.logicalName, 'Addition logicalName'), componentId: identifier(entry.componentId, 'Addition componentId'),
      targetPathParts: applicationParts(entry.targetPathParts), stagedPathParts: applicationParts(entry.stagedPathParts),
      targetMode: entry.targetMode, precondition: entry.precondition === 'absent' ? 'absent' : 'identical', references
    };
  });
  const verification = adoptionObject(item.verification, ['commands', 'preparation'], 'Adoption verification');
  const preparation = parseApplicationPreparation(verification.preparation);
  if (!Array.isArray(verification.commands) || verification.commands.length > applicationBounds.commands) {
    throw new ApplicationInspectionError('Adoption verification commands must be a bounded array.');
  }
  const commands: ApplicationVerificationCommand[] = verification.commands.map((value) => {
    const command = adoptionObject(value, ['executable', 'args', 'cwdPathParts', 'timeoutMs', 'maxOutputBytes', 'network'], 'Adoption command');
    if (typeof command.executable !== 'string' || !Array.isArray(command.args) || command.args.length > 32 ||
      command.args.some((arg) => typeof arg !== 'string') || typeof command.network !== 'boolean' ||
      typeof command.timeoutMs !== 'number' || !Number.isInteger(command.timeoutMs) || command.timeoutMs < 1 || command.timeoutMs > applicationBounds.commandTimeoutMs ||
      typeof command.maxOutputBytes !== 'number' || !Number.isInteger(command.maxOutputBytes) || command.maxOutputBytes < 1 || command.maxOutputBytes > applicationBounds.commandOutputBytes) {
      throw new ApplicationInspectionError('Adoption checks require bounded literal argv, working directory and exact time/output/network scope.');
    }
    return {
      executable: command.executable, args: command.args, cwdPathParts: applicationParts(command.cwdPathParts, true),
      timeoutMs: command.timeoutMs, maxOutputBytes: command.maxOutputBytes, network: command.network
    };
  });
  const patch = item.patch === null ? null : parseApplicationPatch(Buffer.from(JSON.stringify(item.patch), 'utf8'));
  if (preparation.length > 0 && commands.length === 0) {
    throw new ApplicationInspectionError('Adoption preparation must serve explicit staged checks; standalone dependency installation is not adoption authority.');
  }
  if (patch && canonicalSha256({ commands: patch.verification.commands, preparation: patch.verification.preparation ?? [] }) !== canonicalSha256({ commands, preparation })) {
    throw new ApplicationInspectionError('Adoption and its unchanged application-patch subplan must bind exactly the same verification/preparation policy.');
  }
  if ((patch || additions.length) && commands.length === 0) throw new ApplicationInspectionError('Application adoption effects require exact supported staged checks; metadata approval is not behavioral verification.');
  return {
    schemaVersion: 1, kind: 'liftoff-adoption-proposal', projectRoot: item.projectRoot, inspectionDigest: item.inspectionDigest,
    projectName: item.projectName.trim(), profile: identifier(item.profile, 'Adoption profile'), componentRootPathParts: applicationParts(item.componentRootPathParts, true),
    framework: parseAdoptionFramework(item.framework), governanceProfile: item.governanceProfile === 'none' ? 'none' : 'single-maintainer-gitflow',
    dynamicReferencesReviewed: true, patch, additions, verification: { commands, preparation }
  };
}
