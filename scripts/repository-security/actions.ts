import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';
import { digest, portableParts, sha, SecurityEvidenceError } from './evidence.ts';

export interface ActionDefinition {
  reference: string;
  kind: 'node' | 'composite' | 'reusable-workflow' | 'local';
  descriptorDigest: string;
  dependencies: string[];
}

export interface PinnedActionInspection {
  reference: string;
  descriptorGitBlob: string;
}

export async function inspectPinnedRemoteAction(
  inspection: PinnedActionInspection, request: typeof fetch = fetch
): Promise<ActionDefinition> {
  const parsed = parseActionReference(inspection.reference);
  if (parsed.kind !== 'remote') throw new SecurityEvidenceError('local-action-needs-source-bound-inspection');
  sha(inspection.descriptorGitBlob);
  const isWorkflow = parsed.pathParts[0] === '.github' && parsed.pathParts[1] === 'workflows';
  const descriptor = isWorkflow ? parsed.pathParts : [...parsed.pathParts, 'action.yml'];
  const url = `https://raw.githubusercontent.com/${parsed.repository}/${parsed.commit}/${descriptor.map(encodeURIComponent).join('/')}`;
  let response: Response;
  try { response = await request(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) }); }
  catch { throw new SecurityEvidenceError('action-descriptor-unavailable'); }
  if (!response.ok || response.body === null) throw new SecurityEvidenceError('action-descriptor-unavailable');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 256 * 1024) {
        await reader.cancel();
        throw new SecurityEvidenceError('action-descriptor-too-large');
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof SecurityEvidenceError) throw error;
    throw new SecurityEvidenceError('action-descriptor-read-failed');
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks);
  const object = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (object !== inspection.descriptorGitBlob) throw new SecurityEvidenceError('action-descriptor-identity-mismatch');
  let source: string;
  try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new SecurityEvidenceError('invalid-action-descriptor-encoding'); }
  return actionDefinition(inspection.reference, source);
}

export function parseActionReference(reference: string) {
  if (typeof reference !== 'string' || reference.length > 500) throw new SecurityEvidenceError('invalid-action-reference');
  if (reference.startsWith('./')) {
    const parts = portableParts(reference.slice(2).split('/'));
    return { kind: 'local' as const, pathParts: parts };
  }
  const separator = reference.lastIndexOf('@');
  if (separator < 1) throw new SecurityEvidenceError('mutable-action-reference');
  const commit = sha(reference.slice(separator + 1));
  const parts = portableParts(reference.slice(0, separator).split('/'));
  if (parts.length < 2 || parts.slice(0, 2).some(part => !/^[A-Za-z0-9_.-]+$/.test(part))) {
    throw new SecurityEvidenceError('invalid-action-repository');
  }
  return { kind: 'remote' as const, repository: parts.slice(0, 2).join('/'), pathParts: parts.slice(2), commit };
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new SecurityEvidenceError('invalid-action-descriptor');
  return value as Record<string, unknown>;
}

export function workflowActionReferences(value: unknown): string[] {
  const workflow = object(value), references: string[] = [];
  for (const value of Object.values(object(workflow.jobs))) {
    const job = object(value);
    if (job.uses !== undefined) {
      if (typeof job.uses !== 'string') throw new SecurityEvidenceError('invalid-reusable-reference');
      references.push(job.uses);
    }
    if (job.steps !== undefined) {
      if (!Array.isArray(job.steps)) throw new SecurityEvidenceError('invalid-workflow-steps');
      for (const value of job.steps) {
        const step = object(value);
        if (step.uses === undefined) continue;
        if (typeof step.uses !== 'string') throw new SecurityEvidenceError('invalid-action-reference');
        references.push(step.uses);
      }
    }
  }
  return references;
}

export function actionDefinition(reference: string, source: string): ActionDefinition {
  const parsed = parseActionReference(reference);
  if (Buffer.byteLength(source) > 256 * 1024) throw new SecurityEvidenceError('action-descriptor-too-large');
  let descriptor: unknown;
  try {
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length > 0) throw new SecurityEvidenceError('invalid-action-yaml');
    descriptor = document.toJS({ maxAliasCount: 100 });
  } catch {
    throw new SecurityEvidenceError('invalid-action-yaml');
  }
  const value = object(descriptor);
  let kind: ActionDefinition['kind'], dependencies: string[];
  if (value.jobs !== undefined) {
    kind = 'reusable-workflow';
    dependencies = workflowActionReferences(value);
  } else {
    const runs = object(value.runs);
    if (runs.using === 'composite') {
      if (!Array.isArray(runs.steps)) throw new SecurityEvidenceError('invalid-composite-action');
      kind = parsed.kind === 'local' ? 'local' : 'composite';
      dependencies = runs.steps.flatMap(value => {
        const step = object(value);
        if (step.uses === undefined) return [];
        if (typeof step.uses !== 'string') throw new SecurityEvidenceError('invalid-composite-reference');
        return [step.uses];
      });
    } else {
      if (runs.using !== 'node24' || typeof runs.main !== 'string') {
        throw new SecurityEvidenceError('unqualified-action-runtime');
      }
      portableParts(runs.main.split('/'));
      for (const stage of ['pre', 'post']) {
        if (runs[stage] !== undefined) {
          if (typeof runs[stage] !== 'string') throw new SecurityEvidenceError('invalid-action-entrypoint');
          portableParts(runs[stage].split('/'));
        }
      }
      kind = parsed.kind === 'local' ? 'local' : 'node';
      dependencies = [];
    }
  }
  for (const dependency of dependencies) parseActionReference(dependency);
  return {
    reference, kind, dependencies,
    descriptorDigest: `sha256:${createHash('sha256').update(source).digest('hex')}`
  };
}

export function verifyActionGraph(
  roots: readonly string[], allowed: readonly string[],
  definitions: ReadonlyMap<string, ActionDefinition>
): string[] {
  if (roots.length === 0 || allowed.length === 0 || new Set(allowed).size !== allowed.length) {
    throw new SecurityEvidenceError('empty-or-duplicate-action-inventory');
  }
  const visited = new Set<string>(), visiting = new Set<string>();
  function visit(reference: string, depth: number) {
    if (depth > 16 || visited.size + visiting.size > 100) throw new SecurityEvidenceError('action-graph-limit');
    parseActionReference(reference);
    if (!allowed.includes(reference)) throw new SecurityEvidenceError('unapproved-action-dependency');
    if (visiting.has(reference)) throw new SecurityEvidenceError('action-dependency-cycle');
    if (visited.has(reference)) return;
    const definition = definitions.get(reference);
    if (!definition || definition.reference !== reference) throw new SecurityEvidenceError('missing-action-inspection');
    digest(definition.descriptorDigest);
    if (!['node', 'composite', 'reusable-workflow', 'local'].includes(definition.kind) ||
        !Array.isArray(definition.dependencies) || definition.dependencies.length > 100) {
      throw new SecurityEvidenceError('invalid-action-inspection');
    }
    visiting.add(reference);
    for (const dependency of definition.dependencies) visit(dependency, depth + 1);
    visiting.delete(reference);
    visited.add(reference);
  }
  for (const root of roots) visit(root, 0);
  return [...visited].sort();
}
