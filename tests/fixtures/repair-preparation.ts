import { mkdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { ApiStackId, LiftoffManifest } from '../../src/domain/project/contracts.js';
import { buildProjectPlan } from '../../src/application/project/planning.js';
import { buildArtifacts, buildManifest } from '../../src/templates.js';
import { applicationDigest, applicationPathKey } from '../../src/application/repair/application-files.js';
import { inspectApplicationLayout } from '../../src/application/repair/application-inventory.js';
import type {
  ApplicationPatchDocument, ApplicationPatchMapping, ApplicationVerificationCommand
} from '../../src/application/repair/application-types.js';
import type { ApplicationPreparationRequest } from '../../src/application/repair/application-preparation-types.js';
import { putApplicationFixtureFile } from './repair-application.js';

export interface PreparationFixture {
  directory: string;
  root: string;
  stage: string;
  manifest: LiftoffManifest;
  patchPath: string;
  document: ApplicationPatchDocument;
}

export async function createPreparationFixture(
  directory: string,
  options: { stack?: ApiStackId; frontend?: boolean; genai?: boolean; network?: boolean; npmSource?: 'npmjs' | 'microsoft-npm' } = {}
): Promise<PreparationFixture> {
  const root = path.join(directory, 'project'), stage = path.join(directory, 'stage');
  await mkdir(stage, { recursive: true, mode: 0o700 });
  const stack = options.stack ?? 'node-fastify';
  const plan = buildProjectPlan({
    projectName: 'prepared-custom-application', projectType: options.genai ? 'genai' : 'standard',
    apiStack: stack, ...(options.genai ? { pattern: 'rag' } : {}), includeFrontend: options.frontend ?? false,
    cloud: 'azure', region: 'eastus', environments: ['dev'], specWorkflow: 'openspec',
    agents: ['github-copilot'], governanceProfile: 'none'
  }, { requireProjectName: true });
  const artifacts = buildArtifacts(plan), manifest = buildManifest(plan, artifacts);
  for (const artifact of artifacts) await putApplicationFixtureFile(root, artifact.pathParts, artifact.content);
  await putApplicationFixtureFile(root, ['.liftoff', 'governance', 'state.json'], '{"originalFixtureProof":true}\n');
  await putApplicationFixtureFile(root, ['node_modules', 'private-original-sentinel.txt'], 'Original live dependencies are never copied.\n');
  await putApplicationFixtureFile(root, ['.venv', 'private-original-sentinel.txt'], 'Original live environment is never copied.\n');
  const targets = artifacts.filter((item) => item.lifecycle === 'project');
  const logical = stack === 'node-fastify' ? 'node-backend-app' : stack === 'python-fastapi' ? 'backend-main' : 'go-backend-api';
  const main = targets.find((item) => item.logicalName === logical)!;
  const legacy = ['legacy', path.basename(main.pathParts.at(-1)!)];
  await mkdir(path.join(root, 'legacy'), { recursive: true });
  await rename(path.join(root, ...main.pathParts), path.join(root, ...legacy));
  const after = new Map<string, { target: string[]; content: string; role: 'application' | 'reference' }>();
  let content = await readFile(path.join(root, ...legacy), 'utf8');
  if (stack === 'node-fastify') {
    content = `import { customerTotal } from './customer-pricing.js';\n${content}`
      .replace("'./config.js'", "'../backend/src/config.js'")
      .replace('  return app;', "  app.get('/customer-pricing', async () => ({ total: customerTotal(4) }));\n  return app;");
    await putApplicationFixtureFile(root, legacy, content);
    after.set(applicationPathKey(legacy), { target: main.pathParts, content: content.replace("'../backend/src/config.js'", "'./config.js'"), role: 'application' });
    const pricing = 'export function customerTotal(quantity: number): number {\n  return quantity * (quantity >= 4 ? 875 : 1000);\n}\n';
    await putApplicationFixtureFile(root, ['legacy', 'customer-pricing.ts'], pricing);
    after.set('legacy/customer-pricing.ts', { target: ['backend', 'src', 'customer-pricing.ts'], content: pricing, role: 'application' });
    for (const parts of [['backend', 'src', 'server.ts'], ['backend', 'test', 'health.test.ts']]) {
      const previous = await readFile(path.join(root, ...parts), 'utf8');
      let source = previous.replace(parts.includes('test') ? "'../src/app.js'" : "'./app.js'", "'../../legacy/app.js'");
      if (parts.includes('test')) {
        source += `
it('preserves the existing customer-specific price rule', async () => {
  const app = await buildApp(loadConfig({ DATABASE_URL: 'postgresql://localhost/test', REDIS_URL: 'redis://localhost:6379/0' }));
  const response = await app.inject({ method: 'GET', url: '/customer-pricing' });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ total: 3500 });
  await app.close();
});
`;
      }
      await putApplicationFixtureFile(root, parts, source);
      after.set(applicationPathKey(parts), {
        target: parts, content: source.replace("'../../legacy/app.js'", parts.includes('test') ? "'../src/app.js'" : "'./app.js'"), role: 'reference'
      });
    }
  } else {
    content += stack === 'python-fastapi' ? '\n# Retain the actual customer-specific application source.\n' : '\n// Retain the actual customer-specific application source.\n';
    await putApplicationFixtureFile(root, legacy, content);
    after.set(applicationPathKey(legacy), { target: main.pathParts, content, role: 'application' });
    if (stack === 'python-fastapi') {
      const test = ['backend', 'tests', 'test_health.py'];
      const assertions = await readFile(path.join(root, ...test), 'utf8');
      await putApplicationFixtureFile(root, test,
        'import os\nos.environ["DATABASE_URL"] = "postgresql://127.0.0.1:1/liftoff_test"\nos.environ["REDIS_URL"] = "redis://127.0.0.1:1/0"\n\n' + assertions);
    }
  }
  for (const parts of [['README.md'], ['Dockerfile'], ['docker-compose.yml']]) {
    const original = await readFile(path.join(root, ...parts), 'utf8');
    const source = `${original}\n${parts[0] === 'README.md' ? 'Custom application source: `' : '# Custom application source: '}${applicationPathKey(legacy)}${parts[0] === 'README.md' ? '`' : ''}\n`;
    await putApplicationFixtureFile(root, parts, source);
    after.set(applicationPathKey(parts), {
      target: parts, content: source.replaceAll(applicationPathKey(legacy), applicationPathKey(main.pathParts)), role: 'reference'
    });
  }
  const inspection = await inspectApplicationLayout(root, manifest);
  if (!inspection.report.complete || !inspection.report.target) throw new Error(inspection.report.blockers.join('; '));
  const mappings: ApplicationPatchMapping[] = [];
  for (const [index, [sourceKey, change]] of [...after].entries()) {
    const source = inspection.snapshots.find((item) => applicationPathKey(item.pathParts) === sourceKey)!;
    const identity = inspection.report.target.artifacts.find((item) => applicationPathKey(item.pathParts) === applicationPathKey(change.target));
    const stagedPathParts = ['replacements', `${index}.txt`];
    await putApplicationFixtureFile(stage, stagedPathParts, change.content, 0o600);
    mappings.push({
      sourcePathParts: source.pathParts, targetPathParts: change.target, expectedSourceDigest: applicationDigest(source.content!),
      expectedSourceMode: source.mode!, targetMode: source.mode!, stagedPathParts, role: change.role,
      targetIdentity: { kind: identity ? 'generated-artifact' : 'custom-component', logicalName: identity?.logicalName ?? logical },
      customization: source.content!.toString('utf8') === change.content ? 'preserved' : 'reviewed-edit',
      references: inspection.report.references.filter((item) => applicationPathKey(item.sourcePathParts) === sourceKey).map((reference) => {
        const replacement = after.get(applicationPathKey(reference.targetPathParts));
        const afterTargetPathParts = replacement?.target ?? reference.targetPathParts;
        return {
          referenceId: reference.id,
          disposition: same(reference.targetPathParts, afterTargetPathParts) ? 'unchanged-reviewed' : 'updated',
          afterTargetPathParts
        };
      })
    });
  }
  const network = options.network ?? true;
  const preparation: ApplicationPreparationRequest[] = [{
    provider: stack === 'node-fastify' ? 'npm-ci' : stack === 'python-fastapi' ? 'uv-locked-sync' : 'go-mod-download',
    version: 1, cwdPathParts: ['backend'],
    packageSource: stack === 'node-fastify' ? options.npmSource ?? 'npmjs' : stack === 'python-fastapi' ? 'pypi' : 'go-proxy',
    network, lifecycle: 'disabled'
  }];
  const command = (executable: string, args: string[], cwdPathParts: string[]): ApplicationVerificationCommand => ({
    executable, args, cwdPathParts, timeoutMs: 120_000, maxOutputBytes: 65_536, network: false
  });
  const commands = stack === 'node-fastify'
    ? [command('npm', ['run', 'build', '--ignore-scripts'], ['backend']), command('npm', ['test', '--ignore-scripts'], ['backend'])]
    : stack === 'python-fastapi' ? [command('python', ['-m', 'pytest', '-q', 'backend/tests'], [])]
      : [command('go', ['test', './...'], ['backend'])];
  if (options.frontend) {
    preparation.push({ provider: 'npm-ci', version: 1, cwdPathParts: ['frontend'], packageSource: options.npmSource ?? 'npmjs', network, lifecycle: 'disabled' });
    commands.push(command('npm', ['run', 'build', '--ignore-scripts'], ['frontend']));
  }
  const document: ApplicationPatchDocument = {
    schemaVersion: 1, kind: 'liftoff-application-patch', projectRoot: inspection.report.projectRoot,
    inspectionDigest: inspection.report.inspectionDigest, targetLayoutDigest: inspection.report.target.digest,
    dynamicReferencesReviewed: true, unresolvedMappings: [], mappings, verification: { commands, preparation }
  };
  const patchPath = path.join(stage, 'patch.json');
  await putApplicationFixtureFile(stage, ['patch.json'], `${JSON.stringify(document, null, 2)}\n`, 0o600);
  return { directory, root, stage, manifest, patchPath, document };
}

function same(left: readonly string[], right: readonly string[]): boolean {
  return applicationPathKey(left) === applicationPathKey(right);
}
