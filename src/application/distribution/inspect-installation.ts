import {
  InstallationDetector,
  type InstallationDetectorDependencies
} from '../../adapters/distribution/installation-detector.js';
import type { InstallationInspectionResult } from '../../domain/distribution/contracts.js';

export interface InspectInstallationOptions {
  candidatePath?: string;
  detector?: InstallationDetector;
  detectorDependencies?: InstallationDetectorDependencies;
}

export async function inspectInstallation(
  options: InspectInstallationOptions = {}
): Promise<InstallationInspectionResult> {
  const detector = options.detector ?? new InstallationDetector(options.detectorDependencies);
  return await detector.inspectInstallation(options.candidatePath);
}
