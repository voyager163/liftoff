import { canonicalJson, canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import {
  normalizeRulesetDefinition
} from '../../domain/governance/assessment/live-normalize.js';
import {
  areRulesetsSemanticallyEqual, isDismissalRestrictionNeutral, isExtraApprovalNeutral, isRequiredReviewersNeutral,
  protectedRefs, singleMaintainer, tagControls
} from '../../domain/governance/assessment/predicates.js';
import {
  positiveId,
  githubRepository,
  expectStatus,
  GitHubActivationError,
  object,
  text,
  type GitHubRequest,
  type GitHubResponse,
  type GitHubActivationClient
} from './activation-rest.js';
import { normalizeGitHubRulesetObservation, readGitHubRulesetInventory } from './ruleset-observation.js';
import {
  controlObservationDigest, observeRepositoryControls, observeRepositoryControlBoundary, providerEtag, providerRequestId, repositorySettings,
  repositoryControlLimits, reviewedRepositoryControlSnapshot, RepositoryControlNotDispatched,
  type OwnedRepositorySettings, type ObservedRepositoryRuleset, type RepositoryControlBinding,
  type RepositoryControlObservation, type RepositoryControlSnapshot, type RepositoryRulesetState
} from './repository-control-observation.js';
import type {
  GitHubRulesetAdapter,
  GitHubRulesetWriteResult
} from '../../governance-activation/transition-ports.js';
import type { PublishedWorkflowSourceFile } from './production-workflows.js';
import type { QualificationEvidenceReference } from '../../application/azure-activation/qualification-evidence.js';

export interface DesiredRulesetRule {
  type: string;
  parameters?: Record<string, unknown>;
}

export interface DesiredRulesetDefinition {
  name: string;
  target: 'branch' | 'tag' | 'push';
  enforcement: 'active' | 'disabled' | 'evaluate';
  conditions: {
    ref_name: {
      include: readonly string[];
      exclude: readonly string[];
    };
  };
  bypass_actors: readonly {
    actor_id: number | null;
    actor_type: string;
    bypass_mode: string;
  }[];
  rules: readonly DesiredRulesetRule[];
}

export interface ProductionRulesetAdapterOptions {
  client: GitHubActivationClient;
  desiredRulesets?: readonly DesiredRulesetDefinition[];
  mainHoldActive?: boolean;
  requiredChecks?: readonly string[];
  ownedControls?: readonly { id: number; name: string }[];
  controlExecution?: RepositoryControlExecution;
}

export const canonicalOwnedRulesetNames = [
  'liftoff-gitflow-develop',
  'liftoff-gitflow-main',
  'liftoff-gitflow-releases',
  'liftoff-tags'
] as const;

export const registeredOwnedRulesetNames = [...canonicalOwnedRulesetNames, 'liftoff-tag-creation', 'liftoff-gitflow-hotfixes'] as const;
const requiredOwnedRulesetNames = [...canonicalOwnedRulesetNames, 'liftoff-tag-creation'] as const;

export interface OwnedRepositoryControl {
  id: number;
  nodeId: string;
  name: string;
  ownershipDigest: string;
}

export interface RepositoryRulesetChange {
  kind: 'ruleset';
  name: string;
  mode: 'create' | 'update';
  prior: RepositoryRulesetState | null;
  desired: DesiredRulesetDefinition;
  payload: string;
}

export interface RepositorySettingsChange {
  kind: 'settings';
  name: 'repository-settings';
  mode: 'update';
  prior: { repositoryId: number; nodeId: string; etag: string | null; values: OwnedRepositorySettings };
  desired: OwnedRepositorySettings;
  payload: string;
}

export type RepositoryControlChange = RepositoryRulesetChange | RepositorySettingsChange;

export interface RepositoryControlPlan {
  schemaVersion: 1;
  scope: 'repository' | 'activation';
  baseline: RepositoryControlSnapshot;
  source: {
    sourceSha: string;
    fileInventoryDigest: string;
    evidenceDigest: string;
    qualificationDigest: string;
    publication: { repository: string; repositoryId: number; actorId: number; actorLogin: string; ref: string };
    qualificationActorId: number;
    qualificationReferences?: readonly {
      phaseId: 'green-red-proof' | 'staging-qualified' | 'production-rehearsed';
      reference: QualificationEvidenceReference;
    }[];
    files: readonly PublishedWorkflowSourceFile[];
  };
  desiredRulesets: readonly DesiredRulesetDefinition[];
  desiredSettings: OwnedRepositorySettings;
  sourceDigest: string;
  ownedControls: readonly OwnedRepositoryControl[];
  mainHold: { mode: 'hold' | 'replace' | 'qualified'; priorReceiptDigest: string | null };
  concurrency: 'additive-create-and-independent-readback' | 'authoritative-pre-read-and-independent-readback';
  limits: typeof repositoryControlLimits;
  changes: readonly RepositoryControlChange[];
}

export interface RepositoryControlPrepared {
  sequence: number;
  digest: string;
  planDigest: string;
  approvalEnvelopeId: string;
  approvalEnvelopeHash: string;
  preparedAt: string;
}

export interface RepositoryControlResponse {
  status: number;
  requestId: string | null;
  resource: { id: number; nodeId: string; name: string; sourceType: string; source: string } | null;
  control: ObservedRepositoryRuleset | null;
  repository?: { id: number; nodeId: string; name: string };
}

export interface RepositoryControlCheckpoint {
  prepared: RepositoryControlPrepared;
  changeDigest: string;
  response: RepositoryControlResponse | null;
  settled: {
    outcome: 'verified' | 'mismatched' | 'rejected' | 'not-dispatched';
    observation: RepositoryControlObservation | null;
  } | null;
}

export interface RepositoryControlJournal {
  authorize(change: RepositoryControlChange | null): Promise<void>;
  revalidate(): Promise<void>;
  read(change: RepositoryControlChange): Promise<RepositoryControlCheckpoint | null>;
  prepare(change: RepositoryControlChange, observed: RepositoryControlObservation): Promise<RepositoryControlPrepared>;
  response(change: RepositoryControlChange, prepared: RepositoryControlPrepared, response: RepositoryControlResponse): Promise<void>;
  settle(change: RepositoryControlChange, prepared: RepositoryControlPrepared, outcome: NonNullable<RepositoryControlCheckpoint['settled']>): Promise<void>;
  completed(change: RepositoryControlChange): void;
}

export interface RepositoryControlExecution {
  plan: RepositoryControlPlan;
  approvalEnvelopeId: string;
  journal: RepositoryControlJournal;
  recovery: boolean;
}

export interface RepositoryControlWriteResult extends GitHubRulesetWriteResult {
  ownedControls: readonly OwnedRepositoryControl[];
  controls: readonly ObservedRepositoryRuleset[];
  observation: RepositoryControlObservation;
}

export function validateDesiredRepositoryRulesets(
  values: readonly unknown[], actionsAppId: number
): readonly DesiredRulesetDefinition[] {
  if (values.length < requiredOwnedRulesetNames.length || values.length > registeredOwnedRulesetNames.length) {
    throw new GitHubActivationError('control-source', 'The exact registered branch, separate tag-creation and immutable-tag definitions are required.');
  }
  const definitions = values.map((value) => {
    const input = object(value, 'Reviewed ruleset payload');
    if (Object.keys(input).some((key) => !['name', 'target', 'enforcement', 'conditions', 'bypass_actors', 'rules'].includes(key))) {
      throw new GitHubActivationError('control-source', 'Reviewed ruleset source must contain only exact provider-write fields, never ownership IDs or response metadata.');
    }
    normalizeRulesetDefinition(input);
    if (!Array.isArray(input.rules) || input.rules.some((rule) => Object.keys(object(rule)).some((key) => !['type', 'parameters'].includes(key)))) {
      throw new GitHubActivationError('control-source', 'Reviewed rules cannot contain provider observation IDs or unregistered write fields.');
    }
    if (!registeredOwnedRulesetNames.includes(input.name as typeof registeredOwnedRulesetNames[number])) {
      throw new GitHubActivationError('control-source', 'The ruleset source has no exact registered control identity; name prefixes do not grant ownership.');
    }
    return structuredClone(input) as unknown as DesiredRulesetDefinition;
  });
  if (new Set(definitions.map((entry) => entry.name)).size !== definitions.length ||
    requiredOwnedRulesetNames.some((name) => !definitions.some((entry) => entry.name === name)) ||
    definitions.some((entry) => entry.enforcement !== 'active') ||
    protectedRefs(definitions, 'develop').value !== true || singleMaintainer(definitions).value !== true ||
    tagControls(definitions, positiveId(actionsAppId)).value !== true) {
    throw new GitHubActivationError('control-policy', 'Reviewed controls must preserve non-bypassable GitFlow, zero human reviews and separate Actions-only tag creation/immutable-tag protections.');
  }
  const main = definitions.find((entry) => entry.name === 'liftoff-gitflow-main')!;
  if (canonicalSha256(main.conditions) !== canonicalSha256({ ref_name: { include: ['refs/heads/main'], exclude: [] } }) ||
    main.bypass_actors.length !== 0) {
    throw new GitHubActivationError('main-hold', 'The registered main control must cover only main, with no bypass actors.');
  }
  return definitions.sort((left, right) => left.name.localeCompare(right.name, 'en'));
}

export function buildRepositoryControlPlan(
  input: Omit<RepositoryControlPlan, 'schemaVersion' | 'sourceDigest' | 'changes' | 'concurrency' | 'limits'> &
    { concurrency?: RepositoryControlPlan['concurrency']; changes?: readonly RepositoryControlChange[] }
): RepositoryControlPlan {
  const concurrency = input.concurrency ?? 'authoritative-pre-read-and-independent-readback';
  if (concurrency !== 'additive-create-and-independent-readback' && concurrency !== 'authoritative-pre-read-and-independent-readback') {
    throw new GitHubActivationError('control-plan', 'The reviewed control plan has an unsupported concurrency contract.');
  }
  const baseline = input.changes === undefined ? reviewedRepositoryControlSnapshot(input.baseline) : input.baseline;
  const desiredRulesets = validateDesiredRepositoryRulesets(input.desiredRulesets, baseline.binding.actionsApp.id);
  const desiredSettings = repositorySettings(input.desiredSettings);
  const effectiveSettings = { ...baseline.settings, ...desiredSettings };
  const mainMergeMethods = desiredRulesets.find((entry) => entry.name === 'liftoff-gitflow-main')!
    .rules.find((rule) => rule.type === 'pull_request')?.parameters?.allowed_merge_methods;
  if (effectiveSettings.default_branch !== 'develop' || effectiveSettings.allow_merge_commit !== true ||
    (mainMergeMethods === undefined
      ? effectiveSettings.allow_squash_merge !== false || effectiveSettings.allow_rebase_merge !== false
      : canonicalSha256(mainMergeMethods) !== canonicalSha256(['merge']))) {
    throw new GitHubActivationError('control-policy-settings', 'GitFlow requires develop as the actual default and true merge commits on main. Review exact source/settings changes rather than silently weakening those controls.');
  }
  if (new Set(input.ownedControls.map((entry) => positiveId(entry.id))).size !== input.ownedControls.length ||
    new Set(input.ownedControls.map((entry) => entry.name)).size !== input.ownedControls.length ||
    input.ownedControls.some((entry) => !/^[a-f0-9]{64}$/u.test(entry.ownershipDigest))) {
    throw new GitHubActivationError('control-ownership', 'Control ownership requires unique exact provider IDs and retained private issuance, not names.');
  }
  const changes: RepositoryControlChange[] = [];
  const payloadFor = (name: string, desired: DesiredRulesetDefinition | OwnedRepositorySettings): string => {
    const canonical = canonicalJson(desired);
    // Preserve the original representation of retained plans; new plans bind the
    // exact compact JSON bytes used by the existing GitHub transport.
    return input.changes?.find((change) => change.name === name)?.payload === canonical
      ? canonical : JSON.stringify(JSON.parse(canonical));
  };
  const ownedIds = new Set(input.ownedControls.map((entry) => entry.id));
  const effective = [...desiredRulesets, ...baseline.rulesets.filter((entry) => !ownedIds.has(Number(entry.definition.id))).map((entry) => entry.definition)];
  if (singleMaintainer(effective).value !== true || protectedRefs(effective, 'develop').value !== true) {
    throw new GitHubActivationError('foreign-control-conflict', 'An observed foreign or inherited protection conflicts with the fixed GitFlow/review policy. Preserve it for separate owner review; do not strip meaningful restrictions or silently claim complete enforcement.');
  }
  for (const desired of desiredRulesets) {
    const owned = input.ownedControls.find((entry) => entry.name === desired.name);
    const prior = owned ? baseline.rulesets.find((entry) => entry.definition.id === owned.id) : undefined;
    if (owned && (!prior || prior.definition.node_id !== owned.nodeId || prior.definition.name !== owned.name ||
      prior.definition.source_type !== 'Repository' || !repositorySource(prior.definition.source, baseline.binding.repository))) {
      throw new GitHubActivationError('control-ownership', 'A previously owned provider identity changed; foreign and changed protections were preserved.');
    }
    if (baseline.rulesets.some((entry) => entry.definition.name === desired.name && entry.definition.id !== owned?.id)) {
      throw new GitHubActivationError('foreign-control', 'A same-named foreign ruleset was observed. Names never establish ownership or authorize replacement.');
    }
    if (prior && rulesetMatchesDesired(prior.definition, desired) &&
      productionRulesetSourceDigest([prior.definition]) === productionRulesetSourceDigest([desired])) continue;
    changes.push({ kind: 'ruleset', name: desired.name, mode: prior ? 'update' : 'create', prior: prior ?? null, desired, payload: payloadFor(desired.name, desired) });
  }
  const settingsPatch = Object.fromEntries(Object.entries(desiredSettings).filter(([name, value]) =>
    baseline.settings[name] !== value));
  if (Object.keys(settingsPatch).some((name) => name === 'default_branch'
    ? typeof baseline.settings[name] !== 'string'
    : typeof baseline.settings[name] !== 'boolean')) {
    throw new GitHubActivationError('settings-observation', 'Every selected settings write requires an authoritative current prior value; absence is not an implied default.');
  }
  if (Object.keys(settingsPatch).length) changes.push({
    kind: 'settings', name: 'repository-settings', mode: 'update',
    prior: {
      repositoryId: baseline.binding.repositoryId, nodeId: baseline.binding.repositoryNodeId,
      etag: baseline.settingsEtag,
      values: Object.fromEntries(Object.keys(settingsPatch).map((name) => [name, baseline.settings[name]]))
    },
    desired: settingsPatch, payload: payloadFor('repository-settings', settingsPatch)
  });
  const main = desiredRulesets.find((entry) => entry.name === 'liftoff-gitflow-main')!;
  const holdsMain = main.rules.some((rule) => rule.type === 'update' &&
    (rule.parameters === undefined || rule.parameters.update_allows_fetch_and_merge === false));
  if (holdsMain !== (input.mainHold.mode === 'hold') ||
    input.scope === 'repository' && input.mainHold.mode !== 'hold' ||
    input.mainHold.mode === 'replace' && input.mainHold.priorReceiptDigest === null) {
    throw new GitHubActivationError('main-hold', 'The approved main-hold mode does not match its exact control definition and prior verified hold.');
  }
  changes.sort((left, right) => {
    const rank = (entry: RepositoryControlChange) => entry.name === 'liftoff-gitflow-main'
      ? input.mainHold.mode === 'hold' ? -1 : 2 : entry.kind === 'settings' ? 1 : 0;
    return rank(left) - rank(right) || left.name.localeCompare(right.name, 'en');
  });
  return {
    ...structuredClone(input), baseline: structuredClone(baseline), schemaVersion: 1, desiredRulesets, desiredSettings,
    sourceDigest: productionRulesetSourceDigest(desiredRulesets),
    concurrency, limits: repositoryControlLimits, changes
  };
}

// Preconditions are checked under the cooperating lease immediately before each
// documented write, then independently read back. This does not serialize other
// GitHub UI/API writers. ETags are observations, never an undocumented If-Match.
// https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests
export function repositoryControlMutationBlockers(plan: RepositoryControlPlan): readonly string[] {
  if (plan.concurrency !== 'additive-create-and-independent-readback' ||
    !plan.changes.some((change) => change.mode === 'update')) return [];
  return [
    'A retained create-only plan cannot authorize replacement or settings writes. Review a new exact owned-control plan; existing approvals and checkpoints are never broadened.'
  ];
}

/**
 * Builds canonical single-maintainer GitFlow ruleset definitions.
 *
 * Invariants:
 * - develop, main, release/**, hotfix/** are protected.
 * - 0 required human reviewers, code owners disabled, last push approval disabled, stale reviews dismissed.
 * - deletion and non-fast-forward prohibited.
 * - Strict required status checks enabled, do_not_enforce_on_create = true.
 * - No branch/immutable-tag bypass; a resolved Actions app may bypass tag creation only.
 * - Tags: update and deletion prohibited.
 * - When mainHoldActive is true: main ruleset blocks unapproved production updates.
 */
export function buildCanonicalGitFlowRulesets(options: {
  requiredChecks?: readonly string[];
  mainHoldActive?: boolean;
  actionsAppId?: number;
} = {}): readonly DesiredRulesetDefinition[] {
  const checks = (options.requiredChecks && options.requiredChecks.length > 0)
    ? options.requiredChecks.map((context) => ({ context, integration_id: null }))
    : [{ context: 'verify-source', integration_id: null }];

  const singleMaintainerPullRequestRule: DesiredRulesetRule = {
    type: 'pull_request',
    parameters: {
      required_approving_review_count: 0,
      dismiss_stale_reviews_on_push: true,
      require_code_owner_review: false,
      require_last_push_approval: false,
      required_review_thread_resolution: false
    }
  };

  const statusChecksRule: DesiredRulesetRule = {
    type: 'required_status_checks',
    parameters: {
      strict_required_status_checks_policy: true,
      do_not_enforce_on_create: true,
      required_status_checks: checks
    }
  };

  const developRuleset: DesiredRulesetDefinition = {
    name: 'liftoff-gitflow-develop',
    target: 'branch',
    enforcement: 'active',
    conditions: {
      ref_name: {
        include: ['refs/heads/develop'],
        exclude: []
      }
    },
    bypass_actors: [],
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      singleMaintainerPullRequestRule,
      statusChecksRule
    ]
  };

  const mainRules: DesiredRulesetRule[] = [
    { type: 'deletion' },
    { type: 'non_fast_forward' },
    { ...singleMaintainerPullRequestRule, parameters: { ...singleMaintainerPullRequestRule.parameters, allowed_merge_methods: ['merge'] } },
    statusChecksRule
  ];

  if (options.mainHoldActive) {
    mainRules.push({ type: 'update', parameters: { update_allows_fetch_and_merge: false } });
  }

  const mainRuleset: DesiredRulesetDefinition = {
    name: 'liftoff-gitflow-main',
    target: 'branch',
    enforcement: 'active',
    conditions: {
      ref_name: {
        include: ['refs/heads/main'],
        exclude: []
      }
    },
    bypass_actors: [],
    rules: mainRules
  };

  const releaseRuleset: DesiredRulesetDefinition = {
    name: 'liftoff-gitflow-releases',
    target: 'branch',
    enforcement: 'active',
    conditions: {
      ref_name: {
        include: ['refs/heads/hotfix/**', 'refs/heads/release/**'],
        exclude: []
      }
    },
    bypass_actors: [],
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      singleMaintainerPullRequestRule,
      statusChecksRule
    ]
  };

  const tagsRuleset: DesiredRulesetDefinition = {
    name: 'liftoff-tags',
    target: 'tag',
    enforcement: 'active',
    conditions: {
      ref_name: {
        include: ['refs/tags/v*'],
        exclude: []
      }
    },
    bypass_actors: [],
    rules: [
      { type: 'update' },
      { type: 'deletion' },
      { type: 'non_fast_forward' }
    ]
  };

  const definitions = [developRuleset, mainRuleset, releaseRuleset, tagsRuleset];
  if (options.actionsAppId !== undefined) definitions.push({
    name: 'liftoff-tag-creation', target: 'tag', enforcement: 'active',
    conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
    bypass_actors: [{ actor_id: positiveId(options.actionsAppId), actor_type: 'Integration', bypass_mode: 'always' }],
    rules: [{ type: 'creation' }]
  });
  return definitions;
}

