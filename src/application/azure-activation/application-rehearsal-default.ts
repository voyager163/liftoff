import { executeApplicationPrivatePlan } from './application-private-execution.js';
import { createApplicationRehearsalComponent } from './application-rehearsal-execution.js';

export const applicationRehearsalProducer = createApplicationRehearsalComponent({ executeApplicationPrivatePlan });
