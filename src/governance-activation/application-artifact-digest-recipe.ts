import { GitHubActivationError } from '../adapters/github/activation-rest.js';
import { types } from 'node:util';
import { canonicalSha256, isRecord } from '../domain/governance/activation/canonical-json.js';
import {
  applicationArtifactContextStep, applicationContextDirectory, applicationContextPaths
} from './application-artifact-context-recipe.js';

export const applicationArtifactDigestRecipeVersion = 'oci-digest-v1';
export const applicationArtifactDispatchInputNames = Object.freeze([
  'binding_digest', 'source_sha', 'context_path', 'dockerfile_path', 'image_repository', 'image_tag',
  'registry_id', 'client_id', 'subscription_id', 'tenant_id', 'environment'
]);

export interface ApplicationArtifactDigestRecipe {
  readonly version: typeof applicationArtifactDigestRecipeVersion;
  readonly builderName: string;
  readonly buildxVersion: string;
  readonly buildkitVersion: string;
}

export function applicationArtifactDigestRecipe(value: unknown): ApplicationArtifactDigestRecipe {
  if (types.isProxy(value) || !isRecord(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).some(key => typeof key !== 'string') ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some(field => !field.enumerable || !Object.hasOwn(field, 'value')) ||
    value.version !== applicationArtifactDigestRecipeVersion) {
    throw new GitHubActivationError('application-artifact-recipe-version',
      'Select the exact supported digest recipe version explicitly; missing, unknown or incompatible recipes cannot reuse legacy artifact authority.');
  }
  if (Object.keys(value).sort().join(',') !== 'builderName,buildkitVersion,buildxVersion,version' ||
    typeof value.builderName !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,62}$/u.test(value.builderName) ||
    typeof value.buildxVersion !== 'string' || !/^v[0-9]+\.[0-9]+\.[0-9]+$/u.test(value.buildxVersion) ||
    typeof value.buildkitVersion !== 'string' || !/^v[0-9]+\.[0-9]+\.[0-9]+$/u.test(value.buildkitVersion)) {
    throw new GitHubActivationError('application-artifact-recipe',
      'Digest recipes require only one exact existing builder and reviewed Buildx/BuildKit versions; commands, tag/cache writes and authority fields are prohibited.');
  }
  return Object.freeze({
    version: applicationArtifactDigestRecipeVersion, builderName: value.builderName,
    buildxVersion: value.buildxVersion, buildkitVersion: value.buildkitVersion
  });
}

export const applicationArtifactDigestBlockers = Object.freeze([
  'application-artifact-delivery-unavailable: Authenticated original program and reviewed-context delivery is not provided by the current artifact route.',
  'application-artifact-job-custody-unavailable: Whole-job protected host, registry authentication and source custody require their genuine producer; runner registration and local custody ports are insufficient.',
  'application-artifact-build-tool-unqualified: The selected existing Docker-container builder and complete build-tool closure have no independent whole-job qualification.',
  'application-artifact-attestation-effect-unallocated: GitHub attestation delivery requires an explicitly authorized GitHub write; the frozen artifact action/phase permits no such delegated effect.'
]);