function rulesetMatchesDesired(
  live: Record<string, unknown>,
  desired: DesiredRulesetDefinition
): boolean {
  return areRulesetsSemanticallyEqual(desired, live);
}

function repositorySource(value: unknown, repository: string): boolean {
  return typeof value === 'string' && value.toLowerCase() === repository.toLowerCase();
}

function effectiveRuleset(value: unknown): Record<string, unknown> {
  const normalized = normalizeRulesetDefinition(value) as Record<string, unknown>;
  const rules = (normalized.rules as Array<Record<string, unknown>>).map((rule) => {
    if (rule.type !== 'pull_request') return rule;
    const parameters = { ...(rule.parameters as Record<string, unknown>) };
    if (isDismissalRestrictionNeutral(parameters.dismissal_restriction)) delete parameters.dismissal_restriction;
    if (isRequiredReviewersNeutral(parameters.required_reviewers)) delete parameters.required_reviewers;
    if (isExtraApprovalNeutral(parameters.require_extra_approval_for_unattributed_changes,
      Number(parameters.required_approving_review_count))) delete parameters.require_extra_approval_for_unattributed_changes;
    return { ...rule, parameters };
  }).sort((left, right) => canonicalSha256(left).localeCompare(canonicalSha256(right), 'en'));
  return {
    name: normalized.name, target: normalized.target, enforcement: normalized.enforcement,
    conditions: normalized.conditions, bypass_actors: normalized.bypass_actors, rules
  };
}

