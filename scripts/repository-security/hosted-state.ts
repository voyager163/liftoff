import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { canonicalDigest } from './admission.ts';
import { parseActionReference } from './actions.ts';
import {
  validateActionsPayload, validateImmutableReleaseEnablement
} from './hosted-settings-schema.ts';

export const HOSTED_STATE_LIMITS = Object.freeze({
  responseBytes: 64 * 1024, processOutputBytes: 80 * 1024, previewBytes: 256 * 1024,
  timeoutMs: 10_000, references: 100
});
export const HOSTED_READ_ENDPOINTS = Object.freeze({
  execution: '/repos/voyager163/liftoff/actions/permissions',
  allowlist: '/repos/voyager163/liftoff/actions/permissions/selected-actions',
  workflow: '/repos/voyager163/liftoff/actions/permissions/workflow',
  immutable: '/repos/voyager163/liftoff/immutable-releases',
  forkApproval: '/repos/voyager163/liftoff/actions/permissions/fork-pr-contributor-approval'
} as const);
export type HostedReadEndpoint = typeof HOSTED_READ_ENDPOINTS[keyof typeof HOSTED_READ_ENDPOINTS];
type Surface = keyof typeof HOSTED_READ_ENDPOINTS;
type ReadError = 'transport-error' | 'timeout' | 'output-limit' | 'invalid-response';
export type HostedGetResult =
  | { kind: 'response'; status: number; body: string }
  | { kind: 'error'; reason: ReadError };
export interface ReadonlyHostedTransport {
  get(endpoint: HostedReadEndpoint): Promise<HostedGetResult>;
}
type SettingValue = Record<string, boolean | string | string[]>;
type Observation = {
  availability: 'available' | 'unknown' | 'unavailable';
  httpStatus: number | null;
  reason: string | null;
  value: SettingValue | null;
};
type Proposal = ReturnType<typeof validateActionsPayload> | ReturnType<typeof validateImmutableReleaseEnablement>;
export interface HostedSettingPreview {
  endpoint: HostedReadEndpoint;
  availability: Observation['availability'];
  status: 'available' | 'configured' | 'pending' | 'unknown' | 'unavailable';
  intent: 'proposal-data-only' | 'preserve-observe-only';
  observations: [Observation, Observation];
  before: SettingValue | null;
  desired: SettingValue | null;
  diff: { field: string; before: boolean | string | string[]; desired: boolean | string | string[] }[] | null;
  preservedFields: string[];
  proposal: Proposal | null;
  blockers: string[];
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-object');
  return value as Record<string, unknown>;
}
function json(source: string): unknown {
  if (typeof source !== 'string' || Buffer.byteLength(source) > HOSTED_STATE_LIMITS.responseBytes) {
    throw new Error('invalid-source');
  }
  return JSON.parse(source);
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('invalid-boolean');
  return value;
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  const found = choices.find(item => item === value);
  if (!found) throw new Error('invalid-choice');
  return found;
}
function actionPatterns(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > HOSTED_STATE_LIMITS.references) throw new Error('invalid-patterns');
  const result = value.map(item => {
    // Only setting syntax is retained, never arbitrary response text or URLs.
    if (typeof item !== 'string' || item.length > 200 ||
        !/^(?:\*|[A-Za-z0-9_.*?-]+\/[A-Za-z0-9_.*?-]+(?:\/[A-Za-z0-9_.*?/-]+)?(?:@[A-Za-z0-9_.*?/-]+)?)$/.test(item)) {
      throw new Error('invalid-pattern');
    }
    return item;
  });
  if (new Set(result).size !== result.length) throw new Error('duplicate-pattern');
  return result;
}
function project(surface: Surface, source: unknown): SettingValue {
  const value = object(source);
  switch (surface) {
    case 'execution': return {
      enabled: boolean(value.enabled),
      allowed_actions: choice(value.allowed_actions, ['all', 'local_only', 'selected']),
      sha_pinning_required: boolean(value.sha_pinning_required)
    };
    case 'allowlist': return {
      github_owned_allowed: boolean(value.github_owned_allowed),
      verified_allowed: boolean(value.verified_allowed),
      patterns_allowed: actionPatterns(value.patterns_allowed)
    };
    case 'workflow': return {
      default_workflow_permissions: choice(value.default_workflow_permissions, ['read', 'write']),
      can_approve_pull_request_reviews: boolean(value.can_approve_pull_request_reviews)
    };
    case 'immutable': return {
      enabled: boolean(value.enabled), enforced_by_owner: boolean(value.enforced_by_owner)
    };
    case 'forkApproval': return {
      approval_policy: choice(value.approval_policy, [
        'first_time_contributors_new_to_github', 'first_time_contributors', 'all_external_contributors'
      ])
    };
  }
}

