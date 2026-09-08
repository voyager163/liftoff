import type { GeneratorContext as ResolvedGeneratorContext } from '../context.js';
type GeneratorContext = Pick<ResolvedGeneratorContext, 'functionsRequirements'> & {
  python: Pick<ResolvedGeneratorContext['python'], 'genai'>;
};
import type { AddArtifact } from '../../template-types.js';
import type { GenAiProjectPlan } from '../../domain/project/contracts.js';
import { addBackendArtifacts } from './backend.js';
import { addDatabaseArtifacts } from './database.js';
import { addPatternArtifacts } from './patterns.js';
import { addFunctionArtifacts } from './functions.js';

export function addGenAiExtensionArtifacts(add: AddArtifact, plan: GenAiProjectPlan, context: GeneratorContext): void {
  addBackendArtifacts(add, plan, context);
  addDatabaseArtifacts(add, plan);
  addPatternArtifacts(add, plan);
  addFunctionArtifacts(add, plan, context);
}
