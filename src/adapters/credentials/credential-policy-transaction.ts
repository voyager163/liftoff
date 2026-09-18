import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { isUtf8 } from 'node:buffer';
import { lstat, realpath } from 'node:fs/promises';
import { validateCredentialPolicy, validateApprovalEnvelope } from '../../domain/governance/activation/validators.js';
import type { CredentialPolicy, TransitionOperation, ApprovalEnvelope } from '../../domain/governance/activation/types.js';
import { credentialPolicyPathParts, detectCredentialLeaks } from '../../governance-activation/credentials.js';
import { activationFileHash } from '../../governance-activation/transition-files.js';
import type { PhaseAdapterExecutionInput } from '../../governance-activation/transition-ports.js';
import { captureProjectFileSnapshot, type ProjectFileMutation, type ProjectFileSnapshot } from '../filesystem/project-transaction.js';
import { createScopedUserLocalRecordStore, type UpdatePreviewOptions } from '../filesystem/update-previews.js';
import { resolveProjectPath } from '../filesystem/project-paths.js';
import { assertGovernanceApprovalIssued } from '../../governance-activation/authority-records.js';
import { GitHubActivationError, object } from '../github/activation-rest.js';
import { assertCredentialAuthority } from './credential-authority.js';
import { assertCredentialProviderPolicyPermitted } from './credential-permissions.js';

export interface CredentialPolicyTransactionPlan {
  kind: 'credential-policy-transaction.v1';
  ownership: 'create-if-absent' | 'renew-owned-policy';
  priorOwnership: string | null;
  pathParts: typeof credentialPolicyPathParts;
  beforeHash: string | null;
  beforeMode: number | null;
  afterHash: string;
  afterMode: number;
  policy: CredentialPolicy;
}

interface FileIdentity { device: string; inode: string; birthtime: string }
interface PolicyOwnership {
  kind: 'credential-policy-owned-output.v1';
  projectRoot: string;
  projectIdentity: FileIdentity;
  fileIdentity: FileIdentity;
  contentHash: string;
  mode: number;
  operation: TransitionOperation;
  envelope: ApprovalEnvelope;
}

function invalidOwnership(): never {
  throw new GitHubActivationError('credential-policy-ownership', 'The exact policy file has no valid project-bound private ownership receipt; it will not be adopted or overwritten.');
}

async function identity(path: string): Promise<FileIdentity> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || stat.isFile() && stat.nlink !== 1) invalidOwnership();
  return { device: String(stat.dev), inode: String(stat.ino), birthtime: String(stat.birthtimeMs) };
}

async function policyIdentity(projectRoot: string) {
  return {
    projectRoot: await realpath(projectRoot), projectIdentity: await identity(projectRoot),
    fileIdentity: await identity(await resolveProjectPath(projectRoot, [...credentialPolicyPathParts]))
  };
}

function ownershipKey(contentHash: string, mode: number): string {
  return canonicalSha256({ kind: 'credential-policy-owned-output.v1', path: credentialPolicyPathParts.join('/'), contentHash, mode });
}

