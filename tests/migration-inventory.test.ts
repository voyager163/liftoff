import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { goDependencyNames, nodeDependencyNames, pythonDependencyNames } from '../src/domain/migration/dependencies.js';
import { excludesMigrationDirectory } from '../src/domain/migration/inventory.js';
import { renderMigrationChecklist, renderMigrationTasks, seedMigrationGroups } from '../src/migrate-plan.js';
import { buildProjectPlan } from '../src/planner.js';
import { scanDefaults, scanLegacyProject } from '../src/scan.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-inventory-'));
  roots.push(root);
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, ...relative.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return root;
}

describe('migration dependency evidence', () => {
  it('does not infer retrieval or GenAI from requirements comments', async () => {
    const root = await fixture({
      'requirements.txt': 'fastapi==0.111.0 # API\n# pgvector is deliberately not installed\n# pydantic-ai\n'
    });
    const inventory = await scanLegacyProject(root);
    expect(scanDefaults(inventory).options).toMatchObject({
      projectType: 'standard', apiStack: 'python-fastapi'
    });
    expect(inventory.findings.some((finding) => finding.kind === 'retrieval' || finding.kind === 'genai')).toBe(false);
  });

  it('reads TOML dependency fields, not descriptions or example tables', () => {
    const description = pythonDependencyNames('pyproject.toml', [
      '[project]',
      'name = "example"',
      'description = "fastapi pgvector pydantic-ai"',
      'dependencies = ["requests>=2"]',
      '[tool.example]',
      'fastapi = "not a dependency"'
    ].join('\n'));
    expect(description.names).toEqual(['requests']);
    const declarations = pythonDependencyNames('pyproject.toml', [
      '[project]',
      'dependencies = ["fastapi>=0.111", "pydantic_ai", "pgvector"]',
      '[project.optional-dependencies]',
      'test = ["pytest"]'
    ].join('\n'));
    expect(declarations.names).toEqual(['fastapi', 'pydantic-ai', 'pgvector', 'pytest']);
  });

  it('preserves malformed dependency files with a safe diagnostic', async () => {
    const root = await fixture({ 'pyproject.toml': '[project\ndescription = "private-content"' });
    const inventory = await scanLegacyProject(root);
    expect(inventory.findings).toContainEqual(expect.objectContaining({
      kind: 'python-deps', sourcePath: 'pyproject.toml'
    }));
    expect(inventory.diagnostics).toEqual([{
      sourcePath: 'pyproject.toml',
      message: 'Invalid TOML dependency metadata requires explicit target selection and reconciliation.'
    }]);
    expect(scanDefaults(inventory).options.projectType).toBeUndefined();
    expect(await readFile(path.join(root, 'pyproject.toml'), 'utf8')).toContain('private-content');
  });

  it('reads setup.cfg install requirements without running setup.py', () => {
    expect(pythonDependencyNames('setup.cfg', [
      '[options]',
      'install_requires =',
      '    fastapi==0.111.0',
      '    requests>=2',
      '# pgvector',
      '[options.extras_require]',
      'test =',
      '    pytest'
    ].join('\n')).names).toEqual(['fastapi', 'requests', 'pytest']);
    expect(pythonDependencyNames('setup.py', 'raise RuntimeError("never execute")')).toMatchObject({
      names: [], diagnostic: expect.stringContaining('not executed')
    });
  });

  it('ignores package.json scripts and metadata when detecting dependencies', () => {
    expect(nodeDependencyNames(JSON.stringify({
      description: 'react',
      scripts: { fastify: 'example' },
      dependencies: { lodash: '^4' }
    })).names).toEqual(['lodash']);
  });

  it('ignores commented Go declarations and imports embedded in raw strings', () => {
    expect(goDependencyNames([
      'module example.com/project',
      '// require github.com/go-chi/chi/v5 v5.0.0',
      '/* require github.com/danielgtaylor/huma/v2 v2.0.0 */'
    ].join('\n'))).toEqual([]);
    expect(goDependencyNames([
      'package main',
      'var example = `',
      'import "github.com/go-chi/chi/v5"',
      '`',
      '// import "github.com/danielgtaylor/huma/v2"',
      'import (',
      '  _ "fmt"',
      ')'
    ].join('\n'), true)).toEqual(['fmt']);
    expect(goDependencyNames('require (\n github.com/go-chi/chi/v5 v5.0.0 // indirect\n)'))
      .toEqual(['github.com/go-chi/chi/v5']);
  });
});

