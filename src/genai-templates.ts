import type { AddArtifact } from './template-types.js';
import type { GenAiProjectPlan } from './types.js';

interface GenAiArtifactBuilders {
  backend: (add: AddArtifact, plan: GenAiProjectPlan) => void;
  database: (add: AddArtifact, plan: GenAiProjectPlan) => void;
  pattern: (add: AddArtifact, plan: GenAiProjectPlan) => void;
  functions: (add: AddArtifact, plan: GenAiProjectPlan) => void;
}

export function addGenAiExtensionArtifacts(
  add: AddArtifact,
  plan: GenAiProjectPlan,
  builders: GenAiArtifactBuilders
): void {
  builders.backend(add, plan);
  builders.database(add, plan);
  builders.pattern(add, plan);
  builders.functions(add, plan);
}
