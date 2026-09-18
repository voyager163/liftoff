import { initializeProject } from '../initialize/use-case.js';
import { previewProject } from './plan.js';
import { projectGenerationEngine } from './capabilities.js';

export const projectGenerationRuntime = Object.freeze({
  descriptor: projectGenerationEngine,
  initializeProject,
  previewProject
});

export { initializeProject, previewProject };
export * from './capabilities.js';
