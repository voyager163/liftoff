import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  readBoundProjectFileSnapshot
} from '../../adapters/filesystem/bound-project-files.js';
import type {
  ProjectFileMutation,
  ProjectFileSnapshot
} from '../../adapters/filesystem/project-transaction.js';
import {
  inspectProfileTransitionTransactionCandidate
} from '../../adapters/filesystem/reviewed-update-transaction.js';
import {
  createScopedUserLocalRecordStore,
  type UpdatePreviewOptions
} from '../../adapters/filesystem/update-previews.js';
import { parseProjectConfigOptions } from '../../adapters/filesystem/project-config.js';
import {
  canonicalSha256,
  isRecord,
  sha256Hex
} from '../../domain/governance/activation/canonical-json.js';
import type {
  ModernGovernanceProfile
} from '../../domain/governance/activation/modern-record-contracts.js';
import { catalogKey } from '../../domain/project/inputs.js';
import type {
  ManagedManifestDecision
} from '../project/manifest-writer.js';
import {
  createManifestV8Candidate
} from '../project/manifest-writer.js';
import { parseProjectManifest } from '../project/manifest.js';
import { buildModernManagedCore } from '../project/modern-managed-core.js';
import {
  resolveModernComparisonContext,
  resolveModernManifestSourceContext
} from '../project/source-context.js';
import { projectCatalog } from '../project/catalog.js';
import { AssessmentFiles, parseAssessmentJson } from '../../governance-assessment/readers.js';
import { jsonValue } from '../../domain/governance/assessment/sanitize.js';

export type ProfileTransitionProfile = 'none' | ModernGovernanceProfile;

export interface ProfileTransitionEffect {
  readonly operation: 'write' | 'preserve-orphan';
  readonly logicalName: string;
  readonly pathParts: readonly string[];
  readonly contentDigest: string;
  readonly contentBytes: number;
  readonly mode: number;
}

export interface ProfileTransitionPlan {
  readonly schemaVersion: 1;
  readonly kind: 'liftoff-profile-transition-plan';
  readonly projectRoot: string;
  readonly source: {
    readonly profile: ProfileTransitionProfile;
    readonly policyVersion: string | null;
    readonly activationIdentity: unknown;
    readonly manifestDigest: string;
  };
  readonly target: {
    readonly profile: ProfileTransitionProfile;
    readonly policyVersion: string | null;
    readonly activationIdentity: unknown;
    readonly manifestDigest: string;
  };
  readonly controls: {
    readonly inventoryDigest: string;
    readonly codeowners: readonly {
      readonly pathParts: readonly string[];
      readonly digest: string;
    }[];
    readonly rulesets: readonly {
      readonly pathParts: readonly string[];
      readonly digest: string;
      readonly requiredApprovals: number | null;
      readonly codeOwnerReview: boolean | null;
      readonly lastPushApproval: boolean | null;
      readonly dismissStaleReviews: boolean | null;
    }[];
    readonly activationState:
      | 'preserved'
      | 'absent-required';
    readonly deploymentSafeguards: 'live-settings-untouched';
    readonly proposedWeakening: false;
  };
  readonly evidenceBoundary: {
    readonly preserved: true;
    readonly reusableForTarget: false;
    readonly paths: readonly string[];
  };
  readonly effects: readonly ProfileTransitionEffect[];
  readonly execution: {
    readonly transactionCandidateBinding: string;
    readonly providerOperations: false;
    readonly applicationFiles: 'preserved';
    readonly gitHistory: 'preserved';
    readonly workflow: 'preserved';
    readonly plugins: 'profile-recomposed-only';
  };
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly fingerprint: string;
}

export interface ProfileTransitionCandidate {
  readonly plan: ProfileTransitionPlan;
  readonly mutations: readonly ProjectFileMutation[];
  readonly preconditions: readonly ProjectFileSnapshot[];
}

const maximumFileBytes = 8 * 1024 * 1024;
const planLifetimeMs = 30 * 60 * 1000;
const sha256 = (value: Buffer | string): string =>
  createHash('sha256').update(value).digest('hex');

function invalid(message: string): never {
  throw new Error(message);
}

