import { Script } from 'node:vm';
import { parse, stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { isRecord } from '../src/domain/governance/activation/canonical-json.js';
import {
  applicationArtifactDigestBlockers, applicationArtifactDigestRecipe, applicationArtifactDigestSteps,
  applicationArtifactDigestWorkflow, assertApplicationArtifactDigestWorkflow
} from '../src/governance-activation/application-artifact-digest-recipe.js';

const recipe = {
  version: 'oci-digest-v1', builderName: 'reviewed-existing-builder',
  buildxVersion: 'v0.30.1', buildkitVersion: 'v0.26.2'
} as const;
const paths = ['Dockerfile', 'backend/${{ github.run_id }}.ts'];
const runner = { runnerGroupName: 'reviewed-group', runnerLabel: 'reviewed-label' };
type Mutation = (workflow: Record<string, unknown>, job: Record<string, unknown>, steps: Record<string, unknown>[]) => void;
const mutations: { name: string; change: Mutation }[] = [
  { name: 'image tag', change: (_workflow, _job, steps) => {
    steps[2]!.run = String(steps[2]!.run).replace(',push=true,', ':candidate,push=true,');
  } },
  { name: 'registry cache tag', change: (_workflow, _job, steps) => {
    steps[2]!.run = String(steps[2]!.run).replace("'--provenance=false'", "'--cache-to=type=registry,ref=example.azurecr.io/cache:latest', '--provenance=false'");
  } },
  { name: 'inline push', change: (_workflow, _job, steps) => { steps[2]!.run += '\ndocker push example.azurecr.io/image:latest\n'; } },
  { name: 'implicit build provenance', change: (_workflow, _job, steps) => {
    steps[2]!.run = String(steps[2]!.run).replace('--provenance=false', '--provenance=true');
  } },
  { name: 'implicit SBOM', change: (_workflow, _job, steps) => {
    steps[2]!.run = String(steps[2]!.run).replace('--sbom=false', '--sbom=true');
  } },
  { name: 'registry attestation', change: (_workflow, _job, steps) => {
    steps[3]!.with = { 'subject-digest': '${{ steps.liftoff-digest.outputs.digest }}', 'push-to-registry': true };
  } },
  { name: 'referrers tag fallback', change: (_workflow, _job, steps) => {
    steps[3]!.env = { OCI_FORCE_REFERRERS_TAG: 'true' };
  } },
  { name: 'broad build directory', change: (_workflow, _job, steps) => { steps[2]!['working-directory'] = '${{ github.workspace }}'; } },
  { name: 'changed projection', change: (_workflow, _job, steps) => { steps[1]!.run += '\nprintf altered\n'; } },
  { name: 'mutable action', change: (_workflow, _job, steps) => { steps[3]!.uses = 'actions/attest-build-provenance@v3'; } },
  { name: 'extra pre-build command', change: (_workflow, _job, steps) => { steps.unshift({ run: 'unreviewed setup' }); } },
  { name: 'extra job', change: (workflow) => { workflow.jobs = { publish: {}, side_effect: { steps: [{ run: 'publish a tag' }] } }; } },
  { name: 'ambient global environment', change: (workflow) => { workflow.env = { BUILDX_BUILDER: 'another-builder' }; } },
  { name: 'job credential override', change: (_workflow, job) => { job.env = { DOCKER_CONFIG: '/ambient/credentials' }; } },
  { name: 'service side effects', change: (_workflow, job) => { job.services = { unreviewed: { image: 'unreviewed:latest' } }; } },
  { name: 'missing attestation permission', change: (workflow) => { workflow.permissions = { contents: 'read' }; } },
  { name: 'broader workflow permission', change: (workflow) => { workflow.permissions = 'write-all'; } },
  { name: 'cancel original publication', change: (workflow) => { workflow.concurrency = { group: 'replacement', 'cancel-in-progress': true }; } }
];

describe('closed digest-only source recipe', () => {
  it('accepts only an explicit versioned declaration, not builder qualification or a capability issuer', () => {
    const parsed = applicationArtifactDigestRecipe(recipe);
    expect(parsed).toEqual(recipe);
    expect(parsed).not.toBe(recipe);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(applicationArtifactDigestBlockers.map(value => value.split(':')[0])).toEqual([
      'application-artifact-delivery-unavailable', 'application-artifact-job-custody-unavailable',
      'application-artifact-build-tool-unqualified', 'application-artifact-attestation-effect-unallocated'
    ]);
  });
  it.each([undefined, null, 'oci-digest-v1', {}, { version: 'legacy-v1' }, { version: 'oci-digest-v2' }])(
    'refuses missing, unknown or incompatible recipe selection %j', value => {
      expect(() => applicationArtifactDigestRecipe(value)).toThrow(/version/);
    }
  );
  it.each([
    { builderName: '--bootstrap' }, { builderName: 'builder; push' }, { buildxVersion: 'latest' },
    { buildkitVersion: '${{ inputs.version }}' }, { tag: 'candidate' }, { cacheTo: 'registry/image:cache' },
    { pushToRegistry: true }, { referrersTagFallback: true }, { qualified: true }, { issueAuthority: true }
  ])('refuses extra writes, commands or synthetic qualification %j', change => {
    expect(() => applicationArtifactDigestRecipe({ ...recipe, ...change })).toThrow(/Digest recipes require/);
  });
  it('refuses getters, proxies, symbols and inherited declarations without running their code', () => {
    let reads = 0;
    const accessor = { ...recipe, get builderName() { reads++; return recipe.builderName; } };
    const proxy = new Proxy(recipe, { get() { throw new Error('Caller proxy was executed.'); } });
    for (const value of [accessor, proxy, { ...recipe, [Symbol('authority')]: true }, Object.create(recipe)]) {
      expect(() => applicationArtifactDigestRecipe(value)).toThrow(/exact supported digest recipe version/);
    }
    expect(reads).toBe(0);
  });
  it('keeps literal source paths expression-inert in both projection and build environment data', () => {
    const steps = applicationArtifactDigestSteps(paths, recipe);
    for (const step of steps) {
      if (!('env' in step) || !step.env || !('LIFTOFF_CONTEXT_PATHS' in step.env)) continue;
      const data = step.env.LIFTOFF_CONTEXT_PATHS;
      expect(data).not.toContain('${{');
      expect(JSON.parse(data)).toEqual(paths);
      const serialized: unknown = parse(stringify(step));
      if (!isRecord(serialized) || !isRecord(serialized.env)) throw new Error('Expected exact serialized recipe environment.');
      expect(serialized.env.LIFTOFF_CONTEXT_PATHS).toBe(data);
    }
    expect(stringify(steps)).not.toContain('${{ github.run_id }}');
  });
  it('declares only digest image output, disables OCI attestations and plans GitHub delivery explicitly', () => {
    const workflow = applicationArtifactDigestWorkflow(paths, recipe, runner);
    expect(workflow.permissions).toEqual({ contents: 'read', 'id-token': 'write', attestations: 'write' });
    expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toHaveLength(11);
    expect(workflow.on.workflow_dispatch.inputs.image_tag).toEqual({ type: 'string', required: true });
    const steps = workflow.jobs.publish.steps;
    const build = steps.find(step => 'id' in step && step.id === 'liftoff-digest');
    if (!build || !('run' in build) || typeof build.run !== 'string') throw new Error('Missing actual recipe program.');
    expect(build.run).toContain('push-by-digest=true');
    expect(build.run).toContain("'--provenance=false', '--sbom=false'");
    expect(build.run).not.toMatch(/--tag|--cache-to|--cache-from|--format|--bootstrap|inputs\.image_tag/u);
    expect(build.run).toContain("one('Driver', 'docker-container')");
    expect(build.run).toContain("'--literal-pathspecs', 'ls-tree'");
    expect(build.run).toContain("createHash('sha1')");
    const prefix = "node --input-type=module <<'LIFTOFF_APPLICATION_DIGEST'\n";
    expect(build.run.startsWith(prefix)).toBe(true);
    expect(build.run.endsWith('\nLIFTOFF_APPLICATION_DIGEST')).toBe(true);
    const program = build.run.slice(prefix.length, -'\nLIFTOFF_APPLICATION_DIGEST'.length);
    expect(() => new Script(program.replace(/^import .+;\n/gmu, ''))).not.toThrow();
    expect(steps.at(-1)).toMatchObject({
      uses: 'actions/attest-build-provenance@977bb373ede98d70efdf65b84cb5f73e068dcc2a',
      with: { 'push-to-registry': false, 'subject-digest': '${{ steps.liftoff-digest.outputs.digest }}' }
    });
    expect(() => assertApplicationArtifactDigestWorkflow(parse(stringify(workflow)), paths, recipe, runner)).not.toThrow();
  });
  it.each(mutations)('refuses $name even when its YAML was separately hashed', ({ change }) => {
    const workflow: Record<string, unknown> = structuredClone(applicationArtifactDigestWorkflow(paths, recipe, runner));
    if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs.publish)) throw new Error('Expected exact recipe.');
    const job = workflow.jobs.publish, steps = job.steps;
    if (!Array.isArray(steps) || !steps.every(isRecord)) throw new Error('Expected exact steps.');
    change(workflow, job, steps);
    expect(() => assertApplicationArtifactDigestWorkflow(parse(stringify(workflow)), paths, recipe, runner))
      .toThrow(/complete exact workflow/);
  });
});