export function productionRulesetSourceDigest(rulesets: readonly unknown[]): string {
  return canonicalSha256({
    schemaVersion: 1, normalization: 'supported-effective-review-policy',
    rulesets: rulesets.map(effectiveRuleset).sort((left, right) => String(left.name).localeCompare(String(right.name), 'en'))
  });
}

export class ProductionGitHubRulesetAdapter implements GitHubRulesetAdapter {
  private readonly client: GitHubActivationClient;
  private readonly desiredRulesets: readonly DesiredRulesetDefinition[];
  private readonly ownedControls: readonly { id: number; name: string }[];
  private readonly controlExecution?: RepositoryControlExecution;

  constructor(options: ProductionRulesetAdapterOptions) {
    this.client = options.client;
    this.desiredRulesets = options.desiredRulesets ?? buildCanonicalGitFlowRulesets({
      requiredChecks: options.requiredChecks,
      mainHoldActive: options.mainHoldActive
    });
    this.ownedControls = options.ownedControls ?? [];
    this.controlExecution = options.controlExecution;
    if (new Set(this.ownedControls.map((entry) => positiveId(entry.id))).size !== this.ownedControls.length ||
      new Set(this.ownedControls.map((entry) => entry.name)).size !== this.ownedControls.length) {
      throw new Error('Owned control inventory must contain unique exact provider IDs and registered names.');
    }
  }

