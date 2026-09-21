#!/usr/bin/env node
import os from 'node:os';
import { buildProjectPlan } from '../dist/planner.js';
import { buildArtifacts } from '../dist/templates.js';
import { generatedSecurityCases, materializeSecurityCase } from './repository-security/inventory.ts';
import { createSecurityWorkspace } from './repository-security/workspace.ts';
import { SecurityEvidenceError } from './repository-security/evidence.ts';

try {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--case')) {
    throw new SecurityEvidenceError('usage-expects-optional-case');
  }
  const selected = args.length === 0 ? generatedSecurityCases : generatedSecurityCases.filter(entry => entry.id === args[1]);
  if (selected.length === 0) throw new SecurityEvidenceError('unknown-generated-case');
  for (const entry of selected) {
    const workspace = await createSecurityWorkspace(os.tmpdir());
    try {
      const artifacts = buildArtifacts(buildProjectPlan(entry.options, { requireProjectName: true }));
      const inputs = await materializeSecurityCase(entry, artifacts, workspace);
      console.log(`Materialized ${entry.id}: ${inputs.length} registered inputs; no generated code executed.`);
    } finally {
      await workspace.cleanup();
    }
  }
  console.log('Materialization verified; security scanner qualification remains separate.');
} catch (error) {
  const code = error instanceof SecurityEvidenceError ? error.code : 'execution-or-cleanup-error';
  process.stderr.write(`Security materialization failed: ${code}.\n`);
  process.exitCode = 1;
}
