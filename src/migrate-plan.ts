import type { LegacyInventory, ScanFinding } from './scan.js';
import type { ApiProjectPlan } from './types.js';

export interface SeededGroup {
  title: string;
  tasks: string[];
}

export const migrationChangeName = 'migrate-to-liftoff';
export const migrationCapabilityId = 'legacy-source-adoption';

const staged = (sourcePath: string) => `migration/legacy/${sourcePath}`;

export function seedMigrationGroups(inventory: LegacyInventory, plan: ApiProjectPlan): SeededGroup[] {
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
  const lines: string[] = [`# Tasks: ${migrationChangeName}`, ''];
  groups.forEach((group, groupIndex) => {
    lines.push(`## ${groupIndex + 1}. ${group.title}`, '');
    group.tasks.forEach((task, taskIndex) => {
      lines.push(`- [ ] ${groupIndex + 1}.${taskIndex + 1} ${task}`);
    });
    lines.push('');
  });
  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderMigrationProposal(plan: ApiProjectPlan, inventory: LegacyInventory): string {
  const typeSpecific = plan.workload === 'genai'
    ? `- Pattern: ${plan.pattern.label}`
    : `- API stack: ${plan.apiStack.label}`;
  return `# Proposal: ${migrationChangeName}

## Why

Adopt the existing project \`${inventory.rootName}\` into Liftoff governance by moving its code into this freshly generated, fully compliant scaffold. The scaffold starts at 100% structural compliance; these tasks move the legacy code into place.

## What Changes

- Legacy source is staged read-only at \`migration/legacy/\` (gitignored) and ported into the Liftoff layout task by task.
- Dependencies, configuration, application code, data, tests, CI, and Docker assets move to their Liftoff locations.
- The staging copy is deleted at the end; the original project directory is never modified.

## Capabilities

### New Capabilities

- \`${migrationCapabilityId}\`: Controlled adoption of staged legacy source into the generated Liftoff project without changing the source project or inventing application behavior.

### Modified Capabilities

- None.

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

export function renderMigrationDesign(plan: ApiProjectPlan, inventory: LegacyInventory): string {
  return `# Design: ${migrationChangeName}

## Context

The existing \`${inventory.rootName}\` source is copied into \`migration/legacy/\` inside a fresh ${plan.apiStack.label} Liftoff scaffold. The copy is reference material for reviewed adoption; the original source remains outside the mutation boundary.

## Goals / Non-Goals

**Goals:**

- Reconcile dependencies, configuration, application code, tests, data migrations, CI, and container assets through explicit pending tasks.
- Preserve observable legacy behavior while moving it into the generated project structure.
- Keep the source project unchanged and remove the temporary staging copy only after verification.

**Non-Goals:**

- Infer or invent domain-specific requirements, prompts, routes, data models, authorization policy, or deployment behavior.
- Automatically complete migration tasks or claim semantic equivalence before project tests and review pass.
- Run cloud plan/apply operations or mutate GitHub as part of this change.

## Decisions

- Treat \`migration/legacy/\` as read-only reference input for task-by-task adoption.
- Keep every generated adoption task unchecked until its implementation is reviewed.
- Require project tests, \`liftoff validate\`, and \`liftoff doctor\` before archival.

## Risks / Trade-offs

- Static scanning cannot understand application semantics, so unrecognized material remains an explicit placement decision.
- The generated scaffold provides structure, but behavior preservation still requires implementation review and tests.
`;
}

export function renderMigrationSpec(): string {
  return `## Purpose

Define the controlled adoption boundary for staged legacy source so an existing application can move into a fresh Liftoff scaffold without changing the source project or inventing domain-specific behavior.

## ADDED Requirements

### Requirement: Legacy source adoption is explicit and behavior-preserving
The migration change SHALL use the staged legacy copy only as reviewed reference input, SHALL keep source-adoption work pending until implemented, and SHALL preserve existing application behavior unless a separately reviewed requirement explicitly changes it.

#### Scenario: Adoption work is generated
- **WHEN** Liftoff creates the \`${migrationChangeName}\` change
- **THEN** dependencies, configuration, application code, tests, data, CI, containers, and unrecognized material are represented by explicit pending tasks
- **AND** no task is marked complete automatically

#### Scenario: Domain behavior is not invented
- **WHEN** the generated migration artifacts describe the adoption boundary
- **THEN** they do not invent project-specific routes, prompts, data models, authorization rules, or deployment behavior
- **AND** unresolved placement or behavior decisions remain pending for review

#### Scenario: Migration completion is verified
- **WHEN** the migration change is ready to archive
- **THEN** its adoption tasks are complete and project tests, \`liftoff validate\`, and \`liftoff doctor\` have passed
- **AND** the temporary \`migration/legacy/\` copy is removed while the original source remains unchanged
`;
}

export function renderMigrationChecklist(plan: ApiProjectPlan, inventory: LegacyInventory, groups: SeededGroup[]): string {
  return `${renderMigrationProposal(plan, inventory)}\n${renderMigrationTasks(groups)}`;
}
