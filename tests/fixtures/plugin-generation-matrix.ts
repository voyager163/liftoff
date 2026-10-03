import { buildProjectPlan } from '../../src/application/project/planning.js';
import type { ProjectOptions, ProjectPlan } from '../../src/domain/project/contracts.js';

/*
 * Fixed, finite generation matrix for the built-in plugin parity oracle: 165 rendered cases, of which
 * 8 apply the agentless transform that legacy-framework update and agentless repair apply after
 * planning. Every entry is planner-valid under the current rules; the matrix is deliberately literal
 * so a catalog change cannot silently change what the oracle covers.
 */

export type MatrixGroup = 'M1' | 'M2a' | 'M2b' | 'M3' | 'M4';

export interface MatrixCase {
  readonly id: string;
  readonly group: MatrixGroup;
  readonly options: Readonly<ProjectOptions>;
  /** Render with `agents: []` and no default agent, exactly as update and repair do. */
  readonly agentless?: true;
}

const defaults: ProjectOptions = { projectName: 'Contract Baseline', cloud: 'azure', region: 'eastus' };

const catalogAgents = ['github-copilot', 'claude', 'codex'] as const;
const allAgents = [...catalogAgents];
const governed = 'single-maintainer-gitflow';

const workloadVariants: readonly { readonly key: string; readonly options: ProjectOptions }[] = [
  { key: 'python-fastapi', options: { projectType: 'standard', apiStack: 'python-fastapi' } },
  { key: 'node-fastify', options: { projectType: 'standard', apiStack: 'node-fastify' } },
  { key: 'go-huma', options: { projectType: 'standard', apiStack: 'go-huma' } },
  ...['generic', 'rag', 'chatbot', 'agent', 'prompt', 'multi-agent', 'fine-tuned', 'streaming', 'workflow']
    .map((pattern) => ({ key: `genai-${pattern}`, options: { projectType: 'genai', pattern } }))
];
const variant = (key: string): ProjectOptions => {
  const found = workloadVariants.find((entry) => entry.key === key);
  if (found === undefined) throw new Error(`Unknown matrix workload variant ${key}.`);
  return found.options;
};

const agentSubsets: readonly (readonly string[])[] = [
  ['github-copilot'], ['claude'], ['codex'],
  ['github-copilot', 'claude'], ['github-copilot', 'codex'], ['claude', 'codex'],
  ['github-copilot', 'claude', 'codex']
];
const environmentSubsets: readonly (readonly string[])[] = [
  ['dev'], ['staging'], ['prod'], ['dev', 'staging'], ['dev', 'prod'], ['staging', 'prod'], ['dev', 'staging', 'prod']
];
const governanceProfiles = [governed, 'none'] as const;
const governanceKey = (profile: string) => (profile === governed ? 'governed' : 'ungoverned');

/** Spec Kit requires an explicit default when several agents are selected: the first in catalog order. */
function specKitDefault(workflow: string, agents: readonly string[]): ProjectOptions {
  return workflow === 'spec-kit' && agents.length > 1 ? { defaultAgent: agents[0] } : {};
}

const m1: MatrixCase[] = workloadVariants.flatMap(({ key, options }) =>
  (['openspec', 'spec-kit'] as const).flatMap((workflow) =>
    governanceProfiles.flatMap((governanceProfile) =>
      [false, true].map((includeFrontend): MatrixCase => ({
        id: `m1/${key}/${workflow}/${governanceKey(governanceProfile)}/${includeFrontend ? 'frontend' : 'api-only'}`,
        group: 'M1',
        options: {
          ...defaults,
          ...options,
          specWorkflow: workflow,
          governanceProfile,
          includeFrontend,
          agents: allAgents,
          ...(workflow === 'spec-kit' ? { defaultAgent: 'github-copilot' } : {})
        }
      })))));

const m2Bases = [
  { key: 'python-fastapi-openspec', options: { ...variant('python-fastapi'), specWorkflow: 'openspec' } },
  { key: 'genai-rag-spec-kit', options: { ...variant('genai-rag'), specWorkflow: 'spec-kit' } }
] as const;

