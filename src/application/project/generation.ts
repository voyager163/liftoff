import type { CurrentProjectPlan, GeneratedArtifact, ProjectOptions } from '../../domain/project/contracts.js';
import type { BuildPlanOptions } from '../../domain/project/planning.js';
import { buildArtifacts, buildCurrentArtifacts } from '../../templates.js';
import { selectCurrentWorkstationRequirements, selectWorkstationRequirements } from '../../workstation.js';
import { buildCurrentProjectPlan, buildProjectPlan } from './planning.js';

export interface ProjectGenerator {
  current: boolean;
  buildPlan(input: ProjectOptions, options: BuildPlanOptions): CurrentProjectPlan;
  buildArtifacts(plan: CurrentProjectPlan): GeneratedArtifact[];
  requirements: typeof selectCurrentWorkstationRequirements;
}

export const historicalProjectGenerator: ProjectGenerator = {
  current: false,
  buildPlan: buildProjectPlan,
  buildArtifacts(plan) {
    if (!plan.framework) throw new Error('Historical generation requires an external specification framework.');
    return buildArtifacts(plan);
  },
  requirements: selectWorkstationRequirements
};

export const currentProjectGenerator: ProjectGenerator = {
  current: true,
  buildPlan: buildCurrentProjectPlan,
  buildArtifacts: buildCurrentArtifacts,
  requirements: selectCurrentWorkstationRequirements
};
