import { lstat, realpath } from 'node:fs/promises';
import { devNull } from 'node:os';
import path from 'node:path';
import { normalizeManifestFramework, normalizeManifestProject, parseManifest, resolveProjectPath, validateArtifactPathParts } from '../file-system.js';
import { buildProjectPlan } from '../planner.js';
import { buildRepositoryGovernanceArtifacts } from '../repository-governance.js';
import { activationCompatibility, currentActivationIdentity } from '../governance-activation/graph.js';
import { canonicalJson, canonicalSha256 } from '../governance-activation/canonical-json.js';
import {
  validateApprovalEnvelope, validateEvidenceHeader, validateLiveReadbackProof, validateUserActivationState,
  validateSavedTransitionPlan
} from '../governance-activation/validators.js';
import type { ApprovalEnvelope, PhaseEvidenceRecord, SavedTransitionPlan, UserActivationState } from '../governance-activation/types.js';
import type { GeneratedArtifact, LiftoffManifest } from '../types.js';
import { NodeCommandRunner, type CommandRunner } from '../process-runner.js';
import type { AssessmentDiagnostic, AssessmentProjectIdentity, JsonValue, LiveAssessmentScope } from './types.js';
import { AssessmentFiles, AssessmentInputError, errorCode, parseAssessmentJson } from './readers.js';
import { containsSensitiveText, isRecord, jsonValue, sanitizeAssessmentText } from './sanitize.js';

export interface AssessmentProject {
  manifest: LiftoffManifest | null;
  project: LiftoffManifest['project'];
  identity: AssessmentProjectIdentity;
  managedEntries: Array<{ logicalName: string; pathParts: string[]; contentHash: string }>;
  renderedCore: GeneratedArtifact[];
  state: UserActivationState | null;
  stateIdentity: JsonValue;
  evidence: PhaseEvidenceRecord[];
  approvals: ApprovalEnvelope[];
  plans: SavedTransitionPlan[];
  bindingBaseline: string | null;
  invalidEvidence: boolean;
  diagnostics: AssessmentDiagnostic[];
}

function diagnostic(code: string, message: string, source: string): AssessmentDiagnostic {
  return { code, message: sanitizeAssessmentText(message), source: sanitizeAssessmentText(source), severity: 'warning' };
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new AssessmentInputError('malformed-manifest', `${label} contains unsupported fields.`, 'liftoff.manifest.json');
}
function identityHeader(value: unknown, label: string): JsonValue {
  if (!isRecord(value)) throw new AssessmentInputError('malformed-identity', `${label} must be an object.`, label);
  const fields = Object.keys(currentActivationIdentity);
  if (fields.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !fields.includes(key))) {
    throw new AssessmentInputError('malformed-identity', `${label} has incomplete or unknown identity fields.`, label);
  }
  for (const [key, sample] of Object.entries(currentActivationIdentity)) {
    const member = value[key];
    if (typeof sample === 'number' ? !Number.isInteger(member) || Number(member) < 1 : typeof member !== 'string' || !member) {
      throw new AssessmentInputError('malformed-identity', `${label}.${key} has an invalid value type.`, label);
    }
  }
  if (typeof value.phaseGraphHash !== 'string' || !/^[a-f0-9]{64}$/u.test(value.phaseGraphHash)) {
    throw new AssessmentInputError('malformed-identity', `${label}.phaseGraphHash is not a SHA-256 digest.`, label);
  }
  return containsSensitiveText(JSON.stringify(value)) ? '[withheld: sensitive identity]' : jsonValue(value);
}
function compatibleIdentity(value: JsonValue): boolean {
  return [...activationCompatibility.values()].some((identity) => canonicalJson(value) === canonicalJson(identity));
}