async function snapshot(
  root: string,
  pathParts: readonly string[]
): Promise<ProjectFileSnapshot> {
  return readBoundProjectFileSnapshot(root, pathParts, {
    maximumBytes: maximumFileBytes,
    linkPolicy: 'transaction-compatible',
    diagnostics: {
      pathLabel: `Profile transition ${pathParts.join('/')}`,
      invalid
    }
  });
}

function content(snapshot: ProjectFileSnapshot, label: string): string {
  if (snapshot.content === undefined) invalid(`${label} is absent.`);
  return snapshot.content.toString('utf8');
}

function modeFor(snapshot: ProjectFileSnapshot): number {
  return snapshot.mode ?? (process.platform === 'win32' ? 0o666 : 0o644);
}

function uniqueSnapshots(
  values: readonly ProjectFileSnapshot[]
): ProjectFileSnapshot[] {
  const byPath = new Map<string, ProjectFileSnapshot>();
  for (const value of values) {
    byPath.set(value.pathParts.join('\0'), value);
  }
  return [...byPath.values()].sort((left, right) =>
    left.pathParts.join('/').localeCompare(right.pathParts.join('/'), 'en')
  );
}

function pullRequestSummary(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.rules)) {
    return {
      requiredApprovals: null,
      codeOwnerReview: null,
      lastPushApproval: null,
      dismissStaleReviews: null
    };
  }
  const rules = value.rules.filter(rule =>
    isRecord(rule) && rule.type === 'pull_request' && isRecord(rule.parameters)
  );
  const parameters = rules.map(rule => (rule as {
    parameters: Record<string, unknown>;
  }).parameters);
  const numeric = parameters.flatMap(entry =>
    typeof entry.required_approving_review_count === 'number'
      ? [entry.required_approving_review_count]
      : []
  );
  const boolean = (key: string): boolean | null => {
    const values = parameters.flatMap(entry =>
      typeof entry[key] === 'boolean' ? [entry[key] as boolean] : []
    );
    return values.length === 0 ? null : values.some(Boolean);
  };
  return {
    requiredApprovals: numeric.length === 0 ? null : Math.max(...numeric),
    codeOwnerReview: boolean('require_code_owner_review'),
    lastPushApproval: boolean('require_last_push_approval'),
    dismissStaleReviews: boolean('dismiss_stale_reviews_on_push')
  };
}

async function controlInventory(
  root: string,
  targetProfile: ProfileTransitionProfile
) {
  const files = new AssessmentFiles(root);
  const snapshots: ProjectFileSnapshot[] = [];
  const codeowners = [];
  for (const pathParts of [
    ['CODEOWNERS'],
    ['.github', 'CODEOWNERS'],
    ['docs', 'CODEOWNERS']
  ]) {
    const observed = await snapshot(root, pathParts);
    snapshots.push(observed);
    if (observed.content !== undefined) {
      codeowners.push({
        pathParts,
        digest: sha256(observed.content)
      });
    }
  }
  const rulesets = [];
  for (const pathParts of await files.list(['governance', 'rulesets'], ['.json'])) {
    const observed = await snapshot(root, pathParts);
    snapshots.push(observed);
    const text = content(observed, `Ruleset ${pathParts.join('/')}`);
    const parsed = parseAssessmentJson(text, pathParts.join('/'));
    rulesets.push({
      pathParts,
      digest: sha256Hex(text),
      ...pullRequestSummary(parsed)
    });
  }
  if (!await files.stable()) {
    invalid('Governance control inventory changed during review.');
  }
  if (targetProfile === 'none') {
    const activationState = await snapshot(
      root,
      ['governance', 'activation-state.json']
    );
    snapshots.push(activationState);
    if (activationState.content !== undefined) {
      invalid(
        'Governance must be deactivated through its separately approved workflow before selecting the none profile.'
      );
    }
  }
  return {
    controls: {
      inventoryDigest: files.digest(),
      codeowners: codeowners.sort((left, right) =>
        left.pathParts.join('/').localeCompare(right.pathParts.join('/'), 'en')
      ),
      rulesets: rulesets.sort((left, right) =>
        left.pathParts.join('/').localeCompare(right.pathParts.join('/'), 'en')
      ),
      activationState: targetProfile === 'none'
        ? 'absent-required' as const
        : 'preserved' as const
    },
    snapshots
  };
}

