import { sanitizeAssessmentText } from './sanitize.js';

export class AssessmentInputError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly source: string | null = null
  ) {
    super(sanitizeAssessmentText(message));
    this.name = 'AssessmentInputError';
  }
}

export class LiveFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly transient = false
  ) {
    super(message);
    this.name = 'LiveFailure';
  }
}