const buildProgram = String.raw`node --input-type=module <<'LIFTOFF_APPLICATION_DIGEST'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const deadline = Date.now() + 12 * 60_000;
function object(text, label) {
  let value;
  try { value = JSON.parse(text); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error(label + ' returned invalid JSON; provider output was withheld.');
  }
  assert(value && typeof value === 'object', label + ' returned no object.');
  return value;
}
function capture(executable, args, label, build = false) {
  const remaining = deadline - Date.now();
  assert(remaining > 0, 'Application build exceeded its deadline; never rerun publication.');
  const result = spawnSync(executable, args, {
    timeout: Math.min(build ? 10 * 60_000 : 30_000, remaining), maxBuffer: 1024 * 1024,
    env: { ...process.env, DOCKER_CLI_HINTS: 'false', GH_DEBUG: '', AZURE_CORE_ONLY_SHOW_ERRORS: 'true',
      GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' }
  });
  assert(!result.error && result.status === 0 && result.signal === null,
    label + ' failed or exceeded its bound; output withheld. Publication may be partial; do not repeat it.');
  return result.stdout;
}
assert(process.platform === 'linux', 'This recipe requires its separately qualified Linux build host.');
assert(!process.env.DOCKER_HOST && !process.env.BUILDKIT_HOST &&
  (!process.env.DOCKER_CONTEXT || process.env.DOCKER_CONTEXT === 'default'),
  'Ambient remote builder overrides are prohibited.');
const recipe = object(process.env.LIFTOFF_DIGEST_RECIPE ?? 'null', 'Reviewed recipe');
const paths = object(process.env.LIFTOFF_CONTEXT_PATHS ?? 'null', 'Reviewed context');
assert(Array.isArray(paths) && paths.length > 0 && paths.length <= 512, 'Exact context files are required.');
const sha = process.env.LIFTOFF_SOURCE_SHA;
assert.match(sha ?? '', /^[a-f0-9]{40}$/u, 'Exact source SHA is required.');
assert.equal(process.env.LIFTOFF_CONTEXT_PATH, '.', 'Only the exact projected root context is supported.');
const workspace = process.env.GITHUB_WORKSPACE;
const temporary = process.env.RUNNER_TEMP;
const output = process.env.GITHUB_OUTPUT;
const dockerConfig = process.env.DOCKER_CONFIG;
const azureConfig = process.env.AZURE_CONFIG_DIR;
assert(workspace && temporary && output && dockerConfig && azureConfig,
  'Genuine job-owned paths and registry authentication are unavailable.');
for (const directory of [workspace, temporary, dockerConfig, azureConfig, process.cwd()]) {
  assert(path.isAbsolute(directory) && fs.realpathSync(directory) === directory &&
    fs.lstatSync(directory).isDirectory(), 'A job path changed or traverses linked parents.');
}
function contained(root, file) {
  const relative = path.relative(root, file);
  return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
assert(contained(temporary, process.cwd()) && contained(temporary, dockerConfig) &&
  contained(temporary, azureConfig) && (fs.lstatSync(dockerConfig).mode & 0o077) === 0 &&
  (fs.lstatSync(azureConfig).mode & 0o077) === 0 &&
  contained(temporary, output) && fs.realpathSync(output) === output &&
  fs.lstatSync(output).isFile(), 'Build, credential or output paths escaped the qualified temporary scope.');
const git = args => capture('git', ['-C', workspace, ...args], 'Immutable source readback');
assert.equal(git(['rev-parse', '--verify', 'HEAD']).toString('utf8').trim(), sha, 'Checkout source changed.');
const entries = git(['--literal-pathspecs', 'ls-tree', '-l', '-z', sha, '--', ...paths])
  .toString('utf8').split('\0').filter(Boolean);
assert.equal(entries.length, paths.length, 'Projected source membership changed.');
let total = 0;
const selected = new Set(paths);
for (const entry of entries) {
  const match = entry.match(/^(100644|100755) blob ([a-f0-9]{40}) +([0-9]+)\t(.+)$/u);
  assert(match && selected.delete(match[4]), 'Projected source is ambiguous or not an ordinary Git blob.');
  const file = path.resolve(match[4]);
  assert(contained(process.cwd(), file) && fs.realpathSync(file) === file, 'Projected source escaped or traverses a link.');
  const stat = fs.lstatSync(file);
  assert(stat.isFile() && stat.size === Number(match[3]) && stat.size <= 1024 * 1024 &&
    (stat.mode & 0o777) === (match[1] === '100755' ? 0o755 : 0o644), 'Projected source size or mode changed.');
  const bytes = fs.readFileSync(file);
  assert.equal(createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex'),
    match[2], 'Projected source bytes changed.');
  total += bytes.length;
}
assert(selected.size === 0 && total <= 8 * 1024 * 1024, 'Projected source exceeded its reviewed inventory.');
const dockerfile = process.env.LIFTOFF_DOCKERFILE_PATH;
assert(paths.includes(dockerfile), 'The Dockerfile is not in the exact reviewed context.');
const account = object(capture('az', ['account', 'show', '--subscription', process.env.LIFTOFF_SUBSCRIPTION_ID,
  '--query', '{id:id,tenantId:tenantId,user:user}', '--output', 'json'],
  'Qualified job principal').toString('utf8'), 'Job principal');
assert(account.id === process.env.LIFTOFF_SUBSCRIPTION_ID &&
  account.tenantId === process.env.LIFTOFF_TENANT_ID &&
  account.user?.type === 'servicePrincipal' && account.user?.name === process.env.LIFTOFF_CLIENT_ID,
  'The job principal, tenant or subscription differs from the reviewed binding.');
const registryId = process.env.LIFTOFF_REGISTRY_ID;
const registry = object(capture('az', ['acr', 'show', '--ids', registryId, '--subscription',
  process.env.LIFTOFF_SUBSCRIPTION_ID, '--query', '{id:id,loginServer:loginServer}', '--output', 'json'],
  'Exact registry readback').toString('utf8'), 'Registry');
assert.equal(registry.id, registryId, 'The canonical registry changed.');
assert.match(registry.loginServer ?? '', /^[a-z0-9]+(?:-[a-z0-9]+)?\.azurecr\.io$/u, 'Registry server is invalid.');
const repository = process.env.LIFTOFF_IMAGE_REPOSITORY;
assert.match(repository ?? '', /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/u, 'Exact image repository is required.');
const version = capture('docker', ['buildx', 'version'], 'Buildx identity').toString('utf8').trim().split(/\s+/u);
assert(version[0] === 'github.com/docker/buildx' && version[1] === recipe.buildxVersion,
  'The reviewed Buildx identity changed.');
const context = object(capture('docker', ['context', 'inspect', 'default'], 'Docker endpoint').toString('utf8'), 'Docker context');
assert(Array.isArray(context) && context.length === 1 &&
  context[0].Endpoints?.docker?.Host === 'unix:///var/run/docker.sock', 'The builder endpoint is not the qualified local host.');
const builder = capture('docker', ['buildx', 'inspect', recipe.builderName], 'Existing builder').toString('utf8');
function one(label, expected) {
  const values = builder.split(/\r?\n/u).filter(line => line.startsWith(label + ':'))
    .map(line => line.slice(label.length + 1).trim());
  assert(values.length === 1 && values[0] === expected, 'The reviewed existing builder ' + label + ' changed.');
}
one('Driver', 'docker-container');
one('Endpoint', 'default');
one('Status', 'running');
one('BuildKit version', recipe.buildkitVersion);
const directory = fs.mkdtempSync(path.join(temporary, 'liftoff-application-digest-'));
const metadata = path.join(directory, 'metadata.json');
const imageName = registry.loginServer + '/' + repository;
capture('docker', ['buildx', 'build', '--builder', recipe.builderName, '--platform', 'linux/amd64',
  '--provenance=false', '--sbom=false', '--progress=quiet', '--metadata-file', metadata,
  '--file', dockerfile, '--output',
  'type=image,name=' + imageName + ',push=true,push-by-digest=true,oci-mediatypes=true,store=false', '.'],
  'Digest-only application publication', true);
assert(fs.realpathSync(metadata) === metadata && fs.lstatSync(metadata).isFile() &&
  fs.lstatSync(metadata).size <= 64 * 1024, 'Actual build metadata is missing, linked or oversized.');
const actual = object(fs.readFileSync(metadata, 'utf8'), 'Actual build metadata');
const digest = actual['containerimage.digest'];
assert.match(digest ?? '', /^sha256:[a-f0-9]{64}$/u, 'Actual immutable build digest is unavailable.');
assert(Date.now() < deadline, 'Application build exceeded its deadline; never rerun publication.');
fs.appendFileSync(output, 'digest=' + digest + '\nimage_name=' + imageName + '\n');
LIFTOFF_APPLICATION_DIGEST`;