async function readPolicyOwnership(projectRoot: string, snapshot: ProjectFileSnapshot, storage?: UpdatePreviewOptions): Promise<string> {
  if (!snapshot.content) invalidOwnership();
  parseCredentialPolicyBytes(snapshot.content);
  const current = await policyIdentity(projectRoot);
  const row = await createScopedUserLocalRecordStore(projectRoot, 'governance-operation', storage)
    .read(ownershipKey(activationFileHash(snapshot.content)!, snapshot.mode!));
  if (!row) invalidOwnership();
  const value = object(row.value);
  if (Object.keys(value).sort().join(',') !== ['kind', 'projectRoot', 'projectIdentity', 'fileIdentity', 'contentHash', 'mode', 'operation', 'envelope'].sort().join(',') ||
    value.kind !== 'credential-policy-owned-output.v1' || value.projectRoot !== current.projectRoot || row.projectRoot !== current.projectRoot ||
    canonicalSha256(value.projectIdentity) !== canonicalSha256(current.projectIdentity) ||
    value.contentHash !== activationFileHash(snapshot.content) || value.mode !== snapshot.mode) invalidOwnership();
  const originalIdentity = object(value.fileIdentity);
  if (Object.keys(originalIdentity).sort().join(',') !== 'birthtime,device,inode' ||
    Object.values(originalIdentity).some((part) => typeof part !== 'string' || !/^[0-9.]+$/u.test(part))) invalidOwnership();
  const operation = object(value.operation);
  const transaction = object(object(operation.inputs).policyTransaction);
  const envelope = validateApprovalEnvelope(value.envelope);
  if (operation.actionId !== 'local.credential-policy.write' || operation.phaseId !== 'credential-ready' ||
    operation.mutationClass !== 'write-credential-policy' || operation.remote !== false ||
    object(operation.destination).identity !== credentialPolicyPathParts.join('/') ||
    transaction.afterHash !== value.contentHash ||
    (process.platform === 'win32' && typeof transaction.afterMode === 'number' ? transaction.afterMode & 0o200 ? 0o666 : 0o444 : transaction.afterMode) !== value.mode ||
    canonicalSha256(validateCredentialPolicy(transaction.policy)) !== canonicalSha256(parseCredentialPolicyBytes(snapshot.content)) ||
    envelope.phaseId !== 'credential-ready' || envelope.gateKind !== 'credential-enrollment' ||
    !envelope.operationDigests?.includes(canonicalSha256(operation))) invalidOwnership();
  await assertGovernanceApprovalIssued(projectRoot, envelope, storage);
  return canonicalSha256(value);
}

export function parseCredentialPolicyBytes(bytes: Buffer): CredentialPolicy {
  if (bytes.length > 64 * 1024 || !isUtf8(bytes) || detectCredentialLeaks([
    { source: 'imported-evidence', label: credentialPolicyPathParts.join('/'), text: bytes.toString('utf8') }
  ]).status !== 'clear') {
    throw new GitHubActivationError('credential-policy-invalid', 'The credential policy is oversized or contains prohibited material; original bytes were preserved.');
  }
  try { return validateCredentialPolicy(JSON.parse(bytes.toString('utf8'))); }
  catch { throw new GitHubActivationError('credential-policy-invalid', 'The credential policy does not satisfy the released strict contract; original bytes were preserved.'); }
}