function rawArtifactPaths(raw: Record<string, unknown>): void {
  const lists = Number(raw.artifactVersion) >= 6 ? ['managedArtifacts', 'projectArtifacts'] : ['artifacts'];
  for (const key of lists) {
    const list = raw[key];
    if (!Array.isArray(list)) throw new AssessmentInputError('malformed-manifest', `${key} must be an array.`, 'liftoff.manifest.json');
    for (const entry of list) {
      if (!isRecord(entry) || typeof entry.logicalName !== 'string' || !entry.logicalName ||
          typeof entry.category !== 'string' || !Array.isArray(entry.pathParts)) {
        throw new AssessmentInputError('malformed-manifest', `${key} contains malformed artifact metadata.`, 'liftoff.manifest.json');
      }
      validateArtifactPathParts(entry.pathParts, 'Assessment manifest path');
      const hash = key === 'projectArtifacts' ? entry.generationHash : entry.contentHash;
      if (typeof hash !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(hash)) {
        throw new AssessmentInputError('malformed-manifest', `${key} contains an invalid content digest.`, 'liftoff.manifest.json');
      }
    }
  }
}

export async function inspectAssessmentProject(files: AssessmentFiles): Promise<AssessmentProject> {
  const text = await files.read(['liftoff.manifest.json']);
  if (text === null) throw new AssessmentInputError('project-not-found', 'No liftoff.manifest.json was found in the selected project.');
  const raw = parseAssessmentJson(text, 'liftoff.manifest.json');
  if (!isRecord(raw) || typeof raw.artifactVersion !== 'number' || ![2, 3, 4, 5, 6, 7].includes(raw.artifactVersion)) {
    throw new AssessmentInputError('unsupported-manifest', 'Manifest schema is unknown; no artifact paths were accessed.', 'liftoff.manifest.json');
  }
  rawArtifactPaths(raw);
  const gov = raw.artifactVersion >= 5 && isRecord(raw.governance) ? raw.governance : {};
  const recordedIdentity = gov.activationIdentity === undefined ? null : identityHeader(gov.activationIdentity, 'manifest activation identity');
  const unsupported = recordedIdentity !== null && !compatibleIdentity(recordedIdentity) ||
    (typeof gov.policyVersion === 'string' && !['1', '2', '3', '4', '5', '6'].includes(gov.policyVersion));
  let manifest: LiftoffManifest | null;
  let project: LiftoffManifest['project'];
  if (unsupported) {
    if (raw.generatedBy !== 'Mission Control Liftoff' || typeof raw.liftoffVersion !== 'string' ||
        !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(raw.liftoffVersion)) {
      throw new AssessmentInputError('malformed-manifest', 'Manifest producer/version fields are invalid.', 'liftoff.manifest.json');
    }
    exactKeys(raw, ['artifactVersion', 'generatedBy', 'liftoffVersion', 'project', 'framework', 'governance', 'managedArtifacts', 'projectArtifacts', 'artifacts'], 'Manifest');
    exactKeys(gov, ['profile', 'policyVersion', 'state', 'activationIdentity'], 'Governance metadata');
    if (gov.profile !== 'single-maintainer-gitflow' || !['handoff-generated', 'handoff-partial'].includes(String(gov.state)) ||
        typeof gov.policyVersion !== 'string' || !/^[1-9]\d*$/u.test(gov.policyVersion)) {
      throw new AssessmentInputError('malformed-manifest', 'Governance metadata is invalid.', 'liftoff.manifest.json');
    }
    if (isRecord(recordedIdentity) && recordedIdentity.policyVersion !== gov.policyVersion) {
      throw new AssessmentInputError('malformed-manifest', 'Recorded policy and activation identity contradict one another.', 'liftoff.manifest.json');
    }
    project = normalizeManifestProject(raw.project, raw.artifactVersion);
    normalizeManifestFramework(raw.framework, raw.artifactVersion, project);
    manifest = null;
  } else {
    const parsed = parseManifest(raw);
    manifest = parsed;
    project = parsed.project;
  }
  const diagnostics: AssessmentDiagnostic[] = [];
  if (unsupported) diagnostics.push(diagnostic('unsupported-activation', 'The recorded activation tuple is not supported. Independent local facts remain assessable; no migration mapping is being inferred.', 'liftoff.manifest.json'));
  const profile = manifest?.governance.profile ?? String(gov.profile);
  const identity: AssessmentProjectIdentity = {
    availability: unsupported ? 'unsupported' : 'known', manifestVersion: raw.artifactVersion,
    cliVersion: typeof raw.liftoffVersion === 'string' ? raw.liftoffVersion : null,
    profile, policyVersion: typeof gov.policyVersion === 'string' ? sanitizeAssessmentText(gov.policyVersion, 64) : null,
    recordedActivationIdentity: recordedIdentity, stateSource: 'not-started'
  };
  const workload = project.workload;
  const plan = project.agents.length === 0 ? null : buildProjectPlan({
    projectName: project.name, projectType: workload.kind,
    ...(workload.kind === 'power-apps-code-app' ? { codeAppsPlugin: workload.codeAppsPlugin } : {
      apiStack: workload.apiStack, cloud: workload.cloud, region: workload.region,
      includeFrontend: workload.frontend, environments: workload.environments,
      ...(workload.kind === 'genai' ? { pattern: workload.pattern } : {})
    }),
    agents: project.agents, defaultAgent: project.defaultAgent, specWorkflow: project.specWorkflow,
    governanceProfile: profile === 'none' ? 'none' : 'single-maintainer-gitflow'
  }, { requireProjectName: true });
  const renderedCore = plan ? buildRepositoryGovernanceArtifacts(plan) : [];
  if (!plan) diagnostics.push(diagnostic(
    'unobserved-agent-selection',
    'This historical manifest does not identify configured agents. Current managed handoff rendering is not inferred.',
    'liftoff.manifest.json'
  ));
  const managedEntries = manifest?.managedArtifacts.map((entry) => ({
    logicalName: entry.logicalName, pathParts: entry.pathParts, contentHash: entry.contentHash
  })) ?? [];
  const input: AssessmentProject = {
    manifest, project, identity, managedEntries, renderedCore, state: null,
    stateIdentity: null, evidence: [], approvals: [], plans: [], bindingBaseline: null, invalidEvidence: false, diagnostics
  };
  if (profile === 'none') return input;
  const stateText = await files.read(['governance', 'activation-state.json']);
  if (stateText !== null) {
    const rawState = parseAssessmentJson(stateText, 'governance/activation-state.json');
    if (!isRecord(rawState)) throw new AssessmentInputError('malformed-state', 'Activation state must be an object.', 'governance/activation-state.json');
    if (rawState.schemaVersion === 1) {
      input.stateIdentity = identityHeader(rawState.identity, 'activation state identity');
      if (compatibleIdentity(input.stateIdentity)) {
        input.state = validateUserActivationState(rawState);
        input.identity.stateSource = 'user';
      } else {
        input.identity.stateSource = 'unsupported';
      }
    } else {
      input.identity.stateSource = 'unsupported';
    }
    if (input.identity.stateSource === 'unsupported') {
      input.identity.availability = 'unsupported';
      diagnostics.push(diagnostic('unsupported-state', 'State schema or identity is unsupported; its execution state remains opaque and unchanged.', 'governance/activation-state.json'));
    }
  }
  const evidenceIds = new Set<string>();
  for (const parts of await files.list(['governance', 'evidence'], ['.json'])) {
    const label = parts.join('/');
    const text = await files.read(parts);
    if (text === null) throw new AssessmentInputError('inputs-changed', 'Evidence disappeared during collection.', label);
    const value = parseAssessmentJson(text, label);
    if (containsSensitiveText(text)) {
      input.invalidEvidence = true;
      diagnostics.push(diagnostic('sensitive-evidence', 'Evidence with sensitive content was withheld.', label));
      continue;
    }
    try {
      if (!isRecord(value)) throw new Error('Evidence must be an object.');
      const header = validateEvidenceHeader(Object.hasOwn(value, 'header') ? value.header : value);
      const evidenceId = typeof value.evidenceId === 'string' ? value.evidenceId : parts.at(-1)!.slice(0, -5);
      if (evidenceIds.has(evidenceId)) {
        input.invalidEvidence = true;
        input.evidence = input.evidence.filter((record) => record.evidenceId !== evidenceId);
        diagnostics.push(diagnostic('ambiguous-evidence', `Duplicate evidence identity ${evidenceId} was excluded from assessment bindings.`, label));
        continue;
      }
      evidenceIds.add(evidenceId);
      if (value.liveReadback !== undefined && !Array.isArray(value.liveReadback)) throw new Error('Live proof must be an array.');
      input.evidence.push({
        evidenceId, header,
        ...(Array.isArray(value.liveReadback) ? { liveReadback: value.liveReadback.map(validateLiveReadbackProof) } : {}),
        ...(Object.hasOwn(value, 'payload') ? { payload: value.payload } : {})
      });
    } catch (error) {
      input.invalidEvidence = true;
      diagnostics.push(diagnostic('unsupported-evidence', error instanceof Error ? error.message : 'Evidence could not be interpreted.', label));
    }
  }
  for (const parts of await files.list(['governance', 'approvals'], ['.json'])) {
    const label = parts.join('/');
    const text = await files.read(parts);
    if (text === null) throw new AssessmentInputError('inputs-changed', 'Approval disappeared during collection.', label);
    const value = parseAssessmentJson(text, label);
    try {
      if (containsSensitiveText(text)) throw new Error('Approval with sensitive content was withheld.');
      input.approvals.push(validateApprovalEnvelope(value));
    } catch (error) {
      diagnostics.push(diagnostic('unsupported-approval', error instanceof Error ? error.message : 'Approval could not be interpreted.', label));
    }
  }
  for (const parts of await files.list(['governance', 'plans'], ['.json'])) {
    const label = parts.join('/');
    const text = await files.read(parts);
    if (text === null) throw new AssessmentInputError('inputs-changed', 'Plan disappeared during collection.', label);
    const value = parseAssessmentJson(text, label);
    try {
      if (containsSensitiveText(text)) throw new Error('Plan with sensitive content was withheld.');
      input.plans.push(validateSavedTransitionPlan(value));
    } catch (error) {
      diagnostics.push(diagnostic('unsupported-plan', error instanceof Error ? error.message : 'Plan could not be interpreted.', label));
    }
  }
  return input;
}

