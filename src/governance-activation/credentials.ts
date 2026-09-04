import { password } from '@inquirer/prompts';
import { redactSensitiveText, type CommandResult, type CommandRunner } from '../process-runner.js';
import type { ExternalCommand } from '../types.js';
import { canonicalSha256 } from './canonical-json.js';
import {
  currentActivationIdentity
} from './graph.js';
import {
  credentialPolicySchemaVersion
} from './identity.js';
import type {
  ActivationIdentity,
  CredentialPermissionSet,
  CredentialPolicy,
  CredentialPolicyProofMetadata,
  CredentialRepositoryIdentity,
  CredentialWorkflowAllowlistEntry,
  GitHubAppCredentialMetadata
} from './types.js';
import {
  runnerPreflightDisplayNameTemplate,
  runnerPreflightOrganizationPermissions,
  runnerPreflightPatLifetimeDays,
  runnerPreflightRepositoryPermissions,
  runnerPreflightRotationLeadDays,
  runnerPreflightSecretName
} from './types.js';
import { validateCredentialPolicy } from './validators.js';

export const credentialPolicyPathParts = ['governance', 'credentials', 'preflight-policy.json'] as const;

export interface CredentialRepositoryInput {
  id?: string;
  owner: string;
  name: string;
}

export interface RepositorySecretReadback {
  repository: CredentialRepositoryIdentity;
  secretName: typeof runnerPreflightSecretName;
  updatedAt: string;
  readbackDigest: string;
}

export interface RepositorySecretWriteRequest {
  repository: CredentialRepositoryIdentity;
  secretName: typeof runnerPreflightSecretName;
  value: SensitiveCredentialValue;
}

export interface DiscoveredGitHubAppInstallation {
  installationId: number;
  appSlug: string;
  approved: boolean;
  verified: boolean;
  selection: 'selected-repository' | 'all-repositories';
  repositories: readonly CredentialRepositoryIdentity[];
  permissions: CredentialPermissionSet;
  permissionsVerifiedAt: string;
  readbackDigest?: string;
  token: {
    canGenerate: boolean;
    ttlSeconds: number;
  };
}

export interface GitHubCredentialAdapter {
  discoverAppInstallations(repository: CredentialRepositoryIdentity): Promise<readonly DiscoveredGitHubAppInstallation[]>;
  readRepositorySecret(repository: CredentialRepositoryIdentity, secretName: typeof runnerPreflightSecretName): Promise<RepositorySecretReadback | null>;
  setRepositorySecret?(request: RepositorySecretWriteRequest): Promise<RepositorySecretReadback>;
}

export interface PatEnrollmentGuidance {
  authKind: 'fine-grained-pat';
  displayNameTemplate: typeof runnerPreflightDisplayNameTemplate;
  displayName: string;
  secretName: typeof runnerPreflightSecretName;
  lifetimeDays: typeof runnerPreflightPatLifetimeDays;
  owner: string;
  repository: CredentialRepositoryIdentity;
  selectedRepositoryOnly: true;
  permissions: CredentialPermissionSet;
  writes: readonly [];
  expiresAt: string;
  rotationLeadDays: typeof runnerPreflightRotationLeadDays;
  rotationDueAt: string;
}

export type CredentialPlan =
  | {
      authKind: 'github-app';
      policy: CredentialPolicy;
      app: DiscoveredGitHubAppInstallation;
      fallbackGuidance: null;
      rejectionReasons: readonly string[];
    }
  | {
      authKind: 'fine-grained-pat';
      policy: null;
      app: null;
      fallbackGuidance: PatEnrollmentGuidance;
      rejectionReasons: readonly string[];
    };

export interface CredentialUsageReference {
  workflowPath: string;
  job: string;
}

export interface CredentialPolicyUsage {
  repository: CredentialRepositoryIdentity;
  permissions: CredentialPermissionSet;
  references: readonly CredentialUsageReference[];
  forwardsCredential: boolean;
  verifiedReadbackDigest?: string;
  now?: Date;
}

export interface CredentialPolicyUsageResult {
  ready: boolean;
  status: CredentialPolicy['status'] | 'not-ready';
  issues: readonly string[];
}

export interface CredentialLeakInput {
  source: 'generated-artifact' | 'process-log' | 'imported-evidence' | 'screenshot-text' | 'chat-text';
  label: string;
  text: string;
}

