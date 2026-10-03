import type {
  CodingAgentId, EnvironmentId, ManifestGenAiWorkload, ManifestStandardApiWorkload, SpecWorkflowId
} from '../contracts.js';
import { FileSystemError } from '../errors.js';
import { isRetiredPowerAppsWorkload, retiredPowerAppsMessage } from '../retired-workload.js';
import type { ManifestContractContext } from './context.js';
import { exactRecord, isRecord, requiredString } from './fields.js';
import { createManifestProjectReader, createManifestWorkloadReader } from './project-identity.js';

export type ManifestV8WorkflowId = SpecWorkflowId | 'manual';
export type ManifestV8Workload = (
  Readonly<Omit<ManifestGenAiWorkload, 'environments'>> |
  Readonly<Omit<ManifestStandardApiWorkload, 'environments'>>
) & { readonly environments: readonly EnvironmentId[] };

interface ProjectBase {
  readonly name: string;
  readonly workload: ManifestV8Workload;
}

export type ManifestV8ProjectLeaf =
  | {
      readonly project: ProjectBase & {
        readonly specWorkflow: 'manual';
        readonly agents: readonly CodingAgentId[];
        readonly defaultAgent?: never;
      };
      readonly framework: { readonly state: 'not-required' };
    }
  | {
      readonly project: ProjectBase & {
        readonly specWorkflow: SpecWorkflowId;
        readonly agents: readonly [];
        readonly defaultAgent?: never;
      };
      readonly framework: { readonly state: 'legacy'; readonly adapter: SpecWorkflowId };
    }
  | {
      readonly project: ProjectBase & {
        readonly specWorkflow: 'openspec';
        readonly agents: readonly [CodingAgentId, ...CodingAgentId[]];
        readonly defaultAgent?: never;
      };
      readonly framework: { readonly state: 'initialized'; readonly adapter: 'openspec'; readonly contractVersion: string };
    }
  | {
      readonly project: ProjectBase & {
        readonly specWorkflow: 'spec-kit';
        readonly agents: readonly [CodingAgentId, ...CodingAgentId[]];
        readonly defaultAgent: CodingAgentId;
      };
      readonly framework: { readonly state: 'initialized'; readonly adapter: 'spec-kit'; readonly contractVersion: string };
    };

function ownValue(value: unknown, key: string): unknown {
  return isRecord(value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
}

function denseStrings(value: unknown, scope: string): string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new FileSystemError(`${scope} must be a dense plain string array.`);
  }
  const length: unknown = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (typeof length !== 'number' || length > 3 || Reflect.ownKeys(value).length !== length + 1) {
    throw new FileSystemError(`${scope} must contain at most three dense entries.`);
  }
  const strings: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const entry = Object.getOwnPropertyDescriptor(value, String(index));
    if (!entry || !entry.enumerable || !Object.hasOwn(entry, 'value') || typeof entry.value !== 'string') {
      throw new FileSystemError(`${scope}[${index}] must be an own enumerable string data entry.`);
    }
    strings.push(entry.value);
  }
  return strings;
}

