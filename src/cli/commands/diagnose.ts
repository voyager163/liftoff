import type {
  ParsedArgs
} from '../../domain/project/contracts.js';
import type {
  ExecutionContext
} from '../../application/context.js';
import {
  diagnoseProject
} from '../../application/diagnose/doctor.js';
import {
  validateProject
} from '../../application/diagnose/validate.js';
import { readBooleanFlag, readStringFlag } from '../args/readers.js';

export const doctorCommand = (
  parsed: ParsedArgs,
  context: ExecutionContext
): Promise<number> => diagnoseProject({
  json: readBooleanFlag(parsed.flags, 'json') ?? false,
  cloud: readStringFlag(parsed.flags, 'cloud')
}, context);

export const validateCommand = (
  parsed: ParsedArgs,
  context: ExecutionContext
): Promise<number> => validateProject({
  json: readBooleanFlag(parsed.flags, 'json') ?? false,
  project: parsed.positional[0] ?? readStringFlag(parsed.flags, 'project')
}, context);