  async readRuleset(input: {
    repository: string;
    sourceDigest: string;
  }): Promise<GitHubRulesetWriteResult> {
    const repository = githubRepository(input.repository);
    const { sourceDigest } = input;
    if (sourceDigest !== productionRulesetSourceDigest(this.desiredRulesets) ||
      this.ownedControls.length !== this.desiredRulesets.length) {
      throw new Error('Independent readback requires the exact reviewed owned-ID inventory and semantic source digest.');
    }
    const observations = await readGitHubRulesetInventory(this.client, repository);
    const ownedLive = this.desiredRulesets.map((desired) => {
      const owned = this.ownedControls.find((entry) => entry.name === desired.name);
      const observation = owned && observations.find((entry) => entry.definition.id === owned.id);
      const live = observation?.definition;
      if (!live || live.name !== desired.name || live.source_type !== 'Repository' ||
        typeof live.source !== 'string' || live.source.toLowerCase() !== repository.toLowerCase() ||
        !rulesetMatchesDesired(live, desired)) {
        throw new Error('Current exact owned-control readback differs from the reviewed target; foreign and changed protections were preserved.');
      }
      if (desired.bypass_actors.length === 0 && observation?.metadata.currentUserCanBypass !== undefined &&
        observation.metadata.currentUserCanBypass !== 'never') {
        throw new Error('The provider reports an actor bypass capability for a zero-bypass control; complete enforcement readback is blocked.');
      }
      return live;
    });
    const readbackDigest = productionRulesetSourceDigest(ownedLive);
    if (readbackDigest !== sourceDigest) {
      throw new Error('Independent ruleset readback digest differs from the exact reviewed source; semantic helper equality alone is not proof.');
    }
    return {
      resourceId: `/repos/${repository}/rulesets`,
      sourceDigest,
      readbackDigest,
      observationDigest: canonicalSha256(observations),
      ownedControls: this.ownedControls
    };
  }