async function readRegistry(): Promise<string> {
  const handle = await open(new URL('../../security/action-dependencies.json', import.meta.url), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > HOSTED_STATE_LIMITS.responseBytes) throw new Error('invalid-registry-file');
    const bytes = Buffer.alloc(HOSTED_STATE_LIMITS.responseBytes + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > HOSTED_STATE_LIMITS.responseBytes) throw new Error('oversized-registry');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
  } finally { await handle.close(); }
}

/** Registry membership is input data, not fresh descriptor, identity or behavior qualification. */
export function approvedActionReferences(source: string): string[] {
  const registry = object(json(source));
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.actions) ||
      !registry.actions.length || registry.actions.length > HOSTED_STATE_LIMITS.references) throw new Error('invalid-registry');
  const entries = registry.actions.map(object);
  const references = entries.map(entry => {
    if (typeof entry.reference !== 'string' || parseActionReference(entry.reference).kind !== 'remote') throw new Error('invalid-reference');
    return entry.reference;
  });
  if (new Set(references).size !== references.length) throw new Error('duplicate-reference');
  for (const entry of entries) {
    if (!Array.isArray(entry.dependencies) || entry.dependencies.length > HOSTED_STATE_LIMITS.references ||
        entry.dependencies.some(value => typeof value !== 'string' || !references.includes(value))) throw new Error('unregistered-dependency');
  }
  const sorted = references.sort();
  validateActionsPayload('selected-actions', {
    github_owned_allowed: false, verified_allowed: false, patterns_allowed: sorted
  }, sorted);
  return sorted;
}

function unknown(reason: string, httpStatus: number | null = null): Observation {
  return { availability: 'unknown', httpStatus, reason, value: null };
}
async function observe(transport: ReadonlyHostedTransport, surface: Surface): Promise<Observation> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: HostedGetResult;
  try {
    result = await Promise.race([
      Promise.resolve().then(() => transport.get(HOSTED_READ_ENDPOINTS[surface])),
      new Promise<HostedGetResult>(resolve => {
        timer = setTimeout(() => resolve({ kind: 'error', reason: 'timeout' }), HOSTED_STATE_LIMITS.timeoutMs);
      })
    ]);
  } catch { return unknown('transport-error'); }
  finally { clearTimeout(timer); }
  if (!result || typeof result !== 'object') return unknown('invalid-response');
  if (result.kind === 'error') {
    return unknown(['transport-error', 'timeout', 'output-limit', 'invalid-response'].includes(result.reason)
      ? result.reason : 'transport-error');
  }
  if (result.kind !== 'response' || !Number.isInteger(result.status) || result.status < 100 ||
      result.status > 599 || typeof result.body !== 'string') return unknown('invalid-response');
  if (Buffer.byteLength(result.body) > HOSTED_STATE_LIMITS.responseBytes) return unknown('output-limit', result.status);
  if (result.status !== 200) {
    return { availability: 'unavailable', httpStatus: result.status, reason: 'http-unavailable', value: null };
  }
  let value: unknown;
  try { value = json(result.body); } catch { return unknown('malformed-json', result.status); }
  try {
    return { availability: 'available', httpStatus: 200, reason: null, value: project(surface, value) };
  } catch { return unknown('missing-or-invalid-settings', 200); }
}

