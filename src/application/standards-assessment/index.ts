import { assessProject } from './runner.js';
import { diagnoseProject } from '../diagnose/doctor.js';
import { validateProject } from '../diagnose/validate.js';
import { standardsAssessmentEngine } from './capabilities.js';

export const standardsAssessmentRuntime = Object.freeze({
  descriptor: standardsAssessmentEngine,
  assessProject,
  diagnoseProject,
  validateProject
});

export * from './profile-resolver.js';
export * from './recommendations.js';
export * from './runner.js';
export * from './capabilities.js';
export { computeInventoryDigest } from '../../domain/standards-assessment/sanitizer.js';
export { isActualGoHumaImportAndUsage } from '../../adapters/filesystem/standards-assessment/evidence.js';