export async function readConfiguredProfileTransitionTarget(
  projectRoot: string
): Promise<ProfileTransitionProfile | null> {
  const root = await realpath(path.resolve(projectRoot));
  const manifestSnapshot = await snapshot(root, ['liftoff.manifest.json']);
  const manifest = parseProjectManifest(JSON.parse(content(
    manifestSnapshot,
    'Liftoff manifest'
  )));
  if (manifest.artifactVersion !== 8) return null;
  const configSnapshot = await snapshot(root, ['liftoff.config.json']);
  if (configSnapshot.content === undefined) return null;
  const parsed = parseProjectConfigOptions(
    JSON.parse(configSnapshot.content.toString('utf8')),
    {
      ...projectCatalog,
      getSpecWorkflow: value => catalogKey(value) === 'manual'
        ? { id: 'manual' }
        : projectCatalog.getSpecWorkflow(value),
      getGovernanceProfile: value => catalogKey(value) === 'teamgitflow'
        ? { id: 'team-gitflow' }
        : projectCatalog.getGovernanceProfile(value)
    },
    { allowEmptyAgents: true }
  );
  const requested = parsed.governanceProfile;
  if (requested === undefined || requested === manifest.governance.profile) {
    return null;
  }
  if (requested !== 'none' &&
      requested !== 'single-maintainer-gitflow' &&
      requested !== 'team-gitflow') {
    invalid('Configured governance profile is unsupported.');
  }
  return requested;
}