function comparable(value: SettingValue): SettingValue {
  return { ...value, ...(Array.isArray(value.patterns_allowed) ? { patterns_allowed: [...value.patterns_allowed].sort() } : {}) };
}
function same(left: unknown, right: unknown): boolean {
  return canonicalDigest(left) === canonicalDigest(right);
}
function setting(
  surface: Surface, observations: [Observation, Observation], desired: SettingValue | null, proposal: Proposal | null
): HostedSettingPreview {
  const [first, second] = observations;
  const failed = observations.find(item => item.availability === 'unknown') ??
    observations.find(item => item.availability === 'unavailable');
  const drift = !failed && !same(comparable(first.value!), comparable(second.value!));
  const before = failed || drift ? null : second.value;
  const blockers = observations.flatMap((item, index) => item.reason ? [`read-${index + 1}:${item.reason}`] : []);
  if (drift) blockers.push('readback-drift');
  if (surface === 'allowlist' && !desired) blockers.push('action-registry-unavailable-or-invalid');
  const availability = failed?.availability ?? (drift ? 'unknown' : 'available');
  const diff = before && desired ? Object.entries(desired).flatMap(([field, value]) => {
    const existing = before[field]!;
    const equal = Array.isArray(existing) && Array.isArray(value)
      ? same([...existing].sort(), [...value].sort()) : same(existing, value);
    return equal ? [] : [{ field, before: existing, desired: value }];
  }) : surface === 'forkApproval' && before ? [] : null;
  const status = availability !== 'available' ? availability
    : surface === 'forkApproval' ? 'available' : diff === null ? 'unknown' : diff.length ? 'pending' : 'configured';
  if (status === 'pending') blockers.push('configuration-pending');
  return {
    endpoint: HOSTED_READ_ENDPOINTS[surface], availability, status,
    intent: surface === 'forkApproval' ? 'preserve-observe-only' : 'proposal-data-only',
    observations, before, desired, diff, preservedFields: surface === 'immutable' ? ['enforced_by_owner']
      : surface === 'forkApproval' ? ['approval_policy'] : [],
    proposal, blockers
  };
}

/**
 * Two bounded GET passes detect observed drift, not an atomic snapshot or write
 * precondition. "Configured" means matching readback only. No activation exists.
 * Missing fields are unknown; allowlist ordering alone has no policy meaning.
 */
export async function loadHostedState(
  transport: ReadonlyHostedTransport, registryReader: () => Promise<string> = readRegistry
) {
  let references: string[] | null = null;
  try { references = approvedActionReferences(await registryReader()); } catch { /* Fail closed below. */ }
  const desired = {
    execution: { enabled: true, allowed_actions: 'selected', sha_pinning_required: true },
    allowlist: references ? { github_owned_allowed: false, verified_allowed: false, patterns_allowed: references } : null,
    workflow: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false },
    immutable: { enabled: true },
    forkApproval: null
  };
  const proposals = {
    execution: validateActionsPayload('permissions', desired.execution),
    allowlist: desired.allowlist ? validateActionsPayload('selected-actions', desired.allowlist, references!) : null,
    workflow: validateActionsPayload('workflow', desired.workflow),
    immutable: validateImmutableReleaseEnablement(null),
    forkApproval: null
  };
  const surfaces = Object.keys(HOSTED_READ_ENDPOINTS) as Surface[];
  const startedAt = new Date().toISOString();
  const first = {} as Record<Surface, Observation>, second = {} as Record<Surface, Observation>;
  for (const surface of surfaces) first[surface] = await observe(transport, surface);
  for (const surface of surfaces) second[surface] = await observe(transport, surface);
  const settings = Object.fromEntries(surfaces.map(surface => [
    surface, setting(surface, [first[surface], second[surface]], desired[surface], proposals[surface])
  ])) as Record<Surface, HostedSettingPreview>;
  return {
    schemaVersion: 1, kind: 'read-only-hosted-settings-preview', repository: 'voyager163/liftoff',
    host: 'github.com', startedAt, completedAt: new Date().toISOString(), status: 'blocked',
    readbackComplete: !!references && Object.values(settings).every(value => value.before !== null),
    actionRegistry: {
      path: 'security/action-dependencies.json', status: references ? 'available' : 'unknown',
      references, reason: references ? null : 'action-registry-unavailable-or-invalid'
    },
    capabilityQualified: false, checkBehaviorQualified: false, applyAuthorized: false, liveEffects: false,
    orderingQualified: false, atomicConditionalWriteQualified: false, enforcementQualified: false,
    snapshotAtomic: false, settings,
    blockers: [
      'get-readback-is-not-write-or-enforcement-qualification',
      'api-ordering-unqualified', 'atomic-conditional-write-capability-unqualified',
      'branch-check-app-and-behavior-qualification-pending',
      'tag-and-publisher-identity-qualification-pending', 'apply-not-authorized',
      ...(!references ? ['action-registry-unavailable-or-invalid'] : []),
      ...surfaces.flatMap(surface => settings[surface].blockers.map(reason => `${surface}:${reason}`))
    ]
  };
}