const m2a: MatrixCase[] = agentSubsets.flatMap((agents) =>
  governanceProfiles.flatMap((governanceProfile) =>
    m2Bases.map(({ key, options }): MatrixCase => ({
      id: `m2a/${agents.join('+')}/${governanceKey(governanceProfile)}/${key}`,
      group: 'M2a',
      options: {
        ...defaults,
        ...options,
        governanceProfile,
        agents: [...agents],
        ...specKitDefault(options.specWorkflow, agents)
      }
    }))));

const m2b: MatrixCase[] = governanceProfiles.flatMap((governanceProfile) =>
  (['openspec', 'spec-kit'] as const).flatMap((workflow) =>
    ['python-fastapi', 'genai-rag'].map((key): MatrixCase => ({
      id: `m2b/${governanceKey(governanceProfile)}/${workflow}/${key}`,
      group: 'M2b',
      options: { ...defaults, ...variant(key), specWorkflow: workflow, governanceProfile, agents: ['github-copilot'] },
      agentless: true
    }))));

const m3: MatrixCase[] = environmentSubsets.flatMap((environments) =>
  ['genai-rag', 'genai-generic', 'go-huma'].map((key): MatrixCase => ({
    id: `m3/${environments.join('+')}/${key}`,
    group: 'M3',
    options: {
      ...defaults,
      ...variant(key),
      specWorkflow: 'openspec',
      governanceProfile: governed,
      agents: ['github-copilot'],
      environments: [...environments]
    }
  })));

const m4Base: ProjectOptions = { ...defaults, specWorkflow: 'openspec', governanceProfile: governed, agents: ['github-copilot'] };
const m4Cases: readonly (readonly [string, ProjectOptions])[] = [
  ['name-my-app-2-node', { ...variant('node-fastify'), projectName: 'My App 2' }],
  ['name-cafe-omega-node', { ...variant('node-fastify'), projectName: 'Café Ω' }],
  ['name-punctuation-only-node', { ...variant('node-fastify'), projectName: '!!!' }],
  ['name-160-x-node', { ...variant('node-fastify'), projectName: 'x'.repeat(160) }],
  ['spec-kit-rag-my-app-2', { ...variant('genai-rag'), projectName: 'My App 2', specWorkflow: 'spec-kit' }],
  ['copilot-cloud-enabled-generic', { ...variant('genai-generic'), copilotCloud: true }],
  ['copilot-cloud-disabled-generic', { ...variant('genai-generic'), copilotCloud: false }],
  ['go-koreacentral', { ...variant('go-huma'), region: 'koreacentral' }],
  ['spec-kit-workflow-default-claude', {
    ...variant('genai-workflow'), specWorkflow: 'spec-kit', agents: ['github-copilot', 'claude'], defaultAgent: 'claude'
  }],
  ['spec-kit-workflow-default-copilot', {
    ...variant('genai-workflow'), specWorkflow: 'spec-kit', agents: ['github-copilot', 'claude'], defaultAgent: 'github-copilot'
  }],
  ['python-westeurope-frontend', { ...variant('python-fastapi'), region: 'westeurope', includeFrontend: true }],
  ['spec-kit-go-codex-only', { ...variant('go-huma'), specWorkflow: 'spec-kit', agents: ['codex'] }]
];
const m4: MatrixCase[] = m4Cases.map(([key, options]): MatrixCase => ({ id: `m4/${key}`, group: 'M4', options: { ...m4Base, ...options } }));

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

export const pluginGenerationMatrix: readonly MatrixCase[] = deepFreeze([...m1, ...m2a, ...m2b, ...m3, ...m4]);

/** Plans a case through the real planner, then applies the agentless render transform if requested. */
export function matrixPlan(entry: MatrixCase): ProjectPlan {
  const options = structuredClone(entry.options) as ProjectOptions;
  const plan = buildProjectPlan(options, { requireProjectName: true });
  return entry.agentless ? { ...plan, agents: [], defaultAgent: undefined } : plan;
}