async function buildCandidate(
  projectRoot: string,
  targetProfile: ProfileTransitionProfile,
  now: Date
): Promise<ProfileTransitionCandidate> {
  const root = await realpath(path.resolve(projectRoot));
  const manifestSnapshot = await snapshot(root, ['liftoff.manifest.json']);
  const configSnapshot = await snapshot(root, ['liftoff.config.json']);
  const manifest = parseProjectManifest(JSON.parse(content(
    manifestSnapshot,
    'Liftoff manifest'
  )));
  if (manifest.artifactVersion !== 8) {
    invalid('Profile transition requires a current manifest-v8 project.');
  }
  if (manifest.governance.profile === targetProfile) {
    invalid('Profile transition target already matches the recorded profile.');
  }
  const configured = await readConfiguredProfileTransitionTarget(root);
  if (configured !== targetProfile) {
    invalid(
      'The exact configured governance profile no longer selects this transition.'
    );
  }
  const sourceContext = resolveModernManifestSourceContext(manifest);
  const targetContext = resolveModernComparisonContext(
    sourceContext,
    targetProfile
  );
  const targetArtifacts = buildModernManagedCore({
    selection: targetContext.selection,
    plugins: targetContext.plugins,
    activeLayout: targetContext.activeLayout
  });
  const sourceByName = new Map(
    manifest.managedArtifacts.map(entry => [entry.logicalName, entry])
  );
  const sourcePathKeys = new Set(
    manifest.managedArtifacts.map(entry => entry.pathParts.join('\0'))
  );
  const targetByName = new Map(
    targetArtifacts.map(entry => [entry.logicalName, entry])
  );
  const snapshots: ProjectFileSnapshot[] = [
    manifestSnapshot,
    configSnapshot
  ];
  for (const entry of manifest.managedArtifacts) {
    const observed = await snapshot(root, entry.pathParts);
    snapshots.push(observed);
    if (observed.content === undefined ||
        `sha256:${sha256(observed.content)}` !== entry.contentHash) {
      invalid(
        `Recorded managed source differs before profile transition: ${entry.pathParts.join('/')}.`
      );
    }
  }
  for (const entry of targetArtifacts) {
    snapshots.push(await snapshot(root, entry.pathParts));
  }
  const byPath = new Map(
    uniqueSnapshots(snapshots).map(entry => [
      entry.pathParts.join('\0'),
      entry
    ])
  );
  const decisions: ManagedManifestDecision[] = [];
  const effects: ProfileTransitionEffect[] = [];
  const mutations: ProjectFileMutation[] = [];
  for (const source of manifest.managedArtifacts) {
    if (!targetByName.has(source.logicalName)) {
      decisions.push({
        kind: 'retire',
        logicalName: source.logicalName
      });
      const observed = byPath.get(source.pathParts.join('\0'))!;
      effects.push({
        operation: 'preserve-orphan',
        logicalName: source.logicalName,
        pathParts: [...source.pathParts],
        contentDigest: sha256(observed.content!),
        contentBytes: observed.content!.length,
        mode: modeFor(observed)
      });
    }
  }
  for (const target of targetArtifacts) {
    decisions.push({
      kind: 'bytes',
      logicalName: target.logicalName,
      category: target.category,
      pathParts: [...target.pathParts],
      content: target.content
    });
    const key = target.pathParts.join('\0');
    const observed = byPath.get(key)!;
    const old = sourceByName.get(target.logicalName);
    const owned = sourcePathKeys.has(key) ||
      old?.pathParts.join('\0') === key;
    if (observed.content !== undefined &&
        !owned &&
        observed.content.toString('utf8') !== target.content) {
      invalid(
        `Profile transition cannot acquire conflicting unowned destination ${target.pathParts.join('/')}.`
      );
    }
    if (observed.content?.toString('utf8') !== target.content) {
      mutations.push({
        type: 'write',
        pathParts: [...target.pathParts],
        content: target.content,
        mode: modeFor(observed)
      });
    }
    effects.push({
      operation: 'write',
      logicalName: target.logicalName,
      pathParts: [...target.pathParts],
      contentDigest: sha256(target.content),
      contentBytes: Buffer.byteLength(target.content, 'utf8'),
      mode: modeFor(observed)
    });
  }
  const candidate = createManifestV8Candidate({
    origin: 'profile-transition',
    source: manifest,
    profile: targetProfile,
    managed: decisions
  });
  if (manifestSnapshot.content?.toString('utf8') !== candidate.content) {
    mutations.push({
      type: 'write',
      pathParts: ['liftoff.manifest.json'],
      content: candidate.content,
      mode: modeFor(manifestSnapshot)
    });
  }
  effects.push({
    operation: 'write',
    logicalName: 'manifest',
    pathParts: ['liftoff.manifest.json'],
    contentDigest: sha256(candidate.content),
    contentBytes: Buffer.byteLength(candidate.content, 'utf8'),
    mode: modeFor(manifestSnapshot)
  });
  const controls = await controlInventory(root, targetProfile);
  snapshots.push(...controls.snapshots);
  const preconditions = uniqueSnapshots(snapshots);
  const transaction = await inspectProfileTransitionTransactionCandidate(
    root,
    mutations,
    preconditions
  );
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + planLifetimeMs).toISOString();
  const unsigned = {
    schemaVersion: 1 as const,
    kind: 'liftoff-profile-transition-plan' as const,
    projectRoot: root,
    source: {
      profile: manifest.governance.profile,
      policyVersion: manifest.governance.profile === 'none'
        ? null
        : manifest.governance.policyVersion,
      activationIdentity: manifest.governance.profile === 'none'
        ? null
        : manifest.governance.activationIdentity,
      manifestDigest: sha256(manifestSnapshot.content!)
    },
    target: {
      profile: candidate.manifest.governance.profile,
      policyVersion: candidate.manifest.governance.profile === 'none'
        ? null
        : candidate.manifest.governance.policyVersion,
      activationIdentity: candidate.manifest.governance.profile === 'none'
        ? null
        : candidate.manifest.governance.activationIdentity,
      manifestDigest: candidate.digest
    },
    controls: {
      ...controls.controls,
      deploymentSafeguards: 'live-settings-untouched' as const,
      proposedWeakening: false as const
    },
    evidenceBoundary: {
      preserved: true as const,
      reusableForTarget: false as const,
      paths: [
        'governance/activation-state.json',
        'governance/evidence/',
        'governance/approvals/',
        'governance/history/'
      ]
    },
    effects: effects.sort((left, right) =>
      left.pathParts.join('/').localeCompare(right.pathParts.join('/'), 'en')
    ),
    execution: {
      transactionCandidateBinding: transaction.binding,
      providerOperations: false as const,
      applicationFiles: 'preserved' as const,
      gitHistory: 'preserved' as const,
      workflow: 'preserved' as const,
      plugins: 'profile-recomposed-only' as const
    },
    createdAt,
    expiresAt
  };
  const plan = Object.freeze({
    ...unsigned,
    fingerprint: canonicalSha256(unsigned)
  });
  return Object.freeze({
    plan,
    mutations: Object.freeze([...mutations]),
    preconditions: Object.freeze(preconditions)
  });
}

