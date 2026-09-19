export class AssessmentError extends Error {
  readonly code: string;
  readonly exitCode: 1 | 2;

  constructor(message: string, code = 'ASSESSMENT_ERROR', exitCode: 1 | 2 = 1) {
    super(message);
    this.name = 'AssessmentError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export class BoundaryError extends AssessmentError {
  constructor(message: string) {
    super(message, 'BOUNDARY_ERROR', 1);
    this.name = 'BoundaryError';
  }
}

export class PathSafetyError extends AssessmentError {
  constructor(message: string) {
    super(message, 'PATH_SAFETY_ERROR', 1);
    this.name = 'PathSafetyError';
  }
}

export class InputsError extends AssessmentError {
  constructor(message: string) {
    super(message, 'INPUTS_FILE_ERROR', 1);
    this.name = 'InputsError';
  }
}
