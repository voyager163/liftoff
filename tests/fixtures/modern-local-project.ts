import { projectCatalog } from '../../src/application/project/catalog.js';
import type { ManifestV8ProjectLeaf } from '../../src/domain/project/manifest/v8-project.js';
import type { ManifestLayoutComponentId } from '../../src/domain/project/contracts.js';
import { frameworkOutputPaths, OPEN_SPEC_CODEX_TARGET_PATH } from '../../src/framework-validation.js';
import { toSafeProjectName } from '../../src/domain/project/planning.js';
import { specKitBootstrapTaskIds } from '../../src/domain/governance/activation/local-check-values.js';

export async function writeModernLocalFixtureInputs(
  leaf: ManifestV8ProjectLeaf, components: ReadonlyMap<ManifestLayoutComponentId, readonly string[]>, compose: readonly string[],
  write: (parts: readonly string[], content: string | Buffer) => Promise<void>
) {
  const workload = leaf.project.workload, workflow = leaf.project.specWorkflow;
  for (const [id, parts] of components) {
    if (id.startsWith('opentofu-')) {
      await write([...parts, 'main.tf'], 'locals {\n  enabled = true\n}\n');
    } else if (id === 'backend') {
      if (workload.apiStack === 'node-fastify') await write([...parts, 'package.json'], '{"name":"local-source","version":"1.0.0","type":"module","scripts":{"test":"node --test"}}\n');
      else if (workload.apiStack === 'go-huma') await write([...parts, 'go.mod'], 'module example.local/source\n\ngo 1.24\n');
      else await write([...parts, 'pyproject.toml'], '[project]\nname = "local-source"\nversion = "1.0.0"\nrequires-python = ">=3.12"\ndependencies = []\n');
      await write([...parts, 'tests', 'source.txt'], 'Actual project-owned test input.\n');
      await write([...parts, 'tests', workload.apiStack === 'node-fastify' ? 'source.test.js' : workload.apiStack === 'go-huma' ? 'source_test.go' : 'test_source.py'],
        workload.apiStack === 'node-fastify' ? 'import test from "node:test";\ntest("local", () => {});\n' :
          workload.apiStack === 'go-huma' ? 'package tests\nimport "testing"\nfunc TestLocal(t *testing.T) {}\n' : 'def test_local():\n    assert True\n');
    } else if (id === 'frontend') {
      await write([...parts, 'package.json'], '{"name":"frontend","version":"1.0.0","scripts":{"build":"node build.js"}}\n');
      await write([...parts, 'build.js'], 'console.log("project build");\n');
    } else if (id === 'function-worker') await write([...parts, 'tests', 'test_worker.py'], 'def test_worker():\n    assert True\n');
    else await write([...parts, 'source.txt'], 'Actual selected component input.\n');
  }
  await write(compose, 'services:\n  app:\n    image: example/local:source\n');
  let tasks: string[] | undefined;
  if (workflow !== 'manual' && leaf.framework.state === 'initialized') {
    for (const parts of frameworkOutputPaths({
      workflow, agents: [...leaf.project.agents], ...(leaf.project.defaultAgent ? { defaultAgent: leaf.project.defaultAgent } : {})
    })) await write(parts, 'Selected official integration marker.\n');
    if (workflow === 'spec-kit') {
      await write(['.specify', 'integration.json'], JSON.stringify({
        default_integration: projectCatalog.getCodingAgent(leaf.project.defaultAgent!)!.integrationIds['spec-kit'],
        installed_integrations: leaf.project.agents.map(agent => projectCatalog.getCodingAgent(agent)!.integrationIds['spec-kit'])
      }));
      const identity = 'Bootstrap identity: `000-liftoff-bootstrap`\n';
      await write(['specs', '000-liftoff-bootstrap', 'spec.md'], identity + '## Requirements\nA real local source.\n');
      await write(['specs', '000-liftoff-bootstrap', 'plan.md'], identity + '## Verification\nspecs/000-liftoff-bootstrap/spec.md\n');
      tasks = ['specs', '000-liftoff-bootstrap', 'tasks.md'];
      await write(tasks, identity + specKitBootstrapTaskIds.map(id => `- [ ] ${id} Observe actual local source.\n`).join(''));
    } else {
      const base = ['openspec', 'changes', `bootstrap-${toSafeProjectName(leaf.project.name)}`];
      const capability = `${workload.kind === 'genai' ? workload.pattern : workload.apiStack}-application-baseline`;
      await write([...base, '.openspec.yaml'], 'schema: spec-driven\n');
      await write([...base, 'proposal.md'], `### New Capabilities\n- \`${capability}\`: Local source.\n`);
      await write([...base, 'design.md'], '# Local design\n');
      tasks = [...base, 'tasks.md']; await write(tasks, '- [ ] 1.1 Observe local input.\n');
      await write([...base, 'specs', capability, 'spec.md'], '## Purpose\n\nActual local source.\n\n## ADDED Requirements\n\n### Requirement: Local source\nThe system SHALL observe its source.\n');
      if (leaf.project.agents.some(agent => agent === 'codex')) await write(OPEN_SPEC_CODEX_TARGET_PATH, 'codex\n');
    }
  }
  return tasks;
}
