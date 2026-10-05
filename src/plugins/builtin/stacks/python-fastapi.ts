import type { ArtifactDeclaration, PluginCondition } from '../../contracts.js';
import {
  builtinDescriptor,
  builtinPatternIds,
  builtinWorkerPatternIds,
  projectArtifact
} from '../core.js';

/*
 * Python/FastAPI serves both standard APIs and every GenAI pattern. Identities are declared per
 * workload and pattern exactly as the canonical renderers emit them; a Python module name replaces
 * each dash in the pattern id with an underscore.
 */

const standard: PluginCondition = { workload: ['standard'] };
const genai: PluginCondition = { workload: ['genai'] };
const onAzure = { cloud: ['azure'] };
const pythonModule = (patternId: string): string => patternId.replaceAll('-', '_');

const sharedBackend: readonly (readonly [string, string, readonly string[]])[] = [
  ['backend-pyproject', 'backend', ['backend', 'pyproject.toml']],
  ['backend-uv-lock', 'backend', ['backend', 'uv.lock']],
  ['backend-package', 'backend', ['backend', '__init__.py']],
  ['backend-api-package', 'backend', ['backend', 'apis', '__init__.py']],
  ['backend-main', 'backend', ['backend', 'apis', 'main.py']],
  ['backend-health-routes', 'backend', ['backend', 'apis', 'routes', 'health.py']],
  ['backend-routes-package', 'backend', ['backend', 'apis', 'routes', '__init__.py']],
  ['backend-auth-dependency', 'backend', ['backend', 'apis', 'dependencies', 'auth.py']],
  ['backend-config-package', 'backend', ['backend', 'config', '__init__.py']],
  ['backend-settings', 'backend', ['backend', 'config', 'settings.py']],
  ['backend-observability-package', 'backend', ['backend', 'observability', '__init__.py']],
  ['backend-test-health', 'backend-test', ['backend', 'tests', 'test_health.py']],
  ['database-alembic-ini', 'database', ['database', 'alembic.ini']],
  ['database-alembic-env', 'database', ['database', 'migrations', 'env.py']],
  ['database-initial-migration', 'database', ['database', 'migrations', 'versions', '0001_initial.py']],
  ['database-schema', 'database', ['database', 'models', 'schema.sql']]
];

const genaiOnly: readonly (readonly [string, string, readonly string[]])[] = [
  ['backend-orchestration-package', 'backend', ['backend', 'orchestration', '__init__.py']],
  ['backend-model-config', 'backend', ['backend', 'orchestration', 'model_config.py']],
  ['backend-messaging-tool', 'backend', ['backend', 'orchestration', 'tools', 'messaging.py']],
  ['backend-tools-package', 'backend', ['backend', 'orchestration', 'tools', '__init__.py']],
  ['backend-test-messaging', 'backend-test', ['backend', 'tests', 'test_messaging.py']],
  ['backend-test-tracing', 'backend-test', ['backend', 'tests', 'test_tracing.py']],
  ['pattern-agent-package', 'pattern', ['backend', 'orchestration', 'agents', '__init__.py']],
  ['pattern-prompt-readme', 'pattern', ['backend', 'orchestration', 'prompts', 'README.md']]
];

const functionWorkerFiles: readonly (readonly [string, string, readonly string[]])[] = [
  ['function-worker-readme', 'functions', ['README.md']],
  ['function-worker-host', 'functions', ['host.json']],
  ['function-worker-local-settings', 'functions', ['local.settings.example.json']],
  ['function-worker-requirements', 'functions', ['requirements.txt']],
  ['function-worker-app', 'functions', ['function_app.py']],
  ['function-worker-test', 'functions-test', ['tests', 'test_function_app.py']],
  ['function-worker-funcignore', 'functions', ['.funcignore']],
  ['function-worker-gitignore', 'functions', ['.gitignore']]
];

function patternArtifacts(patternId: string): ArtifactDeclaration[] {
  const moduleName = pythonModule(patternId);
  const when: PluginCondition = { variant: [patternId] };
  return [
    projectArtifact('backend-pattern-routes', 'backend', ['backend', 'apis', 'routes', `${moduleName}.py`], when),
    projectArtifact('pattern-agent', 'pattern', ['backend', 'orchestration', 'agents', `${moduleName}_agent.py`], when),
    projectArtifact('pattern-agent-test', 'backend-test', ['backend', 'tests', `test_${moduleName}_orchestration.py`], when),
    projectArtifact('pattern-prompt', 'pattern', ['backend', 'orchestration', 'prompts', `${patternId}.md`], when)
  ];
}

function workerArtifacts(patternId: string): ArtifactDeclaration[] {
  const worker = ['functions', `${patternId}-worker`];
  const functionWhen: PluginCondition = { variant: [patternId], ...onAzure };
  return [
    projectArtifact('pattern-worker', 'pattern', ['backend', 'workers', `${pythonModule(patternId)}_worker.py`], { variant: [patternId] }),
    ...functionWorkerFiles.map(([logicalName, category, file]) =>
      projectArtifact(logicalName, category, [...worker, ...file], functionWhen))
  ];
}

export const pythonFastApiPlugin = builtinDescriptor({
  category: 'stack',
  id: 'python-fastapi',
  contentVersion: 2,
  supports: [standard, genai],
  artifacts: [
    ...sharedBackend.map(([logicalName, category, pathParts]) => projectArtifact(logicalName, category, pathParts)),
    projectArtifact('backend-observability', 'backend', ['backend', 'observability', 'logging.py'], standard),
    projectArtifact('backend-observability', 'backend', ['backend', 'observability', 'tracing.py'], genai),
    ...genaiOnly.map(([logicalName, category, pathParts]) => projectArtifact(logicalName, category, pathParts, genai)),
    ...builtinPatternIds.flatMap(patternArtifacts),
    projectArtifact('rag-vector-store', 'pattern', ['backend', 'orchestration', 'retrieval', 'vector_store.py'], { variant: ['rag'] }),
    projectArtifact('rag-retrieval-package', 'pattern', ['backend', 'orchestration', 'retrieval', '__init__.py'], { variant: ['rag'] }),
    projectArtifact('fine-tuned-eval-dataset', 'pattern', ['backend', 'evaluation', 'datasets', 'sample.jsonl'], { variant: ['fine-tuned'] }),
    projectArtifact('backend-workers-package', 'pattern', ['backend', 'workers', '__init__.py'], { variant: [...builtinWorkerPatternIds] }),
    projectArtifact('functions-readme', 'functions', ['functions', 'README.md'], { variant: [...builtinWorkerPatternIds], ...onAzure }),
    ...builtinWorkerPatternIds.flatMap(workerArtifacts)
  ]
});
