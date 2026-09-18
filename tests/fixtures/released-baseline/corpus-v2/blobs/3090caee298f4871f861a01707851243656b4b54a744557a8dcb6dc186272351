import type { GeneratorContext as ResolvedGeneratorContext } from '../context.js';
type GeneratorContext = Pick<ResolvedGeneratorContext, 'go' | 'stack'> & {
  npm: Pick<ResolvedGeneratorContext['npm'], 'node-backend'>;
  python: Pick<ResolvedGeneratorContext['python'], 'standard'>;
};
import type { AddArtifact } from '../../template-types.js';
import { addGoArtifacts } from './go.js';
import { addNodeArtifacts } from './node.js';
import { addPythonArtifacts } from './python.js';
import type { ApiStackId } from '../../domain/project/contracts.js';
import type { StandardApiProjectPlan } from '../../domain/project/contracts.js';

export type StackBuilder = (add: AddArtifact, plan: StandardApiProjectPlan, context: GeneratorContext) => void;

export const stackBuilders: Record<ApiStackId, StackBuilder> = {
  'python-fastapi': addPythonArtifacts,
  'node-fastify': addNodeArtifacts,
  'go-huma': addGoArtifacts
};

export function addStandardStackArtifacts(add: AddArtifact, plan: StandardApiProjectPlan, context: GeneratorContext): void {
  stackBuilders[plan.apiStack.id](add, plan, context);
}