  async applyRuleset(input: {
    repository: string;
    sourceDigest: string;
    approvalEnvelopeId: string;
  }): Promise<GitHubRulesetWriteResult> {
    const execution = this.controlExecution;
    if (!execution || input.approvalEnvelopeId !== execution.approvalEnvelopeId ||
      input.repository !== execution.plan.baseline.binding.repository || input.sourceDigest !== execution.plan.sourceDigest ||
      canonicalSha256(this.desiredRulesets) !== canonicalSha256(execution.plan.desiredRulesets)) {
      throw new GitHubActivationError('control-authority', 'An exact owned-ID/control-payload plan and released pre-effect checkpoint authority are required; no ruleset was changed.');
    }
    return executeOwnedRepositoryControls(this.client, execution);
  }

}

function assertSameBinding(observed: RepositoryControlSnapshot, plan: RepositoryControlPlan): void {
  if (canonicalSha256(observed.binding) !== canonicalSha256(plan.baseline.binding) ||
    observed.mainSha !== plan.baseline.mainSha || observed.developSha !== plan.baseline.developSha) {
    throw new GitHubActivationError('control-drift', 'The repository, authenticated actor, Actions integration or reviewed main/develop tip changed; no further control write is authorized.');
  }
}

function withoutRequestIds(controls: readonly RepositoryRulesetState[]) {
  return controls.map(({ definition, metadata, etag }) => ({ definition, metadata, etag }))
    .sort((left, right) => positiveId(left.definition.id) - positiveId(right.definition.id));
}

function assertPreserved(
  current: RepositoryControlSnapshot, expected: RepositoryControlSnapshot, changed?: RepositoryControlChange,
  changedId?: number
): void {
  const preserved = (controls: readonly RepositoryRulesetState[]) => withoutRequestIds(
    controls.filter((entry) => changed?.kind !== 'ruleset' || entry.definition.id !== changedId)
  );
  const settings = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([name]) =>
    changed?.kind !== 'settings' || !Object.hasOwn(changed.desired, name)));
  if (canonicalSha256(preserved(current.rulesets)) !== canonicalSha256(preserved(expected.rulesets)) ||
    canonicalSha256(settings(current.settings)) !== canonicalSha256(settings(expected.settings)) ||
    !changed && (current.settingsEtag !== expected.settingsEtag || current.collectionEtag !== expected.collectionEtag)) {
    throw new GitHubActivationError('control-drift', 'Current prior controls/settings differ from the exact reviewed or attributable checkpoint state. Foreign controls were preserved; automatic retry or rollback is forbidden.');
  }

}

export function assertRepositoryControlObservationUnchanged(
  current: RepositoryControlObservation, expected: RepositoryControlObservation
): void {
  if (canonicalSha256(current.binding) !== canonicalSha256(expected.binding) ||
    current.mainSha !== expected.mainSha || current.developSha !== expected.developSha) {
    throw new GitHubActivationError('control-drift', 'Current repository/actor or permanent-branch baseline differs from the approved enforcement readback.');
  }
  const effective = (observation: RepositoryControlObservation) => observation.rulesets.map((entry) => ({
    id: entry.definition.id, nodeId: entry.definition.node_id, sourceType: entry.definition.source_type,
    source: typeof entry.definition.source === 'string' ? entry.definition.source.toLowerCase() : null,
    definitionDigest: productionRulesetSourceDigest([entry.definition]),
    actorBypass: entry.metadata.currentUserCanBypass ?? 'never'
  })).sort((left, right) => positiveId(left.id) - positiveId(right.id));
  if (canonicalSha256(current.settings) !== canonicalSha256(expected.settings) ||
    canonicalSha256(effective(current)) !== canonicalSha256(effective(expected))) {
    throw new GitHubActivationError('control-drift', 'Current meaningful control definitions, provider IDs or preserved settings differ from the approved enforcement readback.');
  }
}