function validateStoredPlan(
  value: unknown,
  projectRoot: string,
  now: Date,
  allowExpired = false
): ProfileTransitionPlan {
  jsonValue(value);
  if (!isRecord(value) ||
      value.schemaVersion !== 1 ||
      value.kind !== 'liftoff-profile-transition-plan' ||
      value.projectRoot !== projectRoot ||
      typeof value.fingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(value.fingerprint) ||
      typeof value.expiresAt !== 'string') {
    invalid('Stored profile transition plan is malformed or project-mismatched.');
  }
  const { fingerprint, ...unsigned } = value;
  if (canonicalSha256(unsigned) !== fingerprint) {
    invalid('Stored profile transition plan fingerprint does not match its bytes.');
  }
  if (!allowExpired && Date.parse(value.expiresAt) <= now.getTime()) {
    invalid('Stored profile transition plan has expired.');
  }
  return Object.freeze(value as unknown as ProfileTransitionPlan);
}

export async function prepareProfileTransitionPlan(
  projectRoot: string,
  targetProfile: ProfileTransitionProfile,
  options: {
    readonly now?: Date;
    readonly storage?: UpdatePreviewOptions;
  } = {}
): Promise<{ readonly plan: ProfileTransitionPlan; readonly path: string }> {
  const candidate = await buildCandidate(
    projectRoot,
    targetProfile,
    options.now ?? new Date()
  );
  const stored = await createScopedUserLocalRecordStore(
    candidate.plan.projectRoot,
    'profile-transition-plan',
    options.storage
  ).write(candidate.plan.fingerprint, candidate.plan);
  return Object.freeze({ plan: candidate.plan, path: stored.path });
}

export async function readProfileTransitionPlan(
  projectRoot: string,
  fingerprint: string,
  now: Date,
  storage?: UpdatePreviewOptions,
  allowExpired = false
): Promise<ProfileTransitionPlan> {
  const plan = await findProfileTransitionPlan(
    projectRoot,
    fingerprint,
    now,
    storage,
    allowExpired
  );
  if (!plan) invalid('No matching profile transition plan exists.');
  return plan;
}

export async function findProfileTransitionPlan(
  projectRoot: string,
  fingerprint: string,
  now: Date,
  storage?: UpdatePreviewOptions,
  allowExpired = false
): Promise<ProfileTransitionPlan | null> {
  const root = await realpath(path.resolve(projectRoot));
  const stored = await createScopedUserLocalRecordStore(
    root,
    'profile-transition-plan',
    storage
  ).read(fingerprint);
  if (!stored) return null;
  const plan = validateStoredPlan(
    stored.value,
    stored.projectRoot,
    now,
    allowExpired
  );
  if (plan.fingerprint !== fingerprint) {
    invalid('Profile transition storage key does not match its fingerprint.');
  }
  return plan;
}

export async function rebuildProfileTransitionCandidate(
  plan: ProfileTransitionPlan
): Promise<ProfileTransitionCandidate> {
  const candidate = await buildCandidate(
    plan.projectRoot,
    plan.target.profile,
    new Date(plan.createdAt)
  );
  if (candidate.plan.fingerprint !== plan.fingerprint ||
      canonicalSha256(candidate.plan) !== canonicalSha256(plan)) {
    invalid('Profile transition inputs changed after review.');
  }
  return candidate;
}

export async function assertProfileTransitionPlanCurrent(
  plan: ProfileTransitionPlan
): Promise<void> {
  await rebuildProfileTransitionCandidate(plan);
}

export async function assertProfileTransitionControlsCurrent(
  plan: ProfileTransitionPlan
): Promise<void> {
  const observed = await controlInventory(
    plan.projectRoot,
    plan.target.profile
  );
  const expected = {
    inventoryDigest: plan.controls.inventoryDigest,
    codeowners: plan.controls.codeowners,
    rulesets: plan.controls.rulesets,
    activationState: plan.controls.activationState
  };
  if (canonicalSha256(observed.controls) !== canonicalSha256(expected)) {
    invalid('Governance controls changed after profile-transition review.');
  }
}
