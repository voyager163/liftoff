import { updateProject } from '../update/use-case.js';
import { repairProject } from '../repair/use-case.js';
import { migrateProject } from '../migrate/use-case.js';
import { adoptProject } from './adoption/use-case.js';
import { projectEvolutionEngine } from './capabilities.js';

export const projectEvolutionRuntime = Object.freeze({
  descriptor: projectEvolutionEngine,
  updateProject,
  repairProject,
  migrateProject,
  adoptProject
});

export { updateProject, repairProject, migrateProject, adoptProject };
export { projectEvolutionEngine, projectEvolutionCapabilities } from './capabilities.js';
