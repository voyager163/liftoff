import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LiftoffManifest } from '../../src/domain/project/contracts.js';
import { buildProjectPlan } from '../../src/application/project/planning.js';
import { buildArtifacts, buildManifest } from '../../src/templates.js';
import { applicationDigest, applicationPathKey } from '../../src/application/repair/application-files.js';
import { inspectApplicationLayout } from '../../src/application/repair/application-inventory.js';
import type {
  ApplicationPatchDocument, ApplicationPatchMapping, ApplicationReference, ApplicationVerificationCommand
} from '../../src/application/repair/application-types.js';
import type { ApplicationPatchCandidate } from '../../src/application/repair/application-types.js';
import type { ApplicationVerificationOptions } from '../../src/application/repair/application-preparation-types.js';
import { applicationCandidateDigest } from '../../src/application/repair/application-patch.js';
import { buildRepairPreview } from '../../src/application/repair/preview.js';
import { createScopedUserLocalRecordStore } from '../../src/adapters/filesystem/update-previews.js';
import { captureProjectFileSnapshot } from '../../src/adapters/filesystem/project-transaction.js';
import { canonicalSha256 } from '../../src/domain/governance/activation/canonical-json.js';

export const applicationFixtureSources: Record<string, string> = {
  'legacy/service.mjs': `import { quote } from './custom.mjs';
export function application(quantity) {
  return { ...quote(quantity), customization: 'customer-volume-discount' };
}
`,
  'legacy/custom.mjs': `export function quote(quantity) {
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error('quantity required');
  const discount = quantity >= 4 ? 125 : 0;
  return { quantity, totalCents: quantity * (1000 - discount) };
}
`,
  'tests/quote.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { application } from '../legacy/service.mjs';
test('keeps the real customer-specific behavior', () => {
  assert.deepEqual(application(4), { quantity: 4, totalCents: 3500, customization: 'customer-volume-discount' });
  assert.equal(application(1).totalCents, 1000);
  assert.throws(() => application(0), /quantity required/);
  assert.equal(process.env.APPLICATION_FIXTURE_SECRET, undefined);
});
`,
  'scripts/check-layout.mjs': `import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
const entrypoint = 'legacy/service.mjs';
const component = 'legacy';
for (const file of ['Dockerfile', 'docker-compose.yml', 'docs/operations.md', 'README.md', 'package.json']) {
  assert.ok((await readFile(file, 'utf8')).includes(entrypoint), file);
}
assert.ok((await readFile('.github/workflows/check.yml', 'utf8')).includes(component));
assert.ok((await stat(entrypoint)).isFile());
console.log('PRIVATE_APPLICATION_STDOUT_NOT_A_PUBLIC_RECEIPT');
`,
  'package.json': `${JSON.stringify({
    name: 'custom-volume-service', private: true, type: 'module',
    scripts: { start: 'node legacy/service.mjs', test: 'node --test tests/quote.test.mjs', build: 'node scripts/check-layout.mjs' }
  }, null, 2)}\n`,
  Dockerfile: `FROM node:24-alpine
WORKDIR /app
COPY legacy /app/legacy
CMD ["node", "legacy/service.mjs"]
`,
  'docker-compose.yml': `services:
  api:
    build:
      context: .
      dockerfile: Dockerfile
    command: ["node", "legacy/service.mjs"]
    volumes:
      - ./legacy:/app/legacy
`,
  '.github/workflows/check.yml': `name: Application checks
on: [push]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - run: node --test tests/quote.test.mjs
      - run: node service.mjs
        working-directory: legacy
`,
  'docs/operations.md': '# Custom operations\n\nRun `node legacy/service.mjs`. The image copies `legacy` and preserves customer pricing.\n',
  'README.md': '# Custom application\n\nRun `node legacy/service.mjs` after the declared tests. Keep customer pricing.\n',
  'docs/unrelated.txt': 'Unrelated documentation and customer-owned text remain byte-identical.\n'
};

export const applicationFixtureExcluded: Record<string, string> = {
  '.env': 'DATABASE_PASSWORD=PRIVATE_LIVE_CREDENTIAL\n',
  'nested/.env.local': 'API_TOKEN=PRIVATE_NESTED_DOTENV\n',
  '.liftoff/governance/state.json': '{"proof":"PRIVATE_ACTIVATION_PROOF"}\n',
  'infrastructure/opentofu/azure/terraform.tfstate': '{"state":"PRIVATE_TERRAFORM_STATE"}\n',
  'nested/infrastructure/extra.json': '{"state":"PRIVATE_NESTED_INFRA"}\n',
  '.github/skills/custom/SKILL.md': 'PRIVATE_AGENT_CONTROL\n',
  '.github/prompts/liftoff-repair.prompt.md': 'PRIVATE_MANAGED_CONTROL\n',
  '.claude/commands/custom.md': 'PRIVATE_CLAUDE_CONTROL\n',
  '.git/objects/private': 'PRIVATE_GIT_OBJECT\n',
  'node_modules/private/index.js': 'PRIVATE_DEPENDENCY\n',
  'nested/credentials.json': '{"token":"PRIVATE_CREDENTIAL_FILE"}\n'
};

export async function putApplicationFixtureFile(root: string, parts: readonly string[], content: string | Buffer, mode = 0o644): Promise<void> {
  const target = path.join(root, ...parts);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  await chmod(target, mode);
}

export async function createApplicationRepairFixture(directory: string): Promise<{
  root: string; stage: string; manifest: LiftoffManifest;
}> {
  const root = path.join(directory, 'project'), stage = path.join(directory, 'stage');
  await mkdir(root, { recursive: true });
  await mkdir(stage, { mode: 0o700 });
  const plan = buildProjectPlan({
    projectName: 'custom-volume-service', projectType: 'standard', apiStack: 'node-fastify',
    cloud: 'azure', region: 'eastus', environments: ['dev'], specWorkflow: 'openspec',
    agents: ['github-copilot'], governanceProfile: 'none', includeFrontend: false
  }, { requireProjectName: true });
  const manifest = buildManifest(plan, buildArtifacts(plan));
  const recordedApp = manifest.projectArtifacts.find((item) => item.logicalName === 'node-backend-app')!;
  recordedApp.pathParts = ['legacy', 'service.mjs'];
  for (const [file, content] of Object.entries({ ...applicationFixtureSources, ...applicationFixtureExcluded })) {
    await putApplicationFixtureFile(root, file.split('/'), content);
  }
  await putApplicationFixtureFile(root, ['liftoff.manifest.json'], `${JSON.stringify(manifest, null, 2)}\n`);
  await putApplicationFixtureFile(root, ['liftoff.config.json'], '{"projectType":"standard","apiStack":"node-fastify"}\n');
  return { root, stage, manifest };
}

export const applicationFixtureCommands: ApplicationVerificationCommand[] = [
  { executable: 'node', args: ['--test', 'tests/quote.test.mjs'], cwdPathParts: [], timeoutMs: 10_000, maxOutputBytes: 16_384, network: false },
  { executable: 'node', args: ['scripts/check-layout.mjs'], cwdPathParts: [], timeoutMs: 10_000, maxOutputBytes: 16_384, network: false }
];

function remapReference(reference: ApplicationReference): string[] {
  const key = applicationPathKey(reference.targetPathParts);
  if (key === 'legacy/service.mjs') return ['backend', 'src', 'app.ts'];
  if (key === 'legacy/custom.mjs') return ['backend', 'src', 'custom.mjs'];
  if (key === 'legacy') return ['backend', 'src'];
  return [...reference.targetPathParts];
}

export async function stageApplicationRepairFixture(
  root: string, stage: string, manifest: LiftoffManifest
): Promise<{ patchPath: string; document: ApplicationPatchDocument }> {
  const inspection = await inspectApplicationLayout(root, manifest);
  if (!inspection.report.complete || !inspection.report.target) {
    throw new Error(`Fixture inventory failed: ${inspection.report.blockers.join('; ')}`);
  }
  const mappings: ApplicationPatchMapping[] = [];
  const orderedFiles = Object.keys(applicationFixtureSources).filter((file) => file !== 'docs/unrelated.txt');
  for (const [index, file] of orderedFiles.entries()) {
    const sourcePathParts = file.split('/');
    const source = inspection.snapshots.find((item) => applicationPathKey(item.pathParts) === file)!;
    const targetPathParts = file === 'legacy/service.mjs' ? ['backend', 'src', 'app.ts'] :
      file === 'legacy/custom.mjs' ? ['backend', 'src', 'custom.mjs'] : sourcePathParts;
    const exactTarget = inspection.report.target.artifacts.find((item) =>
      applicationPathKey(item.pathParts) === applicationPathKey(targetPathParts));
    const before = source.content!.toString('utf8');
    const after = before
      .replaceAll('legacy/service.mjs', 'backend/src/app.ts')
      .replaceAll('legacy/custom.mjs', 'backend/src/custom.mjs')
      .replaceAll('COPY legacy /app/legacy', 'COPY backend/src /app/backend/src')
      .replaceAll('./legacy:/app/legacy', './backend/src:/app/backend/src')
      .replaceAll('working-directory: legacy', 'working-directory: backend/src')
      .replaceAll('run: node service.mjs', 'run: node app.ts')
      .replaceAll("'legacy'", "'backend/src'")
      .replaceAll('`legacy`', '`backend/src`');
    const stagedPathParts = ['replacements', `${index.toString().padStart(2, '0')}.txt`];
    await putApplicationFixtureFile(stage, stagedPathParts, after, 0o600);
    mappings.push({
      sourcePathParts, targetPathParts, expectedSourceDigest: applicationDigest(source.content!),
      expectedSourceMode: source.mode!, stagedPathParts, targetMode: source.mode!,
      role: file.startsWith('legacy/') ? 'application' : 'reference',
      targetIdentity: { kind: exactTarget ? 'generated-artifact' : 'custom-component', logicalName: exactTarget?.logicalName ?? 'node-backend-app' },
      customization: before === after ? 'preserved' : 'reviewed-edit',
      references: inspection.report.references.filter((item) => applicationPathKey(item.sourcePathParts) === file).map((reference) => {
        const afterTargetPathParts = remapReference(reference);
        return {
          referenceId: reference.id,
          disposition: applicationPathKey(afterTargetPathParts) === applicationPathKey(reference.targetPathParts) ? 'unchanged-reviewed' : 'updated',
          afterTargetPathParts
        };
      })
    });
  }
  const document: ApplicationPatchDocument = {
    schemaVersion: 1, kind: 'liftoff-application-patch', projectRoot: inspection.report.projectRoot,
    inspectionDigest: inspection.report.inspectionDigest, targetLayoutDigest: inspection.report.target.digest,
    dynamicReferencesReviewed: true, unresolvedMappings: [], mappings,
    verification: { commands: structuredClone(applicationFixtureCommands) }
  };
  const patchPath = path.join(stage, 'patch.json');
  await putApplicationFixtureFile(stage, ['patch.json'], `${JSON.stringify(document, null, 2)}\n`, 0o600);
  return { patchPath, document };
}

export async function applicationVerificationFixtureContext(
  root: string, candidate: ApplicationPatchCandidate,
  permissions: { projectCode: boolean; dependencyPreparation: boolean; network: boolean },
  options: { env?: NodeJS.ProcessEnv; includeRawControls?: boolean } = {}
): Promise<ApplicationVerificationOptions> {
  const homedir = path.join(path.dirname(root), 'verification-records-home');
  await mkdir(homedir, { recursive: true, mode: 0o700 });
  const storage = { homedir, env: {}, repositoryRoot: root };
  const controls = options.includeRawControls === false ? [] : await Promise.all([
    captureProjectFileSnapshot(root, ['liftoff.manifest.json']),
    captureProjectFileSnapshot(root, ['liftoff.config.json'])
  ]);
  const approvedDigest = applicationCandidateDigest(candidate);
  const preview = buildRepairPreview({
    projectRoot: root, snapshots: [...candidate.snapshots, ...controls], mutations: candidate.mutations,
    scope: candidate.scope, recipe: 'application-layout-patch', applicationPatchPath: candidate.patchPath,
    verificationPolicy: candidate.verificationPolicy, live: false, now: new Date()
  });
  await createScopedUserLocalRecordStore(root, 'repair-preview', storage).write(preview.fingerprint, preview);
  return {
    preview, storage, env: options.env,
    allowProjectCode: permissions.projectCode, allowDependencyPreparation: permissions.dependencyPreparation,
    allowNetwork: permissions.network,
    assertCurrent: async () => {
      if (applicationCandidateDigest(candidate) !== approvedDigest ||
          canonicalSha256(candidate.verificationPolicy) !== preview.verificationDigest) throw new Error('Fixture approval changed.');
      for (const expected of controls) {
        const actual = await captureProjectFileSnapshot(root, expected.pathParts);
        if (actual.mode !== expected.mode || (actual.content === undefined) !== (expected.content === undefined) ||
            actual.content !== undefined && !actual.content.equals(expected.content!)) throw new Error('Fixture raw controls changed.');
      }
    }
  };
}
