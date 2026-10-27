import type { CommandSpec } from "./command.ts";
import { makeAssessCommand } from "./commands/assess.ts";
import { capabilitiesCommand } from "./commands/capabilities.ts";
import {
  makeGovernanceApplyNextCommand,
  makeGovernanceAssessCommand,
  makeGovernancePlanCommand,
  makeGovernanceResumeCommand,
  makeGovernanceStatusCommand,
  makeGovernanceVerifyCommand,
} from "./commands/governance.ts";
import { makeInitCommand, makePlanCommand } from "./commands/plan-init.ts";
import { makeReviewClassifyCommand } from "./commands/review-classify.ts";
import { makeUpdateCommand } from "./commands/update.ts";
import { makeDoctorCommand, makeValidateCommand } from "./commands/validate-doctor.ts";

/**
 * Every command Liftoff offers. Help, `capabilities --json` and the CLI
 * reference in docs/ are all generated from this list, so a command that is
 * not here does not exist.
 */
export const REGISTRY: readonly CommandSpec[] = [
  capabilitiesCommand,
  makePlanCommand(),
  makeInitCommand(),
  makeValidateCommand(),
  makeDoctorCommand(),
  makeAssessCommand(),
  makeUpdateCommand(),
  makeReviewClassifyCommand(),
  makeGovernanceStatusCommand(),
  makeGovernanceAssessCommand(),
  makeGovernancePlanCommand(),
  makeGovernanceApplyNextCommand(),
  makeGovernanceResumeCommand(),
  makeGovernanceVerifyCommand(),
];