describe('migration inventory and target placement', () => {
  it('keeps Python configuration and non-workflow GitHub files in the plan', async () => {
    const root = await fixture({
      'setup.py': 'raise RuntimeError("never execute")',
      'setup.cfg': '[options]\ninstall_requires = fastapi',
      'pytest.ini': '[pytest]\ntestpaths = tests',
      '.github/CODEOWNERS': '* @owner',
      '.github/ISSUE_TEMPLATE/bug.yml': 'name: bug'
    });
    const inventory = await scanLegacyProject(root);
    expect(inventory.findings.some((finding) => finding.kind === 'ci')).toBe(false);
    const plan = buildProjectPlan({
      projectName: 'inventory', projectType: 'standard', apiStack: 'node', includeFrontend: false
    }, { requireProjectName: true });
    const tasks = renderMigrationTasks(seedMigrationGroups(inventory, plan));
    for (const file of ['setup.py', 'setup.cfg', 'pytest.ini', '.github/CODEOWNERS', '.github/ISSUE_TEMPLATE/bug.yml']) {
      expect(tasks).toContain(`migration/legacy/${file}`);
    }
    expect(tasks).not.toContain('migration/legacy/.github/workflows');
  });

  it('uses the target language and explicit frontend choice for legacy Go material', async () => {
    const root = await fixture({
      'go.mod': 'module example.com/legacy\nrequire github.com/go-chi/chi/v5 v5.0.0',
      'cmd/api/main.go': 'package main\nimport _ "github.com/go-chi/chi/v5"',
      'frontend/package.json': '{"dependencies":{"react":"^19"}}'
    });
    const inventory = await scanLegacyProject(root);
    const plan = buildProjectPlan({
      projectName: 'target', projectType: 'standard', apiStack: 'node', includeFrontend: false
    }, { requireProjectName: true });
    const tasks = renderMigrationTasks(seedMigrationGroups(inventory, plan));
    expect(tasks).toContain('Port Go application behavior');
    expect(tasks).toContain('into backend/src/ using Fastify');
    expect(tasks).not.toContain('into backend/cmd/api/');
    expect(tasks).toContain('Decide placement for migration/legacy/frontend');
    expect(tasks).toContain('no generated frontend was selected');
    expect(tasks).not.toContain('Move the frontend application');
  });

  it('keeps verification before cleanup without inventing Spec Kit archival', async () => {
    const root = await fixture({ 'requirements.txt': 'fastapi' });
    const inventory = await scanLegacyProject(root);
    const plan = buildProjectPlan({
      projectName: 'checklist', projectType: 'standard', apiStack: 'python', specWorkflow: 'spec-kit'
    }, { requireProjectName: true });
    const groups = seedMigrationGroups(inventory, plan);
    const tasks = renderMigrationTasks(groups);
    expect(tasks.indexOf('Run the backend tests')).toBeLessThan(tasks.indexOf('Delete migration/legacy/'));
    const checklist = renderMigrationChecklist(plan, inventory, groups);
    expect(checklist).toContain('checklist is finalized locally');
    expect(checklist).not.toContain('this change is archived');
  });

  it('shares explicit derived-directory exclusions with staging', async () => {
    const root = await fixture({
      'go.mod': 'module example.com/project',
      'node_modules/ignored/main.go': 'package ignored\nimport _ "github.com/go-chi/chi/v5"',
      'dist/ignored.go': 'package ignored\nimport _ "github.com/go-chi/chi/v5"'
    });
    expect(excludesMigrationDirectory('node_modules')).toBe(true);
    expect(excludesMigrationDirectory('NODE_MODULES')).toBe(true);
    const inventory = await scanLegacyProject(root);
    expect(inventory.findings.some((finding) => finding.kind === 'api-stack')).toBe(false);
  });
});