function verifiedOwnedControls(
  observed: RepositoryControlObservation, plan: RepositoryControlPlan, owned: readonly OwnedRepositoryControl[]
): readonly ObservedRepositoryRuleset[] {
  if (owned.length !== plan.desiredRulesets.length || new Set(owned.map((entry) => entry.id)).size !== owned.length) {
    throw new GitHubActivationError('control-ownership', 'Independent readback requires the complete private provider-issued owned-ID inventory.');
  }
  return plan.desiredRulesets.map((desired) => {
    const identity = owned.find((entry) => entry.name === desired.name);
    const live = identity && observed.rulesets.find((entry) => entry.definition.id === identity.id);
    if (!live || live.definition.node_id !== identity!.nodeId || live.definition.name !== desired.name ||
      live.definition.source_type !== 'Repository' || !repositorySource(live.definition.source, observed.binding.repository) ||
      !rulesetMatchesDesired(live.definition, desired) ||
      productionRulesetSourceDigest([live.definition]) !== productionRulesetSourceDigest([desired]) ||
      desired.bypass_actors.length === 0 && live.metadata.currentUserCanBypass !== undefined && live.metadata.currentUserCanBypass !== 'never') {
      throw new GitHubActivationError('control-readback', 'Independent exact owned-ID readback does not match the approved control definition; no protection was removed.');
    }
    return live;
  });
}

export async function readOwnedRepositoryControls(
  client: GitHubActivationClient, plan: RepositoryControlPlan, owned: readonly OwnedRepositoryControl[]
): Promise<RepositoryControlWriteResult> {
  const observation = await observeRepositoryControls(client, plan.baseline.binding.repository, plan.baseline.binding.repositoryId);
  assertSameBinding(observation, plan);
  const controls = verifiedOwnedControls(observation, plan, owned);
  if (singleMaintainer(observation.rulesets.map((entry) => entry.definition)).value !== true ||
    protectedRefs(observation.rulesets.map((entry) => entry.definition), 'develop').value !== true) {
    throw new GitHubActivationError('foreign-control-conflict', 'Current inherited/foreign protections conflict with the reviewed policy; owned matching rules alone do not prove effective enforcement.');
  }
  if (Object.entries(plan.desiredSettings).some(([name, value]) => observation.settings[name] !== value)) {
    throw new GitHubActivationError('settings-readback', 'Independent owned-setting readback differs from the exact approved values.');
  }
  const readbackDigest = productionRulesetSourceDigest(controls.map((entry) => entry.definition));
  if (readbackDigest !== plan.sourceDigest) throw new GitHubActivationError('control-readback', 'Independent control source/readback digests differ.');
  return {
    resourceId: `/repos/${observation.binding.repository}/rulesets`, sourceDigest: plan.sourceDigest, readbackDigest,
    observationDigest: controlObservationDigest(observation), ownedControls: owned, controls, observation
  };
}

function responseControl(response: GitHubResponse, change: RepositoryControlChange, binding: RepositoryControlBinding): ObservedRepositoryRuleset | null {
  if (change.kind === 'settings' || ![200, 201].includes(response.status)) return null;
  const observed = normalizeGitHubRulesetObservation(response.data);
  const definition = observed.definition;
  positiveId(definition.id);
  text(definition.node_id, 'Ruleset node ID');
  if (definition.source_type !== 'Repository' || !repositorySource(definition.source, binding.repository) ||
    definition.name !== change.name || change.prior &&
      (definition.id !== change.prior.definition.id || definition.node_id !== change.prior.definition.node_id)) {
    throw new GitHubActivationError('control-response', 'The provider returned a different ruleset identity; retain the pre-effect checkpoint without adopting it by name.');
  }
  return { ...observed, etag: providerEtag(response), requestId: providerRequestId(response) };
}

function writeConfirmed(change: RepositoryControlChange, status: number): boolean {
  return status === (change.kind === 'ruleset' && change.mode === 'create' ? 201 : 200);
}

export function repositoryControlWriteRequest(repository: string, change: RepositoryControlChange): GitHubRequest {
  const target = githubRepository(repository);
  const canonical = canonicalJson(change.desired);
  if (change.payload !== canonical && change.payload !== JSON.stringify(JSON.parse(canonical))) {
    throw new GitHubActivationError('control-plan', 'The provider payload differs from the exact reviewed desired bytes.');
  }
  return change.kind === 'settings'
    ? { method: 'PATCH', path: `/repos/${target}`, body: JSON.parse(change.payload) }
    : change.mode === 'create'
      ? { method: 'POST', path: `/repos/${target}/rulesets`, body: JSON.parse(change.payload) }
      : { method: 'PUT', path: `/repos/${target}/rulesets/${positiveId(change.prior?.definition.id)}`, body: JSON.parse(change.payload) };
}

export function observeRepositoryControlWriteResponse(
  binding: RepositoryControlBinding, change: RepositoryControlChange, response: GitHubResponse
): { kind: 'response'; record: RepositoryControlResponse } |
  { kind: 'invalid-response'; record: RepositoryControlResponse; error: unknown } {
  const record: RepositoryControlResponse = { status: response.status, requestId: null, resource: null, control: null };
  try {
    record.requestId = providerRequestId(response);
    if (change.kind === 'ruleset' && [200, 201].includes(response.status)) {
      const data = object(response.data);
      record.resource = {
        id: positiveId(data.id), nodeId: text(data.node_id, 'Ruleset node ID'), name: text(data.name, 'Ruleset name'),
        sourceType: text(data.source_type, 'Ruleset source type'), source: text(data.source, 'Ruleset source')
      };
    } else if (change.kind === 'settings' && response.status === 200) {
      const data = object(response.data);
      record.repository = {
        id: positiveId(data.id), nodeId: text(data.node_id, 'Repository node ID'), name: githubRepository(data.full_name)
      };
      if (record.repository.id !== binding.repositoryId || record.repository.nodeId !== binding.repositoryNodeId ||
        record.repository.name !== binding.repository) {
        throw new GitHubActivationError('settings-response', 'The settings response identifies a different repository; preserve the actual response and do not infer successful owned reconciliation.');
      }
    }
    record.control = responseControl(response, change, binding);
    return { kind: 'response', record };
  } catch (error) {
    return { kind: 'invalid-response', record, error };
  }
}

