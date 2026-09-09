import path from 'node:path';
import {
  findProjectRoot
} from '../../adapters/filesystem/project-discovery.js';
import {
  validateGeneratedProject
} from './generated-project.js';
import type {
  ExecutionContext
} from '../context.js';
export interface ValidationRequest {
  json: boolean;
  project?: string;
}

export async function validateProject(request: ValidationRequest, context: ExecutionContext): Promise<number> {
  context.presentation.commandIdentity('validate', 'Validate a generated Liftoff project');
  const { json: jsonMode, project: explicit } = request;
  const projectRoot = explicit
    ? path.resolve(context.cwd, explicit)
    : (await findProjectRoot(context.cwd)) ?? context.cwd;
  const issues = await validateGeneratedProject(projectRoot);
  if (jsonMode) {
    context.presentation.rawStdout(
      `${JSON.stringify({
        schemaVersion: 1,
        projectRoot,
        valid: issues.length === 0,
        issues
      }, null, 2)}\n`
    );
    return issues.length === 0 ? 0 : 1;
  }
  if (issues.length > 0) {
    context.presentation.error(
      issues.join('\n'),
      'Restore invalid generated files or the manifest from version control, then rerun validation.'
    );
    return 1;
  }
  context.presentation.status('success', 'Generated project manifest is valid', projectRoot);
  return 0;
}
