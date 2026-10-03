import type { ApiStackId, CodingAgentId, SpecWorkflowId } from '../contracts.js';
import { FileSystemError } from '../errors.js';
import { denseArray, exactRecord } from './fields.js';

export type ManifestPluginRef =
  | { readonly category: 'stack'; readonly id: ApiStackId }
  | { readonly category: 'cloud'; readonly id: 'azure' }
  | { readonly category: 'workflow'; readonly id: SpecWorkflowId | 'manual' }
  | { readonly category: 'agent'; readonly id: CodingAgentId };

export type ManifestPluginIdentity = ManifestPluginRef & {
  readonly apiVersion: number;
  readonly contentVersion: number;
  readonly contentDigest: `sha256:${string}`;
};

export interface ManifestPluginMetadata {
  readonly schemaVersion: 1;
  readonly resolutionDigest: `sha256:${string}`;
  readonly selections: readonly ManifestPluginIdentity[];
}

export interface ManifestPluginSelectionExpectation {
  readonly stack: ApiStackId;
  readonly cloud: 'azure';
  readonly workflow: SpecWorkflowId | 'manual';
  readonly agents: readonly CodingAgentId[];
}

const stacks = ['python-fastapi', 'node-fastify', 'go-huma'] as const satisfies readonly ApiStackId[];
const workflows = ['openspec', 'spec-kit', 'manual'] as const;
const agents = ['github-copilot', 'claude', 'codex'] as const satisfies readonly CodingAgentId[];
const clouds = ['azure'] as const;

function member<T extends string>(value: unknown, values: readonly T[], scope: string): T {
  const found = values.find((candidate) => candidate === value);
  if (found === undefined) throw new FileSystemError(`${scope} must name an exact recognized identity.`);
  return found;
}

function expectation(value: unknown): ManifestPluginSelectionExpectation {
  const scope = 'Manifest plugin expectation';
  const record = exactRecord(value, ['stack', 'cloud', 'workflow', 'agents'], scope);
  const selectedAgents = denseArray(record.agents, agents.length, `${scope}.agents`)
    .map((value) => member(value, agents, `${scope}.agents`));
  if (new Set(selectedAgents).size !== selectedAgents.length) {
    throw new FileSystemError(`${scope}.agents must be unique.`);
  }
  return Object.freeze({
    stack: member(record.stack, stacks, `${scope}.stack`),
    cloud: member(record.cloud, clouds, `${scope}.cloud`),
    workflow: member(record.workflow, workflows, `${scope}.workflow`),
    agents: Object.freeze(selectedAgents)
  });
}

function isDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function digest(value: unknown, scope: string): `sha256:${string}` {
  if (!isDigest(value)) throw new FileSystemError(`${scope} must be a sha256-prefixed lowercase 64-hex digest.`);
  return value;
}

function version(value: unknown, scope: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new FileSystemError(`${scope} must be a positive safe integer.`);
  }
  return value;
}

function pluginIdentity(value: unknown, scope: string): ManifestPluginIdentity {
  const record = exactRecord(value, ['category', 'id', 'apiVersion', 'contentVersion', 'contentDigest'], scope);
  let ref: ManifestPluginRef;
  switch (record.category) {
    case 'stack': ref = { category: 'stack', id: member(record.id, stacks, `${scope}.id`) }; break;
    case 'cloud': ref = { category: 'cloud', id: member(record.id, clouds, `${scope}.id`) }; break;
    case 'workflow': ref = { category: 'workflow', id: member(record.id, workflows, `${scope}.id`) }; break;
    case 'agent': ref = { category: 'agent', id: member(record.id, agents, `${scope}.id`) }; break;
    default: throw new FileSystemError(`${scope}.category must be stack, cloud, workflow or agent.`);
  }
  return Object.freeze({
    ...ref,
    apiVersion: version(record.apiVersion, `${scope}.apiVersion`),
    contentVersion: version(record.contentVersion, `${scope}.contentVersion`),
    contentDigest: digest(record.contentDigest, `${scope}.contentDigest`)
  });
}

/** Recognizes recorded metadata, not release authenticity, compatibility or execution permission. */
export function readManifestPluginMetadata(value: unknown, expected: unknown): ManifestPluginMetadata {
  const selected = expectation(expected);
  const scope = 'Manifest plugin metadata';
  const record = exactRecord(value, ['schemaVersion', 'resolutionDigest', 'selections'], scope);
  if (record.schemaVersion !== 1) throw new FileSystemError(`${scope}.schemaVersion must be 1.`);
  const rows = denseArray(record.selections, 6, `${scope}.selections`);
  const refs: ManifestPluginRef[] = [
    { category: 'stack', id: selected.stack },
    { category: 'cloud', id: selected.cloud },
    { category: 'workflow', id: selected.workflow },
    ...[...selected.agents].sort().map((id) => ({ category: 'agent' as const, id }))
  ];
  if (rows.length !== refs.length) {
    throw new FileSystemError(`${scope}.selections must contain exactly the selected stack, cloud, workflow and agents.`);
  }
  const selections = rows.map((row, index) => {
    const identity = pluginIdentity(row, `${scope}.selections[${index}]`);
    if (identity.category !== refs[index].category || identity.id !== refs[index].id) {
      throw new FileSystemError(`${scope}.selections must match the exact selection in registry category and lexical-ID order.`);
    }
    return identity;
  });
  return Object.freeze({
    schemaVersion: 1,
    resolutionDigest: digest(record.resolutionDigest, `${scope}.resolutionDigest`),
    selections: Object.freeze(selections)
  });
}

/** Exact comparison of normalized metadata, never a source-release or migration decision. */
export function manifestPluginMetadataMatches(recorded: ManifestPluginMetadata, installed: ManifestPluginMetadata): boolean {
  return recorded.schemaVersion === installed.schemaVersion &&
    recorded.resolutionDigest === installed.resolutionDigest &&
    recorded.selections.length === installed.selections.length &&
    recorded.selections.every((row, index) => {
      const target = installed.selections[index];
      return row.category === target.category && row.id === target.id &&
        row.apiVersion === target.apiVersion && row.contentVersion === target.contentVersion &&
        row.contentDigest === target.contentDigest;
    });
}