export interface AssessmentGitFacts {
  repository: { owner: string; name: string; id: string | null } | null;
  head: string | null;
  issues: string[];
  originState: 'none' | 'verified' | 'unavailable';
}
export function repositoryName(value: string, id: string | null = null): LiveAssessmentScope['repository'] {
  const match = value.match(/^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]+)$/u);
  if (!match || match[2] === '.' || match[2] === '..' || containsSensitiveText(value)) return null;
  return { owner: match[1]!, name: match[2]!, id };
}

export async function inspectAssessmentGit(root: string, runner: CommandRunner = new NodeCommandRunner()): Promise<AssessmentGitFacts> {
  try { await lstat(path.join(root, '.git')); }
  catch (error) {
    if (errorCode(error) === 'ENOENT') return { repository: null, head: null, issues: [], originState: 'none' };
    throw error;
  }
  await resolveProjectPath(root, ['.git']);
  const issues: string[] = [];
  const prefix = ['--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${devNull}`, '-c', 'diff.external=', '-c', 'core.pager=cat'];
  async function git(args: string[]): Promise<string | null> {
    const result = await runner.run({ executable: 'git', args: [...prefix, ...args] }, { cwd: root, timeoutMs: 10_000 });
    if (result.status === 0 && !result.timedOut && !result.errorCode) return result.stdout.trim();
    issues.push(`Local Git ${args[0]} metadata was not observed (${result.timedOut ? 'timeout' : result.errorCode ?? `exit ${result.status}`}).`);
    return null;
  }
  const toplevel = await git(['rev-parse', '--show-toplevel']);
  if (!toplevel || await realpath(toplevel) !== await realpath(root)) {
    return { repository: null, head: null, issues: [...issues, 'Git root does not match the assessed project.'], originState: 'unavailable' };
  }
  const headText = await git(['rev-parse', '--verify', 'HEAD']);
  const remote = await git(['config', '--local', '--get', 'remote.origin.url']);
  let repository: AssessmentGitFacts['repository'] = null;
  if (remote) {
    const ssh = remote.match(/^git@github\.com:([^/\s]+\/[^/\s]+?)(?:\.git)?$/u);
    const https = remote.match(/^https:\/\/github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/u);
    repository = repositoryName(ssh?.[1] ?? https?.[1] ?? '');
    if (!repository) issues.push('Git origin is not a supported credential-free GitHub repository binding.');
  }
  return {
    repository, head: headText && /^[a-f0-9]{40,64}$/u.test(headText) ? headText : null,
    issues,
    originState: repository ? 'verified' : 'unavailable'
  };
}