export function applicationArtifactDigestSteps(paths: readonly string[], value: ApplicationArtifactDigestRecipe) {
  paths = applicationContextPaths(paths);
  const recipe = applicationArtifactDigestRecipe(value);
  return [
    {
      uses: 'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
      with: { ref: '${{ inputs.source_sha }}', 'fetch-depth': 1, 'persist-credentials': false }
    },
    applicationArtifactContextStep(paths),
    {
      id: 'liftoff-digest',
      name: 'Build and publish application by digest',
      shell: 'bash',
      'working-directory': applicationContextDirectory,
      env: {
        LIFTOFF_DIGEST_RECIPE: JSON.stringify(recipe).replaceAll('$', '\\u0024'),
        LIFTOFF_CONTEXT_PATHS: JSON.stringify(paths).replaceAll('$', '\\u0024'),
        LIFTOFF_SOURCE_SHA: '${{ inputs.source_sha }}',
        LIFTOFF_CONTEXT_PATH: '${{ inputs.context_path }}',
        LIFTOFF_DOCKERFILE_PATH: '${{ inputs.dockerfile_path }}',
        LIFTOFF_REGISTRY_ID: '${{ inputs.registry_id }}',
        LIFTOFF_SUBSCRIPTION_ID: '${{ inputs.subscription_id }}',
        LIFTOFF_TENANT_ID: '${{ inputs.tenant_id }}',
        LIFTOFF_CLIENT_ID: '${{ inputs.client_id }}',
        LIFTOFF_IMAGE_REPOSITORY: '${{ inputs.image_repository }}'
      },
      run: buildProgram
    },
    {
      name: 'Attest the original digest through GitHub',
      uses: 'actions/attest-build-provenance@977bb373ede98d70efdf65b84cb5f73e068dcc2a',
      with: {
        'subject-name': '${{ steps.liftoff-digest.outputs.image_name }}',
        'subject-digest': '${{ steps.liftoff-digest.outputs.digest }}',
        'push-to-registry': false,
        'show-summary': false
      }
    }
  ];
}

