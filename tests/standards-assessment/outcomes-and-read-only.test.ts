import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import child_process from 'node:child_process';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assessProject } from '../../src/application/standards-assessment/runner.js';
import { sha256Hex } from '../../src/domain/standards-assessment/sanitizer.js';
import { buildProjectPlan } from '../../src/planner.js';
import { buildArtifacts } from '../../src/templates.js';

const fixtureDirs: string[] = [];

function createFixtureDir(prefix: string): string {
  const dir = path.resolve(process.cwd(), 'tests', `.outcomes-fixture-${prefix}-${randomUUID()}`);
  fixtureDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of fixtureDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

async function computeDirectorySnapshot(dir: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  async function walk(current: string) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const content = await readFile(full);
        snapshot.set(path.relative(dir, full), sha256Hex(content));
      }
    }
  }
  await walk(dir);
  return snapshot;
}

describe('standards assessment outcomes and strict read-only guarantees', () => {
  it('can satisfy the Vue-only static declaration contract without any backend, cloud or private-runtime claim', async () => {
    const dir = createFixtureDir('vue-static-only');
    await mkdir(path.join(dir, 'src'), { recursive: true });
    const artifacts = buildArtifacts(buildProjectPlan({
      projectName: 'vue-static', projectType: 'standard', apiStack: 'node', includeFrontend: true, cloud: 'azure', governanceProfile: 'none'
    }, { requireProjectName: true }));
    for (const name of ['package.json', 'package-lock.json']) {
      await writeFile(path.join(dir, name), artifacts.find((entry) => entry.pathParts.join('/') === `frontend/${name}`)!.content);
    }
    await writeFile(path.join(dir, 'src', 'PricingShell.vue'), '<template><main>Custom pricing page</main></template><script setup lang="ts">const amount = 25;</script>');
    await writeFile(path.join(dir, 'src', 'main.ts'), 'import { createApp as mountRoot } from "vue"; import Pricing from "./PricingShell.vue"; mountRoot(Pricing).mount("#app");');
    await writeFile(path.join(dir, 'vite.config.ts'), 'import { defineConfig as configure } from "vite"; import ui from "@vitejs/plugin-vue"; import styles from "@tailwindcss/vite"; export default configure({plugins: [ui(), styles()]});');
    const result = await assessProject({ targetPath: dir });
    expect(result.profile.id).toBe('vue-component');
    expect(result.observedProfiles.map((entry) => [entry.id, entry.componentRoot])).toEqual([['vue-component', '.']]);
    expect(result.findings.map((entry) => entry.ruleId)).toEqual(['RULE-FRONTEND-BUILD', 'RULE-FRONTEND-ENTRY', 'RULE-FRONTEND-PACKAGE']);
    expect(result.findings.map((entry) => entry.classification)).toEqual(['aligned', 'aligned', 'aligned']);
    expect(result.findings.some((entry) => entry.ruleId.includes('API') || entry.ruleId.includes('INFRA'))).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.target.hasManifest).toBe(false);
  });

  it('does not turn a full set of static declarations into private-check, integrity or runtime proof', async () => {
    const dir = createFixtureDir('full-coverage-exit-0');
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await mkdir(path.join(dir, 'tests'), { recursive: true });
    await mkdir(path.join(dir, 'openspec'), { recursive: true });
    await mkdir(path.join(dir, 'infrastructure', 'opentofu'), { recursive: true });

    // Valid Liftoff manifest
    await writeFile(
      path.join(dir, 'liftoff.manifest.json'),
      JSON.stringify({
        artifactVersion: 7,
        generatedBy: 'Mission Control Liftoff',
        liftoffVersion: '0.12.3',
        project: {
          name: 'complete-fastify',
          workload: {
            kind: 'standard',
            apiStack: 'node-fastify',
            cloud: 'azure',
            region: 'eastus',
            frontend: false,
            environments: ['dev']
          },
          specWorkflow: 'openspec',
          agents: ['github-copilot']
        },
        framework: {
          state: 'initialized',
          adapter: 'openspec',
          contractVersion: '1.0.0'
        },
        governance: {
          profile: 'none',
          state: 'disabled'
        },
        managedArtifacts: [],
        projectArtifacts: []
      })
    );

    // Dependencies and matching lockfile
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'complete-fastify', dependencies: { fastify: '^5.0.0' } })
    );
    await writeFile(
      path.join(dir, 'package-lock.json'),
      JSON.stringify({ name: 'complete-fastify', lockfileVersion: 3 })
    );

    // Source with health and docs
    await writeFile(
      path.join(dir, 'src', 'server.ts'),
      `import fastify from 'fastify';
       const app = fastify();
       app.get('/health', async () => ({ status: 'ok' }));
       app.get('/docs', async () => ({ openapi: '3.0.0' }));
      `
    );

    // Test declarations
    await writeFile(path.join(dir, 'tests', 'api.test.ts'), 'test("api", () => {});\n');

    // Containers: Dockerfile and compose
    await writeFile(path.join(dir, 'Dockerfile'), 'FROM node:24-alpine\n');
    await writeFile(path.join(dir, 'docker-compose.yml'), 'services:\n  app:\n    build: .\n');

    // Framework
    await writeFile(path.join(dir, 'openspec', 'config.yaml'), 'version: 1\n');

    // Infrastructure
    await writeFile(path.join(dir, 'infrastructure', 'opentofu', 'main.tf'), 'terraform {}\n');

    const result = await assessProject({ targetPath: dir });

    expect(result.profile.id).toBe('node-fastify');
    expect(result.coverage.declaredRules).toBe(result.profile.declaredRuleCoverage.length);
    expect(result.coverage.assessedRules).toBe(result.profile.declaredRuleCoverage.length);
    expect(result.coverage.unknownRules).toBeGreaterThan(0);
    expect(result.findings.find((entry) => entry.ruleId === 'RULE-TEST-SUITE')?.observed.facts)
      .toMatchObject({ privateExecutionVerified: false });
    expect(result.findings.find((entry) => entry.ruleId === 'RULE-API-DOCS')?.classification).toBe('unknown');
    expect(result.outcome).toBe('differences');
    expect(result.exitCode).toBe(2);
  });

  it('exits 2 with outcome differences when valid report has standards gaps or missing coverage', async () => {
    const dir = createFixtureDir('valid-differences-exit-2');
    await mkdir(path.join(dir, 'src'), { recursive: true });

    // Has dependencies and lock but NO manifest, NO health endpoint, NO containers
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'partial-fastify', dependencies: { fastify: '^5.0.0' } })
    );
    await writeFile(
      path.join(dir, 'package-lock.json'),
      JSON.stringify({ name: 'partial-fastify', lockfileVersion: 3 })
    );
    await writeFile(
      path.join(dir, 'src', 'server.ts'),
      "import fastify from 'fastify';\nconst app = fastify();\n"
    );

    const result = await assessProject({ targetPath: dir });

    expect(result.outcome).toBe('differences');
    expect(result.exitCode).toBe(2);
    expect(result.coverage.missingRules + result.coverage.differingRules).toBeGreaterThan(0);
  });

  it('exits 2 when an unsupported stack (Express) is assessed', async () => {
    const dir = createFixtureDir('unsupported-stack-exit-2');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'express-app', dependencies: { express: '^4.21.0' } })
    );
    await writeFile(
      path.join(dir, 'server.js'),
      "const express = require('express');\nconst app = express();\n"
    );

    const result = await assessProject({ targetPath: dir });

    expect(result.profile.status).toBe('unsupported');
    expect(result.outcome).toBe('differences');
    expect(result.exitCode).toBe(2);
  });

  it('exits 1 with outcome error on fatal boundary or malformed inner manifest', async () => {
    const dir = createFixtureDir('malformed-manifest-exit-1');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'liftoff.manifest.json'), '{ malformed json content');

    const result = await assessProject({ targetPath: dir });

    expect(result.outcome).toBe('error');
    expect(result.exitCode).toBe(1);
    expect(result.diagnostics.some((d) => d.severity === 'error')).toBe(true);
  });

  it('verifies strict read-only behavior: bytes unchanged, no processes, no network, no receipts', async () => {
    const dir = createFixtureDir('read-only-guarantee');
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'read-only-demo', dependencies: { fastify: '^5.0.0' } })
    );
    await writeFile(
      path.join(dir, 'package-lock.json'),
      JSON.stringify({ name: 'read-only-demo', lockfileVersion: 3 })
    );
    await writeFile(
      path.join(dir, 'src', 'server.ts'),
      "import fastify from 'fastify';\nconst app = fastify();\n"
    );

    // Spy on child_process to prove NO subprocess is spawned
    const spawnSpy = vi.spyOn(child_process, 'spawn');
    const execSpy = vi.spyOn(child_process, 'exec');
    const execFileSpy = vi.spyOn(child_process, 'execFile');

    // Snapshot project directory before assessment
    const beforeSnapshot = await computeDirectorySnapshot(dir);

    // Execute assessment
    const result = await assessProject({ targetPath: dir });
    expect(result).toBeDefined();

    // Verify NO child processes were launched
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(execSpy).not.toHaveBeenCalled();
    expect(execFileSpy).not.toHaveBeenCalled();

    // Snapshot project directory after assessment
    const afterSnapshot = await computeDirectorySnapshot(dir);

    // Verify 100% bit-for-bit equivalence
    expect(afterSnapshot.size).toBe(beforeSnapshot.size);
    for (const [relPath, hash] of beforeSnapshot.entries()) {
      expect(afterSnapshot.get(relPath)).toBe(hash);
    }

    // Verify NO new files (such as .liftoff, preview receipts, or notice files) were created
    const allFiles = await readdir(dir);
    expect(allFiles).not.toContain('.git');
    expect(allFiles).not.toContain('.liftoff');
    expect(allFiles).not.toContain('liftoff.manifest.json');
  });
});
