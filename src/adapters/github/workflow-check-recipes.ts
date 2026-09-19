import { parseDocument } from 'yaml';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { GitHubActivationError, githubRef, object, text, type GitHubActivationClient } from './activation-rest.js';
import { controlledNodeTestPath, readbackValidationSource, type ObservedWorkflowContent } from './workflow-source-readback.js';

// Single-level and recursive selectors are distinct proof scopes.
export const protectedRefFamilies = ['develop', 'main', 'release/*', 'hotfix/*', 'release/**', 'hotfix/**'] as const;
export type ProtectedRefFamily = typeof protectedRefFamilies[number];
const defaultProtectedRefFamilies = ['develop', 'main', 'release/**', 'hotfix/**'] as const;
export type SourceCheckRecipe = 'node-test.v1' | 'vitest.v1' | 'pytest.v1' | 'go-test.v1';
export type SourceCheckDirectory = '.' | 'backend' | 'frontend';
type ValidationManifestPath = 'package.json' | 'backend/package.json' | 'frontend/package.json';

export interface RequiredWorkflowCheck {
  workflowPath: string;
  workflowId: number;
  workflowDigest: string;
  workflowBlobSha: string;
  producerSourceSha: string;
  jobId: string;
  context: string;
  validationStep: string;
  recipe: SourceCheckRecipe;
  workingDirectory: SourceCheckDirectory;
  validationManifest?: { path: ValidationManifestPath; digest: string; blobSha: string };
  fixtureArtifact?: { name: string; path: string; uploadStep: string };
  refFamilies: readonly ProtectedRefFamily[];
}

/** Opt in with these exact name/path values and one pinned always-run upload using if-no-files-found: error. */
export function sourceCheckFixtureArtifact(jobId: string, recipe: SourceCheckRecipe, directory: SourceCheckDirectory) {
  const path = recipe === 'node-test.v1' ? controlledNodeTestPath : recipe === 'vitest.v1' ? 'test/liftoff-repository-check.test.ts' :
    recipe === 'pytest.v1' ? 'tests/test_liftoff_repository_check.py' : 'test/liftoffcheck/validation_test.go';
  return { name: `liftoff-source-check-${jobId}-\${{ github.run_id }}`, path: directory === '.' ? path : `${directory}/${path}` };
}

export function isProtectedRefFamily(value: unknown): value is ProtectedRefFamily {
  return protectedRefFamilies.some((family) => family === value);
}

export function decodeWorkflow(content: string): Record<string, unknown> {
  if (Buffer.byteLength(content) > 256 * 1024) throw new GitHubActivationError('workflow-recipe', 'Workflow source exceeds the bounded recipe size.');
  try {
    const document = parseDocument(content, { uniqueKeys: true, strict: true });
    if (document.errors.length) throw new Error('Malformed workflow.');
    return object(document.toJS({ maxAliasCount: 0 }), 'Immutable workflow source');
  } catch {
    throw new GitHubActivationError('workflow-recipe', 'An immutable workflow must be a bounded unambiguous YAML document without aliases.');
  }
}

function readOnlyPermissions(value: unknown): boolean {
  if (value === 'read-all') return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).every((permission) => permission === 'read' || permission === 'none');
}

function runDefaults(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  const defaults = object(value);
  const run = object(defaults.run);
  if (Object.keys(defaults).some((key) => key !== 'run') ||
    Object.keys(run).some((key) => !['working-directory', 'shell'].includes(key)) ||
    run.shell !== undefined && run.shell !== 'bash' && run.shell !== 'sh') {
    throw new GitHubActivationError('check-directory', 'Source validation defaults must use bounded literal working directories and a supported shell.');
  }
  return run;
}

function workingDirectory(workflow: Record<string, unknown>, job: Record<string, unknown>, step: Record<string, unknown>): SourceCheckDirectory {
  const root = runDefaults(workflow.defaults), local = runDefaults(job.defaults);
  const directory = step['working-directory'] ?? local['working-directory'] ?? root['working-directory'] ?? '.';
  if (directory !== '.' && directory !== 'backend' && directory !== 'frontend') {
    throw new GitHubActivationError('check-directory', 'Registered source fixtures support only exact repository, backend or frontend roots; dynamic and escaping working directories are not authority.');
  }
  return directory;
}

