import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { supportedStack } from '../src/supported-stack.js';
import { buildProjectPlan } from '../src/planner.js';
import { buildArtifacts } from '../src/templates.js';
import { patterns } from '../src/catalogs.js';
import { templateDependencyInventory } from '../scripts/template-dependency-security.mjs';
import {
  dependencyInventory, generatedInputInventory, generatedPatternIds,
  generatedSecurityCases, imageCases, materializeSecurityCase, verifyInputInventory, verifyRepositoryInventory
} from '../scripts/repository-security/inventory.ts';
import { createSecurityWorkspace } from '../scripts/repository-security/workspace.ts';

describe('explicit repository and generated security inventory', () => {
  it('reconciles committed inputs and the explicitly introduced Python source without racing other tests', async () => {
    const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean).map(file => file.split('/'));
    const guard = ['scripts', 'repository-security', 'osv-linux-sandbox.py'];
    expect(await readFile(path.join(process.cwd(), ...guard), 'utf8')).toContain('def install(producer):');
    if (!files.some(parts => parts.join('/') === guard.join('/'))) files.push(guard);
    const inventory = verifyRepositoryInventory(supportedStack, templateDependencyInventory, files);
    expect(inventory.sources).toHaveLength(5);
    expect(inventory.iac).toHaveLength(3);
    expect(inventory.images).toHaveLength(8);
    expect(() => verifyRepositoryInventory(supportedStack, templateDependencyInventory,
      [...files, ['services', 'unlisted', 'package-lock.json']])).toThrow('dependency-input-mismatch');
    expect(() => verifyRepositoryInventory(supportedStack, templateDependencyInventory,
      files.filter(parts => parts.join('/') !== 'services/telemetry-ingest/Dockerfile'))).toThrow('missing-runtime-input');
    for (const image of imageCases) {
      if (image.generatedCase !== null) {
        expect(generatedSecurityCases.some(entry => entry.id === image.generatedCase)).toBe(true);
      }
    }
  });

  it('reuses all four npm identities and release-owned Python extras and Go metadata', () => {
    const inventory = dependencyInventory(supportedStack, templateDependencyInventory);
    expect(inventory.map(entry => entry.id)).toEqual([
      'liftoff-cli', 'telemetry-ingest', 'node-backend', 'standard-frontend',
      'standard-backend', 'genai-backend', 'function-worker', 'go-backend'
    ]);
    expect(inventory.find(entry => entry.id === 'genai-backend')?.extras).toEqual(['functions', 'test']);
    const paths = [...new Map(inventory.map(entry => [entry.pathParts.join('/'), entry.pathParts])).values()];
    expect(() => verifyInputInventory(inventory, paths)).not.toThrow();
    expect(() => verifyInputInventory(inventory, paths.slice(1))).toThrow('dependency-input-mismatch');
    expect(() => verifyInputInventory(inventory, [...paths, ['unknown', 'uv.lock']])).toThrow('dependency-input-mismatch');
    expect(() => dependencyInventory(supportedStack, templateDependencyInventory.slice(1))).toThrow('unmapped-dependency-graph');
    const altered = structuredClone(supportedStack);
    altered.pythonProjects['standard-backend'].lockTemplatePathParts = ['..', 'uv.lock'];
    expect(() => dependencyInventory(altered, templateDependencyInventory)).toThrow('unsafe-location');
  });

  it('accounts for every distinct supported GenAI pattern instead of assuming three cases cover all', () => {
    expect([...generatedPatternIds].sort()).toEqual(patterns.map(pattern => pattern.id).sort());
    expect(generatedSecurityCases).toHaveLength(13);
  });

  it.each(generatedSecurityCases)('materializes real $id generator inputs without setup or execution', async entry => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-generated-security-test '));
    try {
      const plan = buildProjectPlan(entry.options, { requireProjectName: true });
      const artifacts = buildArtifacts(plan);
      const workspace = await createSecurityWorkspace(root);
      const inputs = await materializeSecurityCase(entry, artifacts, workspace);
      expect(inputs).toHaveLength(artifacts.length);
      for (const language of entry.requiredLanguages) expect(inputs.some(input => input.kind === language)).toBe(true);
      expect(inputs.filter(input => input.kind === 'iac').length).toBeGreaterThan(0);
      for (const artifact of artifacts.filter(item => inputs.some(input =>
        input.logicalName === item.logicalName && input.kind === 'dependency'))) {
        expect(await readFile(path.join(workspace.root, entry.id, ...artifact.pathParts), 'utf8')).toBe(artifact.content);
      }
      const missing = artifacts.filter(artifact => artifact.logicalName !== entry.requiredArtifacts[0]);
      expect(() => generatedInputInventory(entry, missing)).toThrow('incomplete-generated-coverage');
      expect(() => generatedInputInventory(entry, [...artifacts, artifacts[0]!])).toThrow('duplicate-generated-input');
      await workspace.cleanup();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects unsupported code types rather than silently dropping generated files', () => {
    const entry = generatedSecurityCases[0]!;
    const artifacts = buildArtifacts(buildProjectPlan(entry.options, { requireProjectName: true }));
    expect(() => generatedInputInventory(entry, [...artifacts, {
      logicalName: 'unexpected-language', category: 'backend', pathParts: ['backend', 'new.rb'], content: '# fixture\n'
    }])).toThrow('unmapped-generated-code');
  });
});