async function assertCurrentEffectTarget(
  client: GitHubActivationClient, plan: RepositoryControlPlan, change: RepositoryControlChange,
  expected: RepositoryControlSnapshot
): Promise<void> {
  const repository = plan.baseline.binding.repository;
  const boundary = await observeRepositoryControlBoundary(client, repository, plan.baseline.binding.repositoryId);
  assertSameBinding({ ...expected, ...boundary }, plan);
  if (canonicalSha256(boundary.settings) !== canonicalSha256(expected.settings) || boundary.settingsEtag !== expected.settingsEtag) {
    throw new GitHubActivationError('control-drift', 'Repository settings changed immediately before the approved effect; the newer observed values were preserved.');
  }
  if (change.kind === 'ruleset' && change.mode === 'update') {
    const id = positiveId(change.prior?.definition.id);
    const response = expectStatus(await client.transport.request({ method: 'GET', path: `/repos/${repository}/rulesets/${id}` }), [200], 'Re-read exact owned ruleset before replacement');
    const current = { ...normalizeGitHubRulesetObservation(response.data), etag: providerEtag(response) };
    const prior = expected.rulesets.find((entry) => entry.definition.id === id);
    if (!prior || canonicalSha256(current) !== canonicalSha256(withoutRequestIds([prior])[0])) {
      throw new GitHubActivationError('control-drift', 'The exact owned ruleset changed immediately before replacement; newer observed protection was preserved.');
    }
  } else if (change.kind === 'settings') {
    const fresh = await observeRepositoryControlBoundary(client, repository, plan.baseline.binding.repositoryId);
    assertSameBinding({ ...expected, ...fresh }, plan);
    if (canonicalSha256(fresh.settings) !== canonicalSha256(expected.settings) || fresh.settingsEtag !== expected.settingsEtag) {
      throw new GitHubActivationError('control-drift', 'The exact repository settings changed at the final pre-effect boundary; no PATCH was sent.');
    }
  } else {
    const summaries = await client.list(`/repos/${repository}/rulesets?includes_parents=true`);
    const identities = summaries.map((entry) => ({ id: positiveId(entry.id), name: text(entry.name, 'Ruleset name') })).sort((a, b) => a.id - b.id);
    const prior = expected.rulesets.map((entry) => ({ id: positiveId(entry.definition.id), name: text(entry.definition.name, 'Ruleset name') })).sort((a, b) => a.id - b.id);
    if (canonicalSha256(identities) !== canonicalSha256(prior)) {
      throw new GitHubActivationError('control-drift', 'The complete ruleset identity inventory changed immediately before creation; no foreign control was adopted or replaced.');
    }
  }
}

