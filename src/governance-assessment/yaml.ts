import { LineCounter, parseDocument } from 'yaml';
import { AssessmentInputError } from './readers.js';
import { isRecord } from './sanitize.js';

export interface ParsedWorkflow {
  path: string;
  value: Record<string, unknown>;
  lineOf: (key: string) => number;
}

export function parseAssessmentWorkflow(text: string, path: string): ParsedWorkflow {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, {
    version: '1.2', schema: 'core', uniqueKeys: true, strict: true, customTags: [], lineCounter
  });
  if (document.errors.length || document.warnings.length) {
    throw new AssessmentInputError('malformed-workflow', `Workflow ${path} has invalid keys, tags, or YAML syntax.`, path);
  }
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 50 }) as unknown;
  } catch {
    throw new AssessmentInputError('malformed-workflow', `Workflow ${path} exceeds safe YAML alias limits.`, path);
  }
  if (!isRecord(value)) throw new AssessmentInputError('malformed-workflow', `Workflow ${path} must be a YAML object.`, path);
  return {
    path, value,
    lineOf(key: string): number {
      const node = document.get(key, true);
      return typeof node === 'object' && node !== null && 'range' in node && Array.isArray(node.range)
        ? lineCounter.linePos(Number(node.range[0])).line : 1;
    }
  };
}