function manifestPath(directory: SourceCheckDirectory): ValidationManifestPath {
  return directory === '.' ? 'package.json' : `${directory}/package.json`;
}

export function deriveRequiredNodeTestChecks(source: ObservedWorkflowContent, workflowId: number): RequiredWorkflowCheck[] {
  const checks = deriveChecks(source, workflowId);
  if (checks.some((check) => check.recipe !== 'node-test.v1')) throw new GitHubActivationError('check-recipe', 'The Node test recipe requires the actual node --test command.');
  return checks;
}

function deriveChecks(
  source: ObservedWorkflowContent, workflowId: number, manifests: ReadonlyMap<string, ObservedWorkflowContent> = new Map()
): RequiredWorkflowCheck[] {
  const workflow = decodeWorkflow(source.content);
  const events = object(workflow.on, 'Workflow trigger map');
  const trigger = object(events.pull_request, 'Required pull_request trigger');
  const branches = trigger.branches ?? defaultProtectedRefFamilies;
  if (Object.keys(events).some((event) => !['pull_request', 'push', 'workflow_dispatch'].includes(event)) ||
    Object.keys(trigger).some((key) => key !== 'branches') ||
    !Array.isArray(branches) || !branches.length || new Set(branches).size !== branches.length ||
    branches.some((branch) => !isProtectedRefFamily(branch)) ||
    workflow.env !== undefined ||
    !readOnlyPermissions(workflow.permissions) || /\bsecrets\s*[.[]/u.test(source.content)) {
    throw new GitHubActivationError('check-recipe', 'Source-check qualification requires explicit unfiltered protected ref families and read-only repository workflow permissions, not secret or deployment authority.');
  }
  const jobs = object(workflow.jobs, 'Required workflow jobs');
  if (!Object.keys(jobs).length || Object.keys(jobs).length > 32) throw new GitHubActivationError('check-recipe', 'The registered source-check recipe requires one to thirty-two real validation jobs.');
  const result = Object.entries(jobs).map(([jobId, value]) => {
    const job = object(value);
    const context = text(job.name ?? jobId, 'Actual check context');
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(jobId) || context.includes('${{') ||
      job.if !== undefined || job.strategy !== undefined || job.uses !== undefined || job.environment !== undefined ||
      job.env !== undefined || job.container !== undefined || job.services !== undefined ||
      job.needs !== undefined || job['continue-on-error'] !== undefined && job['continue-on-error'] !== false ||
      job.permissions !== undefined && !readOnlyPermissions(job.permissions) ||
      !['ubuntu-22.04', 'ubuntu-24.04', 'ubuntu-latest'].includes(String(job['runs-on'])) ||
      !Number.isSafeInteger(job['timeout-minutes']) || Number(job['timeout-minutes']) < 1 || Number(job['timeout-minutes']) > 15 ||
      !Array.isArray(job.steps) || !job.steps.length || job.steps.length > 32) {
      throw new GitHubActivationError('check-recipe', 'Conditional, matrix, reusable, deployment, unbounded or privileged jobs need a separately implemented exact qualification recipe.');
    }
    let validationStep: string | undefined;
    let recipe: SourceCheckRecipe | undefined;
    let fixtureArtifact: RequiredWorkflowCheck['fixtureArtifact'];
    let directory: SourceCheckDirectory = '.';
    let checkedOut = false;
    const names = new Set<string>();
    for (const raw of job.steps) {
      const step = object(raw);
      const name = text(step.name, 'Required explicit workflow step name');
      const fixtureUpload = typeof step.uses === 'string' && /^actions\/upload-artifact@[a-f0-9]{40}$/u.test(step.uses);
      if (names.has(name) || step.if !== undefined && !fixtureUpload || step['continue-on-error'] !== undefined ||
        step.uses !== undefined && step['working-directory'] !== undefined ||
        step.env !== undefined || name.includes('${{') ||
        step.shell !== undefined && step.shell !== 'bash' && step.shell !== 'sh') {
        throw new GitHubActivationError('check-recipe', 'Validation steps must have unique unconditional source-bound names and the repository working directory.');
      }
      names.add(name);
      if (fixtureUpload) {
        if (!validationStep || !recipe || fixtureArtifact || step.run !== undefined ||
          !['always()', '${{ always() }}'].includes(String(step.if))) {
          throw new GitHubActivationError('check-artifact-recipe', 'A source fixture artifact requires one exact pinned always-run upload after the registered validator.');
        }
        const options = object(step.with);
        const expected = sourceCheckFixtureArtifact(jobId, recipe, directory);
        if (options.name !== expected.name || options.path !== expected.path || options['if-no-files-found'] !== 'error' ||
          Object.keys(options).some((key) => !['name', 'path', 'if-no-files-found', 'retention-days'].includes(key)) ||
          options['retention-days'] !== undefined && (!Number.isSafeInteger(options['retention-days']) ||
            Number(options['retention-days']) < 1 || Number(options['retention-days']) > 7)) {
          throw new GitHubActivationError('check-artifact-recipe', 'Source artifact upload must name the exact registered controlled fixture path and run-bound artifact, without overwrite, missing-file success or arbitrary payload ownership.');
        }
        fixtureArtifact = { ...expected, uploadStep: name };
        continue;
      }
      const selected = step.run === 'node --test' ? 'node-test.v1' :
        ['npm test', 'npm run test'].includes(String(step.run)) ? 'vitest.v1' :
          ['uv run pytest', 'uv run pytest -q', 'uv run --frozen pytest', 'uv run --frozen pytest -q'].includes(String(step.run)) ? 'pytest.v1' :
            step.run === 'go test ./...' ? 'go-test.v1' : undefined;
      if (selected && step.uses === undefined) {
        if (validationStep || !checkedOut) throw new GitHubActivationError('check-recipe', 'A job must check out the exact PR source before its one real validation step.');
        validationStep = name;
        recipe = selected;
        directory = workingDirectory(workflow, job, step);
      } else if (!(step.uses === undefined && ['npm ci', 'uv sync --frozen', 'uv sync --frozen --all-extras', 'go mod download'].includes(String(step.run))) &&
        (step.run !== undefined || typeof step.uses !== 'string' ||
          !/^(?:actions\/(?:checkout|setup-node|setup-python|setup-go)|astral-sh\/setup-uv)@[a-f0-9]{40}$/u.test(step.uses))) {
        throw new GitHubActivationError('check-recipe', 'Registered source-check recipes permit immutable checkout/setup actions, locked dependency preparation and an exact Node/Vitest/pytest/Go validator.');
      }
      if (typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@')) {
        const options = step.with === undefined ? {} : object(step.with);
        if (checkedOut || Object.keys(options).some((key) => !['fetch-depth', 'persist-credentials', 'ref'].includes(key)) ||
          options.ref !== undefined && options.ref !== '${{ github.event.pull_request.head.sha }}') {
          throw new GitHubActivationError('check-checkout', 'Controlled qualification must check out this exact PR head or its default merge source, not another repository/ref/path or sparse source.');
        }
        checkedOut = true;
      }
    }
    if (!validationStep || !recipe) throw new GitHubActivationError('check-recipe', 'The workflow has no supported actual validation step; a check name alone is not a recipe.');
    const manifest = manifests.get(manifestPath(directory));
    if (recipe === 'vitest.v1') {
      let declaration: Record<string, unknown>;
      try { declaration = object(JSON.parse(manifest?.content ?? 'null')); } catch {
        throw new GitHubActivationError('check-manifest', 'npm test qualification requires the actual immutable package.json rather than assuming its test runner.');
      }
      const scripts = object(declaration.scripts);
      if (scripts.test !== 'vitest run' || scripts.pretest !== undefined || scripts.posttest !== undefined) {
        throw new GitHubActivationError('check-manifest', 'Only an exact source-bound vitest run npm test script is supported by this controlled recipe.');
      }
    }
    return {
      workflowPath: source.path, workflowId, workflowDigest: source.digest, workflowBlobSha: source.blobSha,
      producerSourceSha: source.sourceSha, jobId, context, validationStep, recipe, workingDirectory: directory,
      refFamilies: branches as ProtectedRefFamily[],
      ...(fixtureArtifact ? { fixtureArtifact } : {}),
      ...(recipe === 'vitest.v1' ? { validationManifest: { path: manifestPath(directory), digest: manifest!.digest, blobSha: manifest!.blobSha } } : {})
    };
  });
  if (new Set(result.map((check) => check.context)).size !== result.length) throw new GitHubActivationError('check-recipe', 'Duplicate real job contexts cannot be qualified unambiguously.');
  return result;
}

