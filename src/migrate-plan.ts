import type { LegacyInventory, ScanFinding } from './scan.js';
import type { ProjectPlan } from './types.js';

export interface SeededGroup {
  title: string;
  tasks: string[];
}

const staged = (sourcePath: string) => `migration/legacy/${sourcePath}`;

export function seedMigrationGroups(inventory: LegacyInventory, plan: ProjectPlan): SeededGroup[] {
  const byKind = (kind: ScanFinding['kind']) => inventory.findings.filter((finding) => finding.kind === kind);
  const groups: SeededGroup[] = [];
  const dependencyFile = plan.apiStack.id === 'python-fastapi'
    ? 'backend/pyproject.toml'
    : plan.apiStack.id === 'node-fastify' ? 'backend/package.json' : 'backend/go.mod';
  const configFile = plan.apiStack.id === 'python-fastapi'
    ? 'backend/config/settings.py'
    : plan.apiStack.id === 'node-fastify' ? 'backend/src/config.ts' : 'backend/internal/config/config.go';
  const apiDirectory = plan.apiStack.id === 'python-fastapi'
    ? 'backend/apis/routes/'
    : plan.apiStack.id === 'node-fastify' ? 'backend/src/' : 'backend/internal/api/';
  const testDirectory = plan.apiStack.id === 'python-fastapi'
    ? 'backend/tests/'
    : plan.apiStack.id === 'node-fastify' ? 'backend/test/' : 'backend/internal/';
  const push = (title: string, tasks: string[]) => {
    if (tasks.length > 0) {
      groups.push({ title, tasks });
    }
  };

  push('Dependencies', [
    ...byKind('python-deps').map((f) => `Reconcile Python dependencies from ${staged(f.sourcePath)} with ${dependencyFile}`),
    ...byKind('node-deps').map((f) => `Reconcile Node dependencies from ${staged(f.sourcePath)} with ${dependencyFile}${plan.includeFrontend ? ' and frontend/package.json where applicable' : ''}`),
    ...byKind('go-deps').map((f) => `Reconcile Go dependencies from ${staged(f.sourcePath)} with ${dependencyFile}`)
  ]);

  push('Configuration', byKind('env-file').map((f) =>
    `Map variables from ${staged(f.sourcePath)} into environments/*/backend.env and ${configFile}`
  ));

  const codeTasks: string[] = [];
  for (const finding of byKind('framework')) {
    if (finding.evidence.startsWith('fastapi')) {
      codeTasks.push(`Move FastAPI route modules into ${apiDirectory} and register them in the generated API entrypoint (detected: ${finding.evidence})`);
    } else {
      codeTasks.push(`Port application entrypoints into ${apiDirectory} using ${plan.apiStack.framework} - large task: port handlers, middleware, and auth (detected: ${finding.evidence})`);
    }
  }
  codeTasks.push(...byKind('go-source').map((f) =>
    `Move Go application code from ${staged(f.sourcePath)} into backend/cmd/api/ or backend/internal/api/ as appropriate and register it with the generated entrypoint (detected: ${f.evidence})`
  ));
  if (plan.projectType.id === 'genai') {
    codeTasks.push(...byKind('retrieval').map((f) =>
      `Move retrieval and vector-store code into backend/orchestration/retrieval/ (detected: ${f.evidence})`
    ));
  } else {
    codeTasks.push(...byKind('retrieval').map((f) =>
      `Decide how legacy retrieval code should be handled in this standard project (detected: ${f.evidence})`
    ));
  }
  codeTasks.push(...byKind('frontend').map((f) =>
    `Move the frontend application into frontend/ and merge its dependencies with the scaffold's (detected: ${f.evidence})`
  ));
  push('Application code', codeTasks);

  const migrationInstruction = plan.apiStack.id === 'python-fastapi'
    ? 'replace the generated Alembic baseline with the legacy revision history or append the generated schema after its unique head'
    : plan.apiStack.id === 'node-fastify'
      ? 'replace the generated Drizzle baseline or import legacy SQL before it, then regenerate the Drizzle journal and snapshot metadata'
      : 'replace the generated Goose baseline or renumber legacy migrations and the baseline into one unique ordered sequence';
  push('Data and tests', [
    ...byKind('db-migrations').map((f) => `Rebase migration history from ${staged(f.sourcePath)}: ${migrationInstruction}`),
    ...byKind('tests').map((f) => `Relocate tests from ${staged(f.sourcePath)} under ${testDirectory}`)
  ]);

  push('CI and Docker', [
    ...byKind('ci').map((f) => `Port CI jobs from ${staged(f.sourcePath)} into the generated GitHub workflow`),
    ...byKind('docker').map((f) => `Reconcile ${staged(f.sourcePath)} with the generated Dockerfile (keep the generated base; port custom steps)`),
    ...byKind('compose').map((f) => `Reconcile ${staged(f.sourcePath)} with the generated docker-compose.yml (keep the generated services; port custom ones)`)
  ]);

  push('Placement decisions', [
    ...byKind('spec-workflow').map((f) => `Carry existing specs from ${staged(f.sourcePath)} into the scaffold's spec workspace`),
    ...inventory.unrecognized.map((entry) => `Decide placement for ${staged(entry)} (unrecognized top-level entry)`)
  ]);

  push('Verification and cleanup', [
    'Delete migration/legacy/ once every task above is complete',
    'Run the backend tests, `liftoff validate`, and `liftoff doctor`; archive this change when everything is green'
  ]);

  return groups;
}

export function renderMigrationTasks(groups: SeededGroup[]): string {
  const lines: string[] = ['# Tasks: migrate-to-liftoff', ''];
  groups.forEach((group, groupIndex) => {
    lines.push(`## ${groupIndex + 1}. ${group.title}`, '');
    group.tasks.forEach((task, taskIndex) => {
      lines.push(`- [ ] ${groupIndex + 1}.${taskIndex + 1} ${task}`);
    });
    lines.push('');
  });
  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderMigrationProposal(plan: ProjectPlan, inventory: LegacyInventory): string {
  const typeSpecific = plan.pattern
    ? `- Pattern: ${plan.pattern.label}`
    : `- API stack: ${plan.apiStack.label}`;
  return `# Proposal: migrate-to-liftoff

## Why

Adopt the existing project \`${inventory.rootName}\` into Liftoff governance by moving its code into this freshly generated, fully compliant scaffold. The scaffold starts at 100% structural compliance; these tasks move the legacy code into place.

## What Changes

- Legacy source is staged read-only at \`migration/legacy/\` (gitignored) and ported into the Liftoff layout task by task.
- Dependencies, configuration, application code, data, tests, CI, and Docker assets move to their Liftoff locations.
- The staging copy is deleted at the end; the original project directory is never modified.

## Completion Gate

This migration is complete when all tasks are checked, \`liftoff validate\` and \`liftoff doctor\` pass, the backend tests pass, and this change is archived.

## Project

- Project type: ${plan.projectType.label}
${typeSpecific}
- Cloud: ${plan.provider.label} (${plan.region.slug})
- Frontend: ${plan.includeFrontend ? 'yes' : 'no'}
- Spec workflow: ${plan.specWorkflow.label}
`;
}

export function renderMigrationChecklist(plan: ProjectPlan, inventory: LegacyInventory, groups: SeededGroup[]): string {
  return `${renderMigrationProposal(plan, inventory)}\n${renderMigrationTasks(groups)}`;
}
