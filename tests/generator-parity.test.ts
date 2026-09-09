import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildProjectPlan } from '../src/planner.js';
import { buildArtifacts } from '../src/templates.js';
import { isManagedCoreLogicalName } from '../src/domain/project/artifact-lifecycle.js';

const fixture = new URL('./fixtures/generator-parity.json', import.meta.url);
const cases = [
  { projectType: 'standard', apiStack: 'python' },
  { projectType: 'standard', apiStack: 'node', includeFrontend: true },
  { projectType: 'standard', apiStack: 'go' },
  ...['generic', 'rag', 'chatbot', 'agent', 'prompt', 'multi-agent', 'fine-tuned', 'streaming', 'workflow']
    .map((pattern) => ({ pattern }))
];
// Captured before extraction. These identities are the separately tested behavior
// repairs; every other artifact must retain the original complete artifact hash.
const intentionalChanges = new Set([
  'manifest', 'root-readme', 'root-gitignore', 'root-dockerignore', 'env-example', 'docker-compose',
  'backend-settings', 'backend-model-config', 'backend-messaging-tool', 'backend-observability',
  'backend-test-messaging', 'backend-test-tracing', 'database-alembic-env',
  'pattern-agent', 'pattern-prompt-readme', 'rag-vector-store', 'pattern-worker',
  'frontend-app', 'frontend-dockerignore', 'openspec-seed-tasks',
  'function-worker-funcignore', 'function-worker-readme',
  'node-backend-drizzle-config', 'node-backend-config', 'node-backend-app', 'node-backend-server', 'node-backend-vitest-config', 'node-backend-test-health',
  'go-backend-main', 'go-backend-api', 'go-backend-config', 'go-backend-test-health', 'go-runtime-config-example',
  'go-backend-makefile', 'go-backend-migration-command',
  'opentofu-readme',
  ...['versions', 'provider-lock', 'providers', 'variables', 'main', 'outputs', 'local-state', 'remote-state-example']
    .map((id) => `opentofu-${id}`),
  ...['versions', 'variables', 'main', 'outputs'].map((id) => `opentofu-application-${id}`),
  ...['dev', 'staging', 'prod'].flatMap((environment) => [
    `environment-${environment}-backend`,
    ...['versions', 'provider-lock', 'providers', 'variables', 'main', 'outputs', 'local-state', 'remote-state-example', 'tfvars']
      .map((id) => `opentofu-${environment}-${id}`)
  ])
]);
const unchanged = (name: string) => !intentionalChanges.has(name) && !isManagedCoreLogicalName(name);

describe('generator extraction parity', () => {
  it('renders deterministically and preserves reviewed unchanged artifact bytes', () => {
    const results = Object.fromEntries(cases.map((selection, index) => {
      const plan = buildProjectPlan({
        projectName: 'Renderer Parity',
        cloud: 'azure',
        environments: ['dev', 'staging', 'prod'],
        ...selection
      }, { requireProjectName: true });
      const artifacts = buildArtifacts(plan);
      expect(buildArtifacts(plan)).toEqual(artifacts);
      return [index, Object.fromEntries(artifacts.map((artifact) => [
        artifact.logicalName,
        createHash('sha256').update(JSON.stringify(artifact)).digest('hex')
      ]))];
    }));
    const baseline = JSON.parse(readFileSync(fixture, 'utf8')) as typeof results;
    for (const [selection, values] of Object.entries(results)) {
      expect(Object.fromEntries(Object.entries(values).filter(([name]) => unchanged(name))))
        .toEqual(Object.fromEntries(Object.entries(baseline[selection]).filter(([name]) => unchanged(name))));
    }
  });
});