/** Project metadata only; neither a complete manifest nor evidence of initialization or execution readiness. */
export function createManifestV8ProjectReader(catalog: ManifestContractContext['catalog']) {
  const normalizeWorkload = createManifestWorkloadReader(catalog);
  const { normalizeManifestFramework } = createManifestProjectReader(catalog);

  function validateManifestV8Project(value: unknown): ManifestV8ProjectLeaf {
    const leaf = exactRecord(value, ['project', 'framework'], 'Manifest v8 project leaf');
    const project = exactRecord(leaf.project, [
      'name', 'workload', 'specWorkflow', 'agents',
      ...(isRecord(leaf.project) && Object.hasOwn(leaf.project, 'defaultAgent') ? ['defaultAgent'] : [])
    ], 'Manifest.project');
    const kind = ownValue(project.workload, 'kind');
    if (typeof kind === 'string' && isRetiredPowerAppsWorkload(kind)) {
      throw new FileSystemError(retiredPowerAppsMessage(kind));
    }
    const workloadInput = exactRecord(project.workload, [
      'kind', 'apiStack', 'cloud', 'region', 'frontend', 'environments', ...(kind === 'genai' ? ['pattern'] : [])
    ], 'Manifest.project.workload');
    const workload = normalizeWorkload({
      ...workloadInput,
      environments: denseStrings(workloadInput.environments, 'Manifest.project.workload.environments')
    });
    const name = requiredString(project, 'name', 'Manifest.project');
    const workflow = requiredString(project, 'specWorkflow', 'Manifest.project');
    if (workflow !== 'manual' && workflow !== 'openspec' && workflow !== 'spec-kit') {
      throw new FileSystemError('Manifest.project.specWorkflow must be openspec, spec-kit or manual.');
    }
    const rawAgents = denseStrings(project.agents, 'Manifest.project.agents');
    const agents = rawAgents.map((value) => {
      const agent = catalog.getCodingAgent(value);
      if (!agent || agent.id !== value) throw new FileSystemError('Manifest.project.agents contains an invalid agent identity.');
      return agent.id;
    });
    const canonical = catalog.canonicalizeCodingAgents(rawAgents).agents.map((agent) => agent.id);
    if (canonical.length !== agents.length || canonical.some((agent, index) => agent !== agents[index])) {
      throw new FileSystemError('Manifest.project.agents must be unique and in canonical order.');
    }
    const hasDefault = Object.hasOwn(project, 'defaultAgent');
    const defaultValue = hasDefault ? requiredString(project, 'defaultAgent', 'Manifest.project') : undefined;
    const defaultAgent = defaultValue === undefined ? undefined : agents.find((agent) => agent === defaultValue);
    if (hasDefault && defaultAgent === undefined) {
      throw new FileSystemError('Manifest.project.defaultAgent must name a selected agent.');
    }
    const base = { name, workload: Object.freeze({ ...workload, environments: Object.freeze([...workload.environments]) }) };
    if (workflow === 'manual') {
      const framework = exactRecord(leaf.framework, ['state'], 'Manifest.framework');
      if (framework.state !== 'not-required' || hasDefault) {
        throw new FileSystemError('Manual requires not-required framework state and no defaultAgent.');
      }
      return Object.freeze({
        project: Object.freeze({ ...base, specWorkflow: workflow, agents: Object.freeze(agents) }),
        framework: Object.freeze({ state: 'not-required' })
      });
    }
    const state = ownValue(leaf.framework, 'state');
    const frameworkInput = exactRecord(leaf.framework,
      state === 'initialized' ? ['state', 'adapter', 'contractVersion'] : ['state', 'adapter'], 'Manifest.framework');
    const framework = normalizeManifestFramework(frameworkInput, 7, {
      name, workload, specWorkflow: workflow, agents, ...(hasDefault ? { defaultAgent } : {})
    });
    if (framework.state === 'legacy') {
      return Object.freeze({
        project: Object.freeze({ ...base, specWorkflow: workflow, agents: Object.freeze([] as const) }),
        framework: Object.freeze({ state: 'legacy', adapter: workflow })
      });
    }
    const firstAgent = agents[0];
    if (!firstAgent || !framework.contractVersion) {
      throw new FileSystemError('Initialized framework requires a contract version and selected agents.');
    }
    const selectedAgents: readonly [CodingAgentId, ...CodingAgentId[]] = Object.freeze([firstAgent, ...agents.slice(1)]);
    if (workflow === 'openspec') {
      return Object.freeze({
        project: Object.freeze({ ...base, specWorkflow: workflow, agents: selectedAgents }),
        framework: Object.freeze({ state: 'initialized', adapter: workflow, contractVersion: framework.contractVersion })
      });
    }
    if (!defaultAgent) throw new FileSystemError('Spec Kit manifests require a selected defaultAgent.');
    return Object.freeze({
      project: Object.freeze({ ...base, specWorkflow: workflow, agents: selectedAgents, defaultAgent }),
      framework: Object.freeze({ state: 'initialized', adapter: workflow, contractVersion: framework.contractVersion })
    });
  }

  return { validateManifestV8Project };
}
