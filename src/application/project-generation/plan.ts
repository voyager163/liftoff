import type { ProjectOptions } from '../../domain/project/contracts.js';
import { buildProjectPlan } from '../project/planning.js';
import { buildArtifacts } from '../../templates.js';
import { selectWorkstationRequirements } from '../../workstation.js';

export function previewProject(input: ProjectOptions) {
  const plan = buildProjectPlan(input, { requireProjectName: false });
  return { plan, artifacts: buildArtifacts(plan), requirements: selectWorkstationRequirements(plan) };
}