export async function deriveRequiredSourceChecks(
  client: GitHubActivationClient, repository: string, source: ObservedWorkflowContent, workflowId: number
): Promise<RequiredWorkflowCheck[]> {
  const workflow = decodeWorkflow(source.content);
  const paths = new Set<ValidationManifestPath>();
  for (const value of Object.values(object(workflow.jobs))) {
    const job = object(value);
    if (!Array.isArray(job.steps)) continue;
    for (const value of job.steps) {
      const step = object(value);
      if (['npm test', 'npm run test'].includes(String(step.run))) paths.add(manifestPath(workingDirectory(workflow, job, step)));
    }
  }
  const manifests = new Map<string, ObservedWorkflowContent>();
  for (const path of paths) manifests.set(path, await readbackValidationSource(client, repository, path, source.sourceSha));
  return deriveChecks(source, workflowId, manifests);
}

export function controlledNodeTestFixture(polarity: 'positive' | 'negative') {
  const content = [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    '',
    "test('reviewed Liftoff source-validation control', () => {",
    `  assert.equal(${polarity === 'positive' ? "'valid'" : "'controlled-invalid'"}, 'valid');`,
    '});',
    ''
  ].join('\n');
  return { path: controlledNodeTestPath, content, digest: canonicalSha256(content) };
}