export interface CredentialLeakScanResult {
  status: 'clear' | 'compromised';
  leaks: readonly { source: CredentialLeakInput['source']; label: string; pattern: string }[];
  guidance: readonly string[];
  unauthorizedRevocationAttempted: false;
}

export type MaskedCredentialPrompt = (message: string) => Promise<SensitiveCredentialValue>;

export interface GitHubCliSecretWriteResult {
  command: ExternalCommand;
  result: CommandResult;
}

export class SensitiveCredentialValue {
  #value: string | undefined;

  private constructor(value: string) {
    this.#value = value;
  }

  static fromMaskedInput(value: string): SensitiveCredentialValue {
    if (value.length === 0) {
      throw new Error('Credential input cannot be empty.');
    }
    return new SensitiveCredentialValue(value);
  }

  use<T>(consumer: (value: string) => T): T {
    if (this.#value === undefined) {
      throw new Error('Credential value has already been released.');
    }
    return consumer(this.#value);
  }

  release(): void {
    this.#value = undefined;
  }
}

export async function inquirerMaskedCredentialPrompt(message: string): Promise<SensitiveCredentialValue> {
  const value = await password({ message, mask: '*' });
  return SensitiveCredentialValue.fromMaskedInput(value);
}

export function repositorySecretSetCommand(
  repository: CredentialRepositoryIdentity,
  secretName: typeof runnerPreflightSecretName
): ExternalCommand {
  return {
    executable: 'gh',
    args: ['secret', 'set', secretName, '--repo', repository.fullName, '--app', 'actions', '--body-file', '-']
  };
}

export async function writeRepositorySecretWithGitHubCli(input: {
  runner: CommandRunner;
  repository: CredentialRepositoryIdentity;
  secretName: typeof runnerPreflightSecretName;
  value: SensitiveCredentialValue;
  cwd?: string;
}): Promise<GitHubCliSecretWriteResult> {
  const command = repositorySecretSetCommand(input.repository, input.secretName);
  const result = await input.value.use(async (value) => {
    const rawResult = await input.runner.run(command, {
      cwd: input.cwd,
      stdin: value,
      redactValues: [value]
    });
    return {
      ...rawResult,
      stdout: redactSensitiveText(rawResult.stdout, [value]),
      stderr: redactSensitiveText(rawResult.stderr, [value]),
      displayCommand: redactSensitiveText(rawResult.displayCommand, [value]),
      ...(rawResult.errorMessage
        ? { errorMessage: redactSensitiveText(rawResult.errorMessage, [value]) }
        : {})
    };
  });
  return { command, result };
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function canonicalIso(date: Date): string {
  return date.toISOString();
}

export function canonicalCredentialRepository(input: CredentialRepositoryInput): CredentialRepositoryIdentity {
  const owner = input.owner.trim();
  const name = input.name.trim();
  if (!owner || !name || owner.includes('/') || name.includes('/')) {
    throw new Error('Credential repository owner and name must be non-empty path segments.');
  }
  return {
    id: input.id?.trim() || `${owner}/${name}`,
    owner,
    name,
    fullName: `${owner}/${name}`
  };
}

export function repositoryNameFromFullName(fullName: string): string {
  const parts = fullName.trim().split('/');
  const name = parts.at(-1);
  if (!name) {
    throw new Error('Repository full name must include a repository name.');
  }
  return name.toLowerCase();
}

export function runnerPreflightDisplayName(repositoryName: string): string {
  return runnerPreflightDisplayNameTemplate.replace('<repo>', repositoryNameFromFullName(repositoryName));
}

export function runnerPreflightPermissions(): CredentialPermissionSet {
  return {
    repository: [...runnerPreflightRepositoryPermissions],
    organization: [...runnerPreflightOrganizationPermissions]
  };
}

export function buildPatEnrollmentGuidance(input: {
  repository: CredentialRepositoryIdentity;
  now?: Date;
}): PatEnrollmentGuidance {
  const createdAt = input.now ?? new Date();
  const expiresAt = addDays(createdAt, runnerPreflightPatLifetimeDays);
  const rotationDueAt = addDays(expiresAt, -runnerPreflightRotationLeadDays);
  return {
    authKind: 'fine-grained-pat',
    displayNameTemplate: runnerPreflightDisplayNameTemplate,
    displayName: runnerPreflightDisplayName(input.repository.name),
    secretName: runnerPreflightSecretName,
    lifetimeDays: runnerPreflightPatLifetimeDays,
    owner: input.repository.owner,
    repository: input.repository,
    selectedRepositoryOnly: true,
    permissions: runnerPreflightPermissions(),
    writes: [],
    expiresAt: canonicalIso(expiresAt),
    rotationLeadDays: runnerPreflightRotationLeadDays,
    rotationDueAt: canonicalIso(rotationDueAt)
  };
}

function digestPayloadFree(value: unknown): string {
  return canonicalSha256(value);
}

function proofMetadata(input: {
  verifiedAt: string;
  readbackDigest: string;
  readbackProvider: CredentialPolicyProofMetadata['readbackProvider'];
}): CredentialPolicyProofMetadata {
  return {
    verifiedAt: input.verifiedAt,
    readbackDigest: input.readbackDigest,
    readbackProvider: input.readbackProvider,
    payloadFree: true
  };
}

function normalizeAllowedWorkflows(
  allowedWorkflows: readonly CredentialWorkflowAllowlistEntry[]
): CredentialWorkflowAllowlistEntry[] {
  return allowedWorkflows.map((entry, index) => {
    if (!entry.path || entry.jobs.length === 0) {
      throw new Error(`Allowed credential workflow ${index} must include a path and at least one job.`);
    }
    return {
      path: entry.path,
      jobs: [...entry.jobs]
    };
  });
}

export function buildFineGrainedPatCredentialPolicy(input: {
  repository: CredentialRepositoryIdentity;
  allowedWorkflows: readonly CredentialWorkflowAllowlistEntry[];
  createdAt: Date;
  proof: CredentialPolicyProofMetadata;
  identity?: ActivationIdentity;
}): CredentialPolicy {
  const guidance = buildPatEnrollmentGuidance({ repository: input.repository, now: input.createdAt });
  return validateCredentialPolicy({
    schemaVersion: credentialPolicySchemaVersion,
    identity: input.identity ?? currentActivationIdentity,
    repository: input.repository,
    owner: input.repository.owner,
    authKind: 'fine-grained-pat',
    displayNameTemplate: runnerPreflightDisplayNameTemplate,
    displayName: guidance.displayName,
    secretName: runnerPreflightSecretName,
    createdAt: canonicalIso(input.createdAt),
    expiresAt: guidance.expiresAt,
    rotationLeadDays: runnerPreflightRotationLeadDays,
    rotationDueAt: guidance.rotationDueAt,
    permissions: runnerPreflightPermissions(),
    allowedWorkflows: normalizeAllowedWorkflows(input.allowedWorkflows),
    nonForwarding: true,
    status: 'active',
    proof: input.proof,
    app: null,
    pat: {
      lifetimeDays: runnerPreflightPatLifetimeDays,
      selectedRepositoryOnly: true,
      createdBy: 'manual-masked-entry'
    }
  });
}

export function buildGitHubAppCredentialPolicy(input: {
  repository: CredentialRepositoryIdentity;
  installation: DiscoveredGitHubAppInstallation;
  allowedWorkflows: readonly CredentialWorkflowAllowlistEntry[];
  createdAt: Date;
  identity?: ActivationIdentity;
}): CredentialPolicy {
  const app: GitHubAppCredentialMetadata = {
    installationId: input.installation.installationId,
    appSlug: input.installation.appSlug,
    selection: 'selected-repository',
    repositoryFullName: input.repository.fullName,
    permissionsVerifiedAt: input.installation.permissionsVerifiedAt,
    token: {
      strategy: 'installation-token',
      ttlSeconds: input.installation.token.ttlSeconds,
      generatedBy: 'github-app'
    }
  };
  const readbackDigest = input.installation.readbackDigest ?? digestPayloadFree({
    installationId: app.installationId,
    repository: input.repository.fullName,
    permissions: runnerPreflightPermissions(),
    selectedRepositoryOnly: true
  });
  const expiresAt = addDays(input.createdAt, runnerPreflightPatLifetimeDays);
  const rotationDueAt = addDays(expiresAt, -runnerPreflightRotationLeadDays);
  return validateCredentialPolicy({
    schemaVersion: credentialPolicySchemaVersion,
    identity: input.identity ?? currentActivationIdentity,
    repository: input.repository,
    owner: input.repository.owner,
    authKind: 'github-app',
    displayNameTemplate: runnerPreflightDisplayNameTemplate,
    displayName: runnerPreflightDisplayName(input.repository.name),
    secretName: runnerPreflightSecretName,
    createdAt: canonicalIso(input.createdAt),
    expiresAt: canonicalIso(expiresAt),
    rotationLeadDays: runnerPreflightRotationLeadDays,
    rotationDueAt: canonicalIso(rotationDueAt),
    permissions: runnerPreflightPermissions(),
    allowedWorkflows: normalizeAllowedWorkflows(input.allowedWorkflows),
    nonForwarding: true,
    status: 'active',
    proof: proofMetadata({
      verifiedAt: input.installation.permissionsVerifiedAt,
      readbackDigest,
      readbackProvider: 'github-api'
    }),
    app,
    pat: null
  });
}

function sameRepository(left: CredentialRepositoryIdentity, right: CredentialRepositoryIdentity): boolean {
  return left.owner === right.owner &&
    left.name === right.name &&
    left.fullName === right.fullName &&
    left.id === right.id;
}

function samePermissionSet(value: CredentialPermissionSet): boolean {
  return sameStringSet(value.repository, runnerPreflightRepositoryPermissions) &&
    sameStringSet(value.organization, runnerPreflightOrganizationPermissions);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && right.every((entry) => left.includes(entry));
}

function writablePermissions(value: CredentialPermissionSet): string[] {
  return [...value.repository, ...value.organization].filter((entry) => /(^|:)write$/iu.test(entry));
}

export function appInstallationIssues(
  installation: DiscoveredGitHubAppInstallation,
  repository: CredentialRepositoryIdentity
): string[] {
  const issues: string[] = [];
  if (!installation.approved) {
    issues.push('GitHub App installation is not already approved.');
  }
  if (!installation.verified) {
    issues.push('GitHub App installation readback is not verified.');
  }
  if (installation.selection !== 'selected-repository') {
    issues.push('GitHub App installation is not selected-repository scoped.');
  }
  if (installation.repositories.length !== 1 || !installation.repositories.some((candidate) => sameRepository(candidate, repository))) {
    issues.push('GitHub App selected repository does not exactly match the current repository.');
  }
  if (!samePermissionSet(installation.permissions)) {
    issues.push('GitHub App permissions do not exactly match runner-preflight read requirements.');
  }
  if (writablePermissions(installation.permissions).length > 0) {
    issues.push('GitHub App exposes write permissions.');
  }
  if (!installation.token.canGenerate || installation.token.ttlSeconds <= 0 || installation.token.ttlSeconds > 3600) {
    issues.push('GitHub App cannot generate bounded short-lived installation tokens.');
  }
  return issues;
}

export async function discoverCredentialPlan(input: {
  adapter: GitHubCredentialAdapter;
  repository: CredentialRepositoryIdentity;
  allowedWorkflows: readonly CredentialWorkflowAllowlistEntry[];
  now?: Date;
}): Promise<CredentialPlan> {
  const now = input.now ?? new Date();
  const rejectionReasons: string[] = [];
  const installations = await input.adapter.discoverAppInstallations(input.repository);
  for (const installation of installations) {
    const issues = appInstallationIssues(installation, input.repository);
    if (issues.length === 0) {
      return {
        authKind: 'github-app',
        policy: buildGitHubAppCredentialPolicy({
          repository: input.repository,
          installation,
          allowedWorkflows: input.allowedWorkflows,
          createdAt: now
        }),
        app: installation,
        fallbackGuidance: null,
        rejectionReasons
      };
    }
    rejectionReasons.push(...issues);
  }
  return {
    authKind: 'fine-grained-pat',
    policy: null,
    app: null,
    fallbackGuidance: buildPatEnrollmentGuidance({ repository: input.repository, now }),
    rejectionReasons
  };
}

export async function enrollFineGrainedPatCredential(input: {
  adapter: GitHubCredentialAdapter;
  prompt: MaskedCredentialPrompt;
  repository: CredentialRepositoryIdentity;
  allowedWorkflows: readonly CredentialWorkflowAllowlistEntry[];
  now?: Date;
}): Promise<CredentialPolicy> {
  if (!input.adapter.setRepositorySecret) {
    throw new Error('Repository-secret adapter does not support in-memory secret writes.');
  }
  const createdAt = input.now ?? new Date();
  const credential = await input.prompt('Paste the fine-grained PAT. Input is masked and is not logged.');
  try {
    const readback = await input.adapter.setRepositorySecret({
      repository: input.repository,
      secretName: runnerPreflightSecretName,
      value: credential
    });
    if (!sameRepository(readback.repository, input.repository)) {
      throw new Error('Repository secret readback repository does not match the credential policy repository.');
    }
    if (readback.secretName !== runnerPreflightSecretName) {
      throw new Error('Repository secret readback secret name does not match the fixed credential policy secret.');
    }
    return buildFineGrainedPatCredentialPolicy({
      repository: input.repository,
      allowedWorkflows: input.allowedWorkflows,
      createdAt,
      proof: proofMetadata({
        verifiedAt: readback.updatedAt,
        readbackDigest: readback.readbackDigest,
        readbackProvider: 'github-api'
      })
    });
  } finally {
    credential.release();
  }
}

export function validateCredentialPolicyUsage(
  policy: unknown,
  usage: CredentialPolicyUsage
): CredentialPolicyUsageResult {
  const validated = validateCredentialPolicy(policy);
  const issues: string[] = [];
  if (validated.status === 'compromised') {
    issues.push('Credential policy is compromised and must be revoked and rotated before use.');
  }
  if (validated.status === 'expired') {
    issues.push('Credential policy is already expired.');
  }
  if (validated.status === 'expiring') {
    issues.push('Credential policy is inside its rotation window.');
  }
  if (!sameRepository(validated.repository, usage.repository)) {
    issues.push('Credential policy repository does not match the requested repository.');
  }
  if (!samePermissionSet(validated.permissions) || !samePermissionSet(usage.permissions)) {
    issues.push('Credential permissions must exactly match metadata read, hosted-runners read, and network-configurations read.');
  }
  const writable = [...writablePermissions(validated.permissions), ...writablePermissions(usage.permissions)];
  if (writable.length > 0) {
    issues.push(`Credential permissions must not include writes: ${writable.join(', ')}.`);
  }
  if (usage.forwardsCredential || validated.nonForwarding !== true) {
    issues.push('Credential forwarding is not allowed.');
  }
  for (const reference of usage.references) {
    const allowed = validated.allowedWorkflows.find((entry) => entry.path === reference.workflowPath);
    if (!allowed || !allowed.jobs.includes(reference.job)) {
      issues.push(`Credential use by ${reference.workflowPath}#${reference.job} is outside the exact workflow/job allowlist.`);
    }
  }
  const now = usage.now ?? new Date();
  if (Date.parse(validated.expiresAt) <= now.getTime()) {
    issues.push('Credential policy is expired.');
  }
  if (Date.parse(validated.rotationDueAt) <= now.getTime()) {
    issues.push('Credential policy is inside its rotation lead window.');
  }
  if (usage.verifiedReadbackDigest !== validated.proof.readbackDigest) {
    issues.push('Credential policy lacks matching verified payload-free readback.');
  }
  if (validated.authKind === 'github-app') {
    if (
      !validated.app ||
      validated.pat !== null ||
      validated.app.selection !== 'selected-repository' ||
      validated.app.repositoryFullName !== validated.repository.fullName ||
      validated.app.token.strategy !== 'installation-token' ||
      validated.app.token.ttlSeconds <= 0 ||
      validated.app.token.ttlSeconds > 3600
    ) {
      issues.push('GitHub App credential policy is not a supported selected-repository installation token configuration.');
    }
  } else if (!validated.pat || validated.app !== null) {
    issues.push('Fine-grained PAT credential policy has inconsistent auth metadata.');
  }
  return {
    ready: issues.length === 0,
    status: issues.length === 0 ? validated.status : 'not-ready',
    issues
  };
}

const credentialLeakPatterns = [
  { name: 'classic-github-token', pattern: /\bgh[oprsu]_[A-Za-z0-9_]{20,}\b/u },
  { name: 'fine-grained-github-pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u },
  { name: 'slack-webhook', pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/u },
  { name: 'azure-account-key', pattern: /\bAccountKey=[^;\s]+/iu },
  { name: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u }
] as const;

export function detectCredentialLeaks(inputs: readonly CredentialLeakInput[]): CredentialLeakScanResult {
  const leaks = inputs.flatMap((input) =>
    credentialLeakPatterns
      .filter((entry) => entry.pattern.test(input.text))
      .map((entry) => ({ source: input.source, label: input.label, pattern: entry.name }))
  );
  return {
    status: leaks.length > 0 ? 'compromised' : 'clear',
    leaks,
    guidance: leaks.length === 0
      ? []
      : [
          'Treat the credential as compromised.',
          'Revoke the exposed credential in GitHub or its issuing system.',
          'Create a fresh deterministic replacement and rotate the repository secret after verified readback.',
          'Liftoff did not attempt automatic revocation.'
        ],
    unauthorizedRevocationAttempted: false
  };
}
