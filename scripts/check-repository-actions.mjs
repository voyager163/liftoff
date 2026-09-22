#!/usr/bin/env node
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from 'yaml';
import {
  inspectPinnedRemoteAction, parseActionReference, verifyActionGraph, workflowActionReferences
} from './repository-security/actions.ts';
import { SecurityEvidenceError } from './repository-security/evidence.ts';
import { verifyWorkflowBoundaries } from './repository-security/workflow-policy.ts';

try {
  if (process.argv.length !== 2) throw new SecurityEvidenceError('action-check-takes-no-arguments');
  const root = process.cwd();
  const registry = JSON.parse(await readFile(path.join(root, 'security', 'action-dependencies.json'), 'utf8'));
  const controls = JSON.parse(await readFile(path.join(root, 'security', 'control-plane.json'), 'utf8'));
  const expectedPaths = controls.controlInputs.filter(parts => parts[0] === '.github' && parts[1] === 'workflows');
  const directory = path.join(root, '.github', 'workflows');
  const actual = await readdir(directory);
  if (actual.length !== expectedPaths.length || actual.some(name => !expectedPaths.some(parts => parts.length === 3 && parts[2] === name))) {
    throw new SecurityEvidenceError('unregistered-workflow');
  }
  const references = [];
  const actions = registry.actions.map(item => parseActionReference(item.reference))
    .filter(item => item.kind === 'remote');
  for (const parts of expectedPaths) {
    const file = path.join(root, ...parts);
    const status = await lstat(file);
    if (!status.isFile() || status.isSymbolicLink() || status.size > 256 * 1024) throw new SecurityEvidenceError('invalid-workflow-input');
    const source = await readFile(file, 'utf8');
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length > 0) throw new SecurityEvidenceError('invalid-workflow-yaml');
    const workflow = document.toJS({ maxAliasCount: 100 });
    verifyWorkflowBoundaries(workflow, {
      actions,
      ...(parts[2] === 'codeql.yml' ? { reportingJobs: { pullRequest: 'report-pr', protectedRef: 'report-protected' } } : {}),
      ...(parts[2] === 'release.yml' ? { publisherJob: 'publish', publicationJobs: ['assemble', 'publish', 'finalize'], readbackJob: 'qualification' } : {})
    });
    references.push(...workflowActionReferences(workflow));
  }
  const inspections = new Map(registry.actions.map(inspection => [inspection.reference, inspection]));
  const definitions = new Map();
  const queue = [...new Set(references)];
  for (let index = 0; index < queue.length; index++) {
    if (queue.length > 100) throw new SecurityEvidenceError('action-graph-limit');
    const reference = queue[index];
    const inspection = inspections.get(reference);
    if (!inspection) throw new SecurityEvidenceError('unapproved-action-reference');
    const definition = await inspectPinnedRemoteAction(inspection);
    definitions.set(reference, definition);
    for (const dependency of definition.dependencies) if (!queue.includes(dependency)) queue.push(dependency);
  }
  const qualified = verifyActionGraph(references, [...inspections.keys()], definitions);
  console.log(`Verified ${qualified.length} exact action descriptors and declared dependency closure; hosted settings were not changed.`);
} catch (error) {
  const code = error instanceof SecurityEvidenceError ? error.code : 'action-policy-execution-error';
  process.stderr.write(`Repository action validation failed: ${code}.\n`);
  process.exitCode = 1;
}
