import type { ApiProjectPlan } from '../../domain/project/contracts.js';
import { createArtifactAdder } from './artifacts.js';
import type { GeneratedArtifact } from '../../domain/project/contracts.js';
import { hasFunctionWorker } from './values.js';
import { renderBackendEnv } from '../genai/configuration.js';
import { renderFunctionsEnv } from '../genai/configuration.js';
import { renderStandardEnv } from '../standard/configuration.js';

export function addEnvironmentArtifacts(
  artifacts: GeneratedArtifact[],
  plan: ApiProjectPlan
): void {
  for (const environment of plan.environments) {
    const add = createArtifactAdder(
      artifacts,
      'project',
      `environment:${environment.id}`
    );
    add(
      `environment-${environment.id}-backend`,
      'environment',
      ['environments', environment.id, 'backend.env'],
      plan.workload === 'genai' ? renderBackendEnv(plan, environment.id) : renderStandardEnv(plan, environment.id)
    );
    if (plan.workload === 'genai' && hasFunctionWorker(plan)) {
      add(`environment-${environment.id}-functions`, 'environment', ['environments', environment.id, 'functions.env'], renderFunctionsEnv(plan, environment.id));
    }
  }
}