export function controlledSourceCheckFixtures(checks: readonly RequiredWorkflowCheck[], polarity: 'positive' | 'negative') {
  return [...new Map(checks.map((check) => [`${check.workingDirectory}:${check.recipe}`, check])).values()].map(({ recipe, workingDirectory }) => {
    if (recipe === 'node-test.v1') return {
      ...controlledNodeTestFixture(polarity),
      path: workingDirectory === '.' ? controlledNodeTestPath : `${workingDirectory}/${controlledNodeTestPath}`
    };
    const file = recipe === 'vitest.v1' ? {
      path: 'test/liftoff-repository-check.test.ts',
      content: `import { expect, test } from 'vitest';\n\ntest('reviewed Liftoff source-validation control', () => {\n  expect('${polarity === 'positive' ? 'valid' : 'controlled-invalid'}').toBe('valid');\n});\n`
    } : recipe === 'pytest.v1' ? {
      path: 'tests/test_liftoff_repository_check.py',
      content: `def test_reviewed_liftoff_source_validation_control():\n    assert '${polarity === 'positive' ? 'valid' : 'controlled-invalid'}' == 'valid'\n`
    } : {
      path: 'test/liftoffcheck/validation_test.go',
      content: `package liftoffcheck\n\nimport "testing"\n\nfunc TestReviewedLiftoffSourceValidationControl(t *testing.T) {\n\tif "${polarity === 'positive' ? 'valid' : 'controlled-invalid'}" != "valid" {\n\t\tt.Fatal("reviewed controlled-invalid source-validation control")\n\t}\n}\n`
    };
    return { ...file, path: workingDirectory === '.' ? file.path : `${workingDirectory}/${file.path}`, digest: canonicalSha256(file.content) };
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

export function matchesProtectedRefFamily(ref: string, family: ProtectedRefFamily): boolean {
  if (!isProtectedRefFamily(family)) return false;
  const branch = githubRef(ref);
  if (family === 'develop' || family === 'main') return branch === family;
  const recursive = family.endsWith('/**');
  const prefix = family.slice(0, recursive ? -2 : -1);
  const suffix = branch.slice(prefix.length);
  return branch.startsWith(prefix) && suffix.length > 0 && (recursive || !suffix.includes('/'));
}
