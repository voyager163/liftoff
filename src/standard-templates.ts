import type { AddArtifact } from './template-types.js';
import type { StandardApiProjectPlan } from './domain/project/contracts.js';
import { addStandardStackArtifacts as addStack } from './generators/standard/index.js';
import { renderStandardDockerfile as renderDockerfile } from './generators/containers/images.js';
import { resolveGeneratorContext } from './templates.js';

export function addStandardStackArtifacts(add: AddArtifact, plan: StandardApiProjectPlan): void {
  addStack(add, plan, resolveGeneratorContext(plan));
}

export function renderStandardDockerfile(plan: StandardApiProjectPlan): string {
  return renderDockerfile(plan, resolveGeneratorContext(plan));
}

export { renderStandardEnv } from './generators/standard/configuration.js';