export function credentialPolicyBytes(policy: CredentialPolicy): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(validateCredentialPolicy(policy), null, 2)}\n`);
  parseCredentialPolicyBytes(bytes);
  return bytes;
}

/** Renewing public policy changes no remote secret or private key. Ownership comes from the prior private output receipt. */
export async function planCredentialPolicyTransaction(
  projectRoot: string, policy: CredentialPolicy,
  options: { action?: 'create' | 'renew-owned'; storage?: UpdatePreviewOptions } = {}
): Promise<{ plan: CredentialPolicyTransactionPlan; mutation: ProjectFileMutation; snapshot: ProjectFileSnapshot }> {
  const snapshot = await captureProjectFileSnapshot(projectRoot, [...credentialPolicyPathParts]);
  let priorOwnership: string | null = null;
  if (snapshot.content) {
    const previous = parseCredentialPolicyBytes(snapshot.content);
    if (options.action !== 'renew-owned') invalidOwnership();
    priorOwnership = await readPolicyOwnership(projectRoot, snapshot, options.storage);
    const next = validateCredentialPolicy(policy);
    if (previous.authKind !== 'github-app' || next.authKind !== 'github-app' ||
      canonicalSha256(previous.repository) !== canonicalSha256(next.repository) ||
      previous.app?.installationId !== next.app?.installationId || previous.app?.appSlug !== next.app?.appSlug ||
      canonicalSha256(previous.allowedWorkflows) !== canonicalSha256(next.allowedWorkflows) ||
      previous.createdAt !== next.createdAt || Date.parse(next.proof.verifiedAt) < Date.parse(previous.proof.verifiedAt)) {
      throw new GitHubActivationError('credential-policy-renewal', 'Public App policy review must preserve original creation, credential target and allowlist; it cannot rotate a remote secret or invent PAT lifetime.');
    }
  } else if (options.action === 'renew-owned') {
    invalidOwnership();
  }
  const content = credentialPolicyBytes(policy);
  return {
    plan: {
      kind: 'credential-policy-transaction.v1', ownership: snapshot.content ? 'renew-owned-policy' : 'create-if-absent', priorOwnership,
      pathParts: credentialPolicyPathParts, beforeHash: activationFileHash(snapshot.content),
      beforeMode: snapshot.mode ?? null, afterHash: activationFileHash(content)!, afterMode: snapshot.mode ?? 0o600, policy: validateCredentialPolicy(policy)
    },
    snapshot, mutation: { type: 'write', pathParts: [...credentialPolicyPathParts], content, mode: snapshot.mode ?? 0o600 }
  };
}

export async function assertCredentialPolicyPrecondition(projectRoot: string, plan: CredentialPolicyTransactionPlan, storage?: UpdatePreviewOptions): Promise<ProjectFileSnapshot> {
  if (Object.keys(plan).sort().join(',') !== ['kind', 'ownership', 'priorOwnership', 'pathParts', 'beforeHash', 'beforeMode', 'afterHash', 'afterMode', 'policy'].sort().join(',') ||
    plan.kind !== 'credential-policy-transaction.v1' || !Array.isArray(plan.pathParts) ||
    canonicalSha256(plan.pathParts) !== canonicalSha256(credentialPolicyPathParts) ||
    !['create-if-absent', 'renew-owned-policy'].includes(plan.ownership) ||
    (plan.ownership === 'create-if-absent' ? plan.beforeHash !== null || plan.beforeMode !== null || plan.priorOwnership !== null || plan.afterMode !== 0o600 :
      typeof plan.priorOwnership !== 'string' || !/^[a-f0-9]{64}$/u.test(plan.priorOwnership) ||
      plan.beforeHash === null || plan.beforeMode === null || plan.afterMode !== plan.beforeMode) ||
    !Number.isInteger(plan.afterMode) || plan.afterMode < 0 || plan.afterMode > 0o7777 ||
    activationFileHash(credentialPolicyBytes(plan.policy)) !== plan.afterHash) {
    throw new GitHubActivationError('credential-policy-plan', 'Credential policy transaction is not the exact supported reviewed mapping.');
  }
  const before = await captureProjectFileSnapshot(projectRoot, [...credentialPolicyPathParts]);
  if (activationFileHash(before.content) !== plan.beforeHash || (before.mode ?? null) !== plan.beforeMode) {
    throw new GitHubActivationError('credential-policy-drift', 'Credential policy bytes or mode changed after review; no replacement is authorized.');
  }
  if (before.content) parseCredentialPolicyBytes(before.content);
  if (plan.ownership === 'renew-owned-policy' && await readPolicyOwnership(projectRoot, before, storage) !== plan.priorOwnership) invalidOwnership();
  return before;
}

/** Return mutations to writeOutcomeTransaction; the adapter never creates a second file-write path. */
export async function stageCredentialPolicyTransaction(
  input: PhaseAdapterExecutionInput, operation: TransitionOperation,
  plan: CredentialPolicyTransactionPlan, storage?: UpdatePreviewOptions
): Promise<{ fileMutations: ProjectFileMutation[]; filePreconditions: ProjectFileSnapshot[] }> {
  storage ??= input.adapters.githubActivation?.storage;
  const policy = validateCredentialPolicy(plan.policy);
  assertCredentialProviderPolicyPermitted(policy.providerPermissions);
  await assertCredentialAuthority(input, operation, storage);
  if (operation.actionId !== 'local.credential-policy.write' || operation.adapter !== 'local-state' ||
    operation.mutationClass !== 'write-credential-policy' || operation.remote ||
    Object.keys(operation.inputs).join(',') !== 'policyTransaction' || operation.destination.type !== 'local' ||
    canonicalSha256(operation.destination.pathParts ?? null) !== canonicalSha256(credentialPolicyPathParts) || operation.effects?.length ||
    operation.destination.identity !== credentialPolicyPathParts.join('/') ||
    canonicalSha256(operation.inputs.policyTransaction) !== canonicalSha256(plan)) {
    throw new GitHubActivationError('credential-policy-authority', 'A separate exact local credential-policy operation is required.');
  }
  const reviewed = input.plan.fileChanges?.filter((change) => change.pathParts.join('/') === credentialPolicyPathParts.join('/')) ?? [];
  if (reviewed.length !== 1 || reviewed[0]!.beforeHash !== plan.beforeHash || reviewed[0]!.afterHash !== plan.afterHash) {
    throw new GitHubActivationError('credential-policy-authority', 'The saved plan must bind the exact policy before and after bytes.');
  }
  const before = await assertCredentialPolicyPrecondition(input.inspection.projectRoot, plan, storage);
  return {
    filePreconditions: [before],
    fileMutations: [{ type: 'write', pathParts: [...credentialPolicyPathParts], content: credentialPolicyBytes(plan.policy), mode: plan.afterMode }]
  };
}

export async function readbackCredentialPolicy(projectRoot: string, plan: CredentialPolicyTransactionPlan): Promise<CredentialPolicy> {
  const snapshot = await captureProjectFileSnapshot(projectRoot, [...credentialPolicyPathParts]);
  if (!snapshot.content || activationFileHash(snapshot.content) !== plan.afterHash ||
    snapshot.mode !== (process.platform === 'win32' ? plan.afterMode & 0o200 ? 0o666 : 0o444 : plan.afterMode)) {
    throw new GitHubActivationError('credential-policy-readback', 'Independent policy readback differs from the reviewed bytes or mode.');
  }
  return parseCredentialPolicyBytes(snapshot.content);
}

/** Compose this callback into the released transaction; do not write policy or success evidence in a parallel executor. */
export function createCredentialPolicyTransactionGuard(
  input: PhaseAdapterExecutionInput, operation: TransitionOperation, plan: CredentialPolicyTransactionPlan, storage?: UpdatePreviewOptions
): (mutation: ProjectFileMutation, index: number) => Promise<void> {
  storage ??= input.adapters.githubActivation?.storage;
  let policySeen = false;
  let readBack = false;
  return async (mutation) => {
    const name = mutation.pathParts.join('/');
    if (name === credentialPolicyPathParts.join('/')) {
      if (policySeen || mutation.type !== 'write' || activationFileHash(mutation.content) !== plan.afterHash || mutation.mode !== plan.afterMode) {
        throw new GitHubActivationError('credential-policy-transaction', 'The transaction contains a substituted or duplicate policy write.');
      }
      await stageCredentialPolicyTransaction(input, operation, plan, storage);
      policySeen = true;
      return;
    }
    if (!policySeen && (name === 'governance/activation-state.json' || name.startsWith('governance/evidence/'))) {
      throw new GitHubActivationError('credential-policy-order', 'Credential success evidence/state cannot precede the reviewed policy write and independent readback.');
    }
    if (policySeen && !readBack) {
      await assertCredentialAuthority(input, operation, storage);
      await readbackCredentialPolicy(input.inspection.projectRoot, plan);
      const observed = await policyIdentity(input.inspection.projectRoot);
      const envelope = input.inspection.approvals.find((entry) => entry.id === input.plan.approval.envelopeId);
      if (!envelope) invalidOwnership();
      const receipt: PolicyOwnership = {
        kind: 'credential-policy-owned-output.v1', ...observed,
        contentHash: plan.afterHash, mode: process.platform === 'win32' ? plan.afterMode & 0o200 ? 0o666 : 0o444 : plan.afterMode,
        operation, envelope
      };
      const store = createScopedUserLocalRecordStore(input.inspection.projectRoot, 'governance-operation', storage);
      const key = ownershipKey(receipt.contentHash, receipt.mode);
      if (await store.read(key)) {
        await readPolicyOwnership(input.inspection.projectRoot,
          await captureProjectFileSnapshot(input.inspection.projectRoot, [...credentialPolicyPathParts]), storage);
      } else await store.write(key, receipt);
      // Attribution requires the private issued receipt as well as exact project/path/bytes/mode.
      // Atomic rollback can restore the original owned bytes without rewriting their original receipt or dates.
      await readbackCredentialPolicy(input.inspection.projectRoot, plan);
      if (canonicalSha256(await policyIdentity(input.inspection.projectRoot)) !== canonicalSha256(observed)) invalidOwnership();
      readBack = true;
    }
  };
}