async function executeOwnedRepositoryControls(
  client: GitHubActivationClient, execution: RepositoryControlExecution
): Promise<RepositoryControlWriteResult> {
  const { plan, journal } = execution;
  const rebuilt = buildRepositoryControlPlan(plan);
  if (canonicalSha256(rebuilt) !== canonicalSha256(plan)) {
    throw new GitHubActivationError('control-plan', 'The reviewed exact control payload or ordered operation inventory changed.');
  }
  await journal.authorize(null);
  const mutationBlockers = repositoryControlMutationBlockers(plan);
  if (mutationBlockers.length) throw new GitHubActivationError('control-plan', mutationBlockers.join(' '));
  let expected = plan.baseline;
  const owned = new Map(plan.ownedControls.map((entry) => [entry.name, entry]));
  const checkpoints = new Map<RepositoryControlChange, RepositoryControlCheckpoint | null>();
  for (const change of plan.changes) {
    const checkpoint = await journal.read(change);
    if (checkpoint && checkpoint.changeDigest !== canonicalSha256(change)) {
      throw new GitHubActivationError('control-recovery', 'An earlier control attempt has a different exact desired/prior definition; a new plan cannot erase an unresolved attempt.');
    }
    checkpoints.set(change, checkpoint);
    if (checkpoint?.settled?.outcome === 'verified') {
      if (!checkpoint.settled.observation) throw new GitHubActivationError('control-checkpoint', 'Verified control checkpoint has no independent observation.');
      expected = checkpoint.settled.observation;
      const resource = checkpoint.response?.resource;
      if (change.kind === 'ruleset' && resource) owned.set(change.name, {
        id: positiveId(resource.id), nodeId: text(resource.nodeId, 'Ruleset node ID'),
        name: change.name, ownershipDigest: change.mode === 'update'
          ? owned.get(change.name)!.ownershipDigest : checkpoint.prepared.digest
      });
    }
  }
  let observed = await observeRepositoryControls(client, plan.baseline.binding.repository, plan.baseline.binding.repositoryId);
  for (const change of plan.changes) {
    const checkpoint = checkpoints.get(change);
    if (!checkpoint || checkpoint.settled) continue;
    const resource = checkpoint.response?.resource;
    if (!checkpoint.response || !writeConfirmed(change, checkpoint.response.status) ||
      change.kind === 'ruleset' && (!resource || resource.name !== change.name ||
        resource.sourceType !== 'Repository' || !repositorySource(resource.source, plan.baseline.binding.repository) ||
        (change.mode === 'create' ? plan.baseline.rulesets.some((entry) => entry.definition.id === resource.id) :
          resource.id !== change.prior?.definition.id || resource.nodeId !== change.prior.definition.node_id)) ||
      change.kind === 'settings' && (!checkpoint.response.repository ||
        checkpoint.response.repository.id !== plan.baseline.binding.repositoryId ||
        checkpoint.response.repository.nodeId !== plan.baseline.binding.repositoryNodeId ||
        checkpoint.response.repository.name !== plan.baseline.binding.repository)) {
      throw new GitHubActivationError('control-outcome-unknown', 'A control write has an unknown outcome or no retained provider identity. Read-only attributable recovery is required; neither retry nor rollback is authorized.');
    }
    const id = resource ? positiveId(resource.id) : undefined;
    try {
      assertSameBinding(observed, plan);
      assertPreserved(observed, expected, change, id);
      if (change.kind === 'ruleset') {
        const entry: OwnedRepositoryControl = {
          id: id!, nodeId: text(resource!.nodeId, 'Ruleset node ID'), name: change.name,
          ownershipDigest: change.mode === 'update' ? owned.get(change.name)!.ownershipDigest : checkpoint.prepared.digest
        };
        verifiedOwnedControls(observed, { ...plan, desiredRulesets: [change.desired] }, [entry]);
        owned.set(change.name, entry);
      } else if (Object.entries(change.desired).some(([name, value]) => observed.settings[name] !== value)) {
        throw new GitHubActivationError('control-recovery', 'The known settings response did not independently match; only separately reviewed current-state recovery can change it.');
      }
    } catch (error) {
      await journal.settle(change, checkpoint.prepared, { outcome: 'mismatched', observation: observed });
      throw error;
    }
    await journal.settle(change, checkpoint.prepared, { outcome: 'verified', observation: observed });
    expected = observed;
    journal.completed(change);
  }
  assertSameBinding(observed, plan);
  assertPreserved(observed, expected);
  const earlierAttempts = [...checkpoints.values()].filter((entry): entry is RepositoryControlCheckpoint => entry !== null);
  let lastWriteAt = -Infinity;
  for (const change of plan.changes) {
    const checkpoint = checkpoints.get(change);
    if (checkpoint?.settled?.outcome === 'verified' || checkpoint && !checkpoint.settled) {
      journal.completed(change);
      continue;
    }
    if (checkpoint && (!execution.recovery || checkpoint.prepared.approvalEnvelopeId === execution.approvalEnvelopeId)) {
      throw new GitHubActivationError('control-recovery', 'A rejected or undispatched control attempt requires a fresh separately approved recovery; the earlier approval cannot retry it.');
    }
    if (earlierAttempts.length && (!execution.recovery ||
      earlierAttempts.some((entry) => entry.prepared.approvalEnvelopeId === execution.approvalEnvelopeId))) {
      throw new GitHubActivationError('control-recovery', 'Attributable partial controls were independently observed. Continuing unfinished effects requires a fresh separately approved recovery plan.');
    }
    const pause = 1000 - (performance.now() - lastWriteAt);
    if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
    await journal.authorize(change);
    await journal.revalidate();
    observed = await observeRepositoryControls(client, plan.baseline.binding.repository, plan.baseline.binding.repositoryId);
    assertSameBinding(observed, plan);
    assertPreserved(observed, expected);
    const prepared = await journal.prepare(change, observed);
    try {
      await journal.authorize(change);
      const immediatelyBefore = await observeRepositoryControls(client, plan.baseline.binding.repository, plan.baseline.binding.repositoryId);
      assertSameBinding(immediatelyBefore, plan);
      assertPreserved(immediatelyBefore, observed);
      await assertCurrentEffectTarget(client, plan, change, immediatelyBefore);
      await journal.authorize(change);
    } catch (error) {
      await journal.settle(change, prepared, { outcome: 'not-dispatched', observation: null });
      throw error;
    }
    const repository = plan.baseline.binding.repository;
    const request = repositoryControlWriteRequest(repository, change);
    lastWriteAt = performance.now();
    let response: GitHubResponse;
    try { response = await client.transport.request(request); }
    catch (error) {
      if (error instanceof RepositoryControlNotDispatched) {
        await journal.settle(change, prepared, { outcome: 'not-dispatched', observation: null });
      }
      throw error;
    }
    const submission = observeRepositoryControlWriteResponse(plan.baseline.binding, change, response);
    const providerResponse = submission.record;
    await journal.response(change, prepared, providerResponse);
    if (writeConfirmed(change, response.status)) journal.completed(change);
    if (submission.kind === 'invalid-response') throw submission.error;
    if (!writeConfirmed(change, response.status)) {
      if ([400, 401, 403, 404, 409, 412, 422].includes(response.status) && providerResponse.requestId) {
        await journal.settle(change, prepared, { outcome: 'rejected', observation: null });
      }
      throw new GitHubActivationError('control-provider', `GitHub did not confirm the exact control write (HTTP ${response.status}); protection and private recovery records were retained.`, response.status);
    }
    if (!providerResponse.requestId) throw new GitHubActivationError('control-response', 'The control response omitted its provider request ID; retain the unknown-outcome checkpoint without retry.');
    const after = await observeRepositoryControls(client, repository, plan.baseline.binding.repositoryId);
    const control = providerResponse.control;
    const id = control ? positiveId(control.definition.id) : undefined;
    if (change.kind === 'ruleset' && change.mode === 'create' && observed.rulesets.some((entry) => entry.definition.id === id)) {
      throw new GitHubActivationError('control-response', 'Ruleset creation returned an existing provider identity; it cannot acquire ownership or authorize replacement.');
    }
    try {
      assertSameBinding(after, plan);
      assertPreserved(after, observed, change, id);
      if (change.kind === 'ruleset') {
        const identity: OwnedRepositoryControl = {
          id: id!, nodeId: text(control!.definition.node_id, 'Ruleset node ID'), name: change.name,
          ownershipDigest: change.mode === 'update' ? owned.get(change.name)!.ownershipDigest : prepared.digest
        };
        verifiedOwnedControls(after, { ...plan, desiredRulesets: [change.desired] }, [identity]);
        owned.set(change.name, identity);
      } else if (Object.entries(change.desired).some(([name, value]) => after.settings[name] !== value)) {
        throw new GitHubActivationError('settings-readback', 'GitHub accepted settings but independent readback differs; no automatic retry or rollback is authorized.');
      }
    } catch (error) {
      await journal.settle(change, prepared, { outcome: 'mismatched', observation: after });
      throw error;
    }
    await journal.settle(change, prepared, { outcome: 'verified', observation: after });
    expected = after;
  }
  await journal.authorize(null);
  await journal.revalidate();
  const result = await readOwnedRepositoryControls(client, plan, [...owned.values()].sort((a, b) => a.name.localeCompare(b.name, 'en')));
  assertPreserved(result.observation, expected);
  return result;
}