export function applicationArtifactDigestWorkflow(
  paths: readonly string[], recipe: ApplicationArtifactDigestRecipe,
  runner: { runnerGroupName: string; runnerLabel: string }
) {
  return {
    name: 'Liftoff digest-only application artifact',
    'run-name': 'Liftoff application artifact ${{ inputs.binding_digest }}',
    concurrency: {
      group: 'liftoff-application-artifact-${{ inputs.binding_digest }}', 'cancel-in-progress': false
    },
    on: { workflow_dispatch: {
      inputs: Object.fromEntries(applicationArtifactDispatchInputNames.map(name => [name, { type: 'string', required: true }]))
    } },
    permissions: { contents: 'read', 'id-token': 'write', attestations: 'write' },
    jobs: { publish: {
      name: 'Liftoff application artifact',
      if: '${{ github.sha == inputs.source_sha && github.run_attempt == 1 }}',
      'runs-on': { group: runner.runnerGroupName, labels: [runner.runnerLabel] },
      'timeout-minutes': 20,
      steps: applicationArtifactDigestSteps(paths, recipe)
    } }
  };
}

export function assertApplicationArtifactDigestWorkflow(
  workflow: unknown, paths: readonly string[], recipe: ApplicationArtifactDigestRecipe,
  runner: { runnerGroupName: string; runnerLabel: string }
): void {
  if (canonicalSha256(workflow) !== canonicalSha256(applicationArtifactDigestWorkflow(paths, recipe, runner))) {
    throw new GitHubActivationError('application-artifact-digest-workflow',
      'The selected digest recipe requires its complete exact workflow, source projection, working directory, tool declarations and GitHub-only attestation step. Extra image/cache/tag writes, registry attestations, referrers fallback and unreviewed setup are prohibited.');
  }
}
