export * from '../domain/governance/assessment/types.js';

import type { CommandRunner } from '../process-runner.js';

export interface LiveAssessmentOptions {
  runner?: CommandRunner;
  now?: () => Date;
}
