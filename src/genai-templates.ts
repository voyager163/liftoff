import type { AddArtifact } from './template-types.js';
import type { GenAiProjectPlan } from './domain/project/contracts.js';
import { addGenAiExtensionArtifacts as addGenAi } from './generators/genai/index.js';
import { resolveGeneratorContext } from './templates.js';

export function addGenAiExtensionArtifacts(add: AddArtifact, plan: GenAiProjectPlan): void {
  addGenAi(add, plan, resolveGeneratorContext(plan));
}
