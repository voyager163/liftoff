import type {
  ApiProjectPlan,
  GenAiProjectPlan,
  GeneratedArtifact,
  ProjectPlan,
  StandardApiProjectPlan
} from '../../domain/project/contracts.js';
import { addOpenSpecArtifacts, addSpecKitArtifacts } from '../../generators/common/spec-workflow.js';
import type { GeneratorContext } from '../../generators/context.js';
import { addGenAiExtensionArtifacts } from '../../generators/genai/index.js';
import { addInfrastructureArtifacts } from '../../generators/infrastructure/azure.js';
import { stackBuilders } from '../../generators/standard/index.js';
import type { PluginCategory, PluginResolution } from '../../plugins/contracts.js';
import type { AddArtifact } from '../../template-types.js';
import { PluginCompositionError } from './plugins.js';

/*
 * Binds resolved built-in plugins to the canonical generators that render their declared artifacts.
 * The table is data: renderers stay in src/generators and their order and output are unchanged. Every
 * binding is resolved before rendering starts, and a missing binding fails composition.
 */

export type StandardStackRenderer = (add: AddArtifact, plan: StandardApiProjectPlan, context: GeneratorContext) => void;
export type GenAiStackRenderer = (add: AddArtifact, plan: GenAiProjectPlan, context: GeneratorContext) => void;
export type CloudRenderer = (
  add: AddArtifact,
  artifacts: GeneratedArtifact[],
  plan: ApiProjectPlan,
  context: GeneratorContext
) => void;
export type WorkflowRenderer = (addSeed: AddArtifact, addFramework: AddArtifact, plan: ProjectPlan) => void;

export interface StackRendererBinding {
  readonly standard?: StandardStackRenderer;
  readonly genai?: GenAiStackRenderer;
}

export const builtinRendererBindings: {
  readonly stack: Readonly<Record<string, StackRendererBinding>>;
  readonly cloud: Readonly<Record<string, CloudRenderer>>;
  readonly workflow: Readonly<Record<string, WorkflowRenderer>>;
} = Object.freeze({
  stack: Object.freeze({
    'python-fastapi': Object.freeze({ standard: stackBuilders['python-fastapi'], genai: addGenAiExtensionArtifacts }),
    'node-fastify': Object.freeze({ standard: stackBuilders['node-fastify'] }),
    'go-huma': Object.freeze({ standard: stackBuilders['go-huma'] })
  }),
  cloud: Object.freeze({ azure: addInfrastructureArtifacts }),
  workflow: Object.freeze({ openspec: addOpenSpecArtifacts, 'spec-kit': addSpecKitArtifacts })
});

export interface BoundRenderers {
  renderStandardStack(add: AddArtifact, plan: StandardApiProjectPlan, context: GeneratorContext): void;
  renderGenAiStack(add: AddArtifact, plan: GenAiProjectPlan, context: GeneratorContext): void;
  renderCloud(add: AddArtifact, artifacts: GeneratedArtifact[], plan: ApiProjectPlan, context: GeneratorContext): void;
  renderWorkflow(addSeed: AddArtifact, addFramework: AddArtifact, plan: ProjectPlan): void;
}

const missingBinding = (subject: string, detail: string): PluginCompositionError =>
  new PluginCompositionError('pre-render', [{ code: 'missing-renderer-binding', subject, detail }]);

function resolvedPlugin(resolution: PluginResolution, category: PluginCategory): string {
  const matches = resolution.plugins.filter((plugin) => plugin.category === category);
  if (matches.length !== 1) {
    throw missingBinding(`category:${category}`, `the resolution selects ${matches.length} ${category} plugins; exactly one is rendered`);
  }
  return matches[0].id;
}

function bound<T>(table: Readonly<Record<string, T>>, category: PluginCategory, id: string): T {
  const renderer = Object.hasOwn(table, id) ? table[id] : undefined;
  if (renderer === undefined) throw missingBinding(`plugin:${category}:${id}`, 'no canonical renderer is bound to this built-in plugin');
  return renderer;
}

/** Resolves every renderer for a verified resolution before any artifact is rendered. */
export function boundRenderers(
  resolution: PluginResolution,
  bindings: typeof builtinRendererBindings = builtinRendererBindings
): BoundRenderers {
  const stackId = resolvedPlugin(resolution, 'stack');
  const stack = bound(bindings.stack, 'stack', stackId);
  const workload = resolution.selection.workload;
  const standard = workload === 'standard' ? stack.standard : undefined;
  const genai = workload === 'genai' ? stack.genai : undefined;
  if (standard === undefined && genai === undefined) {
    throw missingBinding(`plugin:stack:${stackId}`, `no canonical renderer is bound for the ${workload} workload`);
  }
  const cloud = bound(bindings.cloud, 'cloud', resolvedPlugin(resolution, 'cloud'));
  const workflow = bound(bindings.workflow, 'workflow', resolvedPlugin(resolution, 'workflow'));
  const wrongWorkload = (requested: string): PluginCompositionError =>
    missingBinding(`plugin:stack:${stackId}`, `the resolution was bound for the ${workload} workload, not ${requested}`);
  return Object.freeze({
    renderStandardStack(add: AddArtifact, plan: StandardApiProjectPlan, context: GeneratorContext): void {
      if (standard === undefined) throw wrongWorkload('standard');
      standard(add, plan, context);
    },
    renderGenAiStack(add: AddArtifact, plan: GenAiProjectPlan, context: GeneratorContext): void {
      if (genai === undefined) throw wrongWorkload('genai');
      genai(add, plan, context);
    },
    renderCloud: cloud,
    renderWorkflow: workflow
  });
}
