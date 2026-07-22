import type { AddArtifact } from './template-types.js';
import type { ProjectPlan } from './types.js';

interface GenAiArtifactBuilders {
  backend: (add: AddArtifact, plan: ProjectPlan) => void;
  database: (add: AddArtifact, plan: ProjectPlan) => void;
  pattern: (add: AddArtifact, plan: ProjectPlan) => void;
  functions: (add: AddArtifact, plan: ProjectPlan) => void;
}

export function addGenAiExtensionArtifacts(
  add: AddArtifact,
  plan: ProjectPlan,
  builders: GenAiArtifactBuilders
): void {
  if (plan.projectType.id !== 'genai' || !plan.pattern) {
    throw new Error('GenAI artifact rendering requires a GenAI project plan.');
  }

  builders.backend(add, plan);
  builders.database(add, plan);
  builders.pattern(add, plan);
  builders.functions(add, plan);
}
