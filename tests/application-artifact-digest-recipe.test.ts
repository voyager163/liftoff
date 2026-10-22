import { Script } from 'node:vm';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { parse, stringify } from 'yaml';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NodeCommandRunner } from '../src/process-runner.js';
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
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function startupFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'liftoff-digest-preflight-')));
  roots.push(root);
  const bin = path.join(root, 'bin'), config = path.join(root, 'docker'), workspace = path.join(root, 'workspace');
  for (const directory of [bin, config, workspace]) fs.mkdirSync(directory, { mode: 0o700 });
  const commands = path.join(root, 'downstream-commands');
  for (const tool of ['git', 'az', 'docker']) {
    fs.writeFileSync(path.join(bin, tool),
      `#!/bin/sh\nprintf '%s\\n' '${tool}' >> '${commands}'\nexit 94\n`, { mode: 0o755 });
  }
  const marker = path.join(root, 'preload-executed'), preload = path.join(root, 'owned-preload.mjs');
  fs.writeFileSync(preload, `import { writeFileSync } from 'node:fs';\n` +
    `writeFileSync(${JSON.stringify(marker)}, 'owned preload executed');\nprocess.emitWarning('Owned startup control');\n`);
  return {
    root, commands, marker, preload, coverage: path.join(root, 'coverage'),
    cache: path.join(root, 'compile-cache'), warnings: path.join(root, 'warnings'),
    env: {
      PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
      HOME: root, DOCKER_CONFIG: config, RUNNER_TEMP: root, GITHUB_WORKSPACE: workspace
    }
  };
}
function hostileStartup(f: ReturnType<typeof startupFixture>) {
  return {
    NODE_OPTIONS: `--import=${pathToFileURL(f.preload).href}`, NODE_PATH: path.dirname(f.preload),
    NODE_V8_COVERAGE: f.coverage, NODE_COMPILE_CACHE: f.cache, NODE_REDIRECT_WARNINGS: f.warnings
  };
}
async function runShellStep(
  step: ReturnType<typeof applicationArtifactDigestSteps>[number], f: ReturnType<typeof startupFixture>,
  ambient: NodeJS.ProcessEnv = {}, applyStepEnvironment = true
) {
  if (!('run' in step) || typeof step.run !== 'string') throw new Error('Expected an actual shell step.');
  const environment = applyStepEnvironment && 'env' in step && step.env
    ? Object.fromEntries(Object.entries(step.env).map(([name, value]) =>
      [name, value === '${{ inputs.source_sha }}' ? 'a'.repeat(40) : value]))
    : {};
  return new NodeCommandRunner().run({
    executable: '/bin/bash', args: ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run]
  }, { cwd: f.root, inheritEnvironment: false, env: { ...f.env, ...ambient, ...environment },
    timeoutMs: 5_000, maxOutputBytes: 64 * 1024, stream: false, ensureProcessTreeSettled: true });
}
type Mutation = (workflow: Record<string, unknown>, job: Record<string, unknown>, steps: Record<string, unknown>[]) => void;
function recipeStep(steps: Record<string, unknown>[], id: string) {
  const step = steps.find(value => value.id === id || value.name === id);
  if (!step) throw new Error(`Missing actual recipe step: ${id}`);
  return step;
}
const mutations: { name: string; change: Mutation }[] = [
  { name: 'image tag', change: (_workflow, _job, steps) => {
    const build = recipeStep(steps, 'liftoff-digest');
    build.run = String(build.run).replace(',push=true,', ':candidate,push=true,');
  } },
  { name: 'registry cache tag', change: (_workflow, _job, steps) => {
    const build = recipeStep(steps, 'liftoff-digest');
    build.run = String(build.run).replace("'--provenance=false'", "'--cache-to=type=registry,ref=example.azurecr.io/cache:latest', '--provenance=false'");
  } },
  { name: 'inline push', change: (_workflow, _job, steps) => { recipeStep(steps, 'liftoff-digest').run += '\ndocker push example.azurecr.io/image:latest\n'; } },
  { name: 'implicit build provenance', change: (_workflow, _job, steps) => {
    const build = recipeStep(steps, 'liftoff-digest');
    build.run = String(build.run).replace('--provenance=false', '--provenance=true');
  } },
  { name: 'implicit SBOM', change: (_workflow, _job, steps) => {
    const build = recipeStep(steps, 'liftoff-digest');
    build.run = String(build.run).replace('--sbom=false', '--sbom=true');
  } },
  { name: 'registry attestation', change: (_workflow, _job, steps) => {
    recipeStep(steps, 'Attest the original digest through GitHub').with =
      { 'subject-digest': '${{ steps.liftoff-digest.outputs.digest }}', 'push-to-registry': true };
  } },
  { name: 'referrers tag fallback', change: (_workflow, _job, steps) => {
    recipeStep(steps, 'Attest the original digest through GitHub').env = { OCI_FORCE_REFERRERS_TAG: 'true' };
  } },
  { name: 'broad build directory', change: (_workflow, _job, steps) => { recipeStep(steps, 'liftoff-digest')['working-directory'] = '${{ github.workspace }}'; } },
  { name: 'changed projection', change: (_workflow, _job, steps) => { recipeStep(steps, 'liftoff-context').run += '\nprintf altered\n'; } },
  { name: 'mutable action', change: (_workflow, _job, steps) => { recipeStep(steps, 'Attest the original digest through GitHub').uses = 'actions/attest-build-provenance@v3'; } },
  { name: 'preflight after checkout', change: (_workflow, _job, steps) => { steps.unshift(steps.splice(1, 1)[0]!); } },
  { name: 'missing preflight', change: (_workflow, _job, steps) => { steps.shift(); } },
  { name: 'ignored preflight refusal', change: (_workflow, _job, steps) => { steps[0]!['continue-on-error'] = true; } },
  { name: 'unbounded preflight', change: (_workflow, _job, steps) => { delete steps[0]!['timeout-minutes']; } },
  { name: 'inherited preflight environment', change: (_workflow, _job, steps) => {
    steps[0]!.run = String(steps[0]!.run).replace('/usr/bin/env -i', '/usr/bin/env');
  } },
  { name: 'startup loader override', change: (_workflow, _job, steps) => { steps[0]!.env = { NODE_OPTIONS: '--import=unreviewed' }; } },
  { name: 'source after failed preflight', change: (_workflow, _job, steps) => { recipeStep(steps, 'liftoff-context').if = '${{ always() }}'; } },
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

  describe('complete workflow preflight order', () => {
    it('places refusal before checkout and context projection in the complete workflow', () => {
      const steps = applicationArtifactDigestWorkflow(paths, recipe, runner).jobs.publish.steps;
      expect(steps.map(step => 'id' in step ? step.id : step.uses)).toEqual([
        'liftoff-build-tool-preflight',
        'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
        'liftoff-context', 'liftoff-digest',
        'actions/attest-build-provenance@977bb373ede98d70efdf65b84cb5f73e068dcc2a'
      ]);
      expect(steps[0]).toMatchObject({ 'working-directory': '${{ runner.temp }}', 'timeout-minutes': 1 });
    });
  });
  describe.skipIf(process.platform === 'win32')('actual workflow preflight startup, not Linux-host qualification', () => {
    it('stops the actual ordered shell flow with zero downstream action/source/provider/build commands', async () => {
      const f = startupFixture(), entered: string[] = [];
      for (const step of applicationArtifactDigestSteps(paths, recipe)) {
        if ('uses' in step && step.uses) {
          entered.push(step.uses);
          continue;
        }
        entered.push('id' in step ? step.id! : 'shell');
        const result = await runShellStep(step, f);
        if (result.status !== 0) {
          expect(result.status).toBe(1);
          expect(result.stderr).toMatch(/tool closure.*unavailable|build-tool closure.*unavailable/u);
          break;
        }
      }
      expect(entered).toEqual(['liftoff-build-tool-preflight']);
      expect(fs.existsSync(f.commands)).toBe(false);
      expect(fs.readdirSync(f.root).some(name => name.startsWith('liftoff-application-context-'))).toBe(false);
    });
    it('proves the owned startup import and write hooks are effective without isolation', async () => {
      const f = startupFixture();
      const result = await new NodeCommandRunner().run({
        executable: process.execPath, args: ['--input-type=module', '--eval', '0']
      }, { cwd: f.root, inheritEnvironment: false, env: { ...f.env, ...hostileStartup(f) },
        timeoutMs: 5_000, maxOutputBytes: 64 * 1024, stream: false, ensureProcessTreeSettled: true });
      expect(result.status).toBe(0);
      for (const target of [f.marker, f.coverage, f.cache, f.warnings]) expect(fs.existsSync(target)).toBe(true);
    });
    it.each(['preload', 'coverage', 'compile-cache', 'warnings'] as const)(
      'isolates inherited %s before the first actual Node startup, even outside step env overrides', async hook => {
        const f = startupFixture();
        const first = applicationArtifactDigestSteps(paths, recipe).find(step => 'run' in step);
        if (!first) throw new Error('Missing actual workflow shell.');
        const result = await runShellStep(first, f, hostileStartup(f), false);
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/tool closure.*unavailable|build-tool closure.*unavailable/u);
        const target = { preload: f.marker, coverage: f.coverage, 'compile-cache': f.cache, warnings: f.warnings }[hook];
        expect(fs.existsSync(target)).toBe(false);
        expect(fs.existsSync(f.commands)).toBe(false);
        expect(result.stdout + result.stderr).not.toContain(f.root);
      }
    );
    it('also clears startup hooks in the step environment before Bash starts', async () => {
      const f = startupFixture(), startup = path.join(f.root, 'owned-shell-startup');
      const shellMarker = path.join(f.root, 'shell-startup-executed');
      fs.writeFileSync(startup, `printf '%s' 'executed' > '${shellMarker}'\n`);
      const first = applicationArtifactDigestSteps(paths, recipe)[0]!;
      const result = await runShellStep(first, f, { ...hostileStartup(f), BASH_ENV: startup, ENV: startup });
      expect(result.status).toBe(1);
      for (const target of [shellMarker, f.marker, f.coverage, f.cache, f.warnings, f.commands]) {
        expect(fs.existsSync(target)).toBe(false);
      }
      expect(result.stdout + result.stderr).not.toContain(f.root);
    });
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
      if (typeof data !== 'string') throw new Error('Expected exact context inventory environment.');
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
  it.each(['not-issued', 'qualified'])('never promotes a %s tool observation into build authority', qualification => {
    const preflight = applicationArtifactDigestSteps(paths, recipe)[0]!;
    if (!('run' in preflight) || typeof preflight.run !== 'string') throw new Error('Missing actual preflight program.');
    const prefix = "<<'LIFTOFF_APPLICATION_TOOL_PREFLIGHT'\n";
    const program = preflight.run.slice(preflight.run.indexOf(prefix) + prefix.length, -'\nLIFTOFF_APPLICATION_TOOL_PREFLIGHT'.length);
    const spawnSync = vi.fn((_executable: string, _args: readonly string[], _options: Record<string, unknown>) => ({
      status: 0, signal: null, stdout: JSON.stringify({
        status: 'observed', code: 'complete-closure-unavailable', qualification
      })
    }));
    const context = {
      spawnSync,
      console: { error: vi.fn() },
      process: {
        execPath: '/actual/node', exitCode: 0,
        env: {
          PATH: '/actual/bin', DOCKER_CONFIG: '/job/temporary/docker', LIFTOFF_DIGEST_RECIPE: JSON.stringify(recipe),
          NODE_OPTIONS: '--import=unreviewed', NODE_PATH: '/unreviewed', NODE_V8_COVERAGE: '/unreviewed',
          NODE_COMPILE_CACHE: '/unreviewed', NODE_REDIRECT_WARNINGS: '/unreviewed', PRIVATE_CREDENTIAL: 'withheld'
        }
      }
    };
    new Script(program.replace(/^import .+;\n/gmu, '')).runInNewContext(context);
    expect(context.process.exitCode).toBe(1);
    expect(context.console.error).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(
      qualification === 'not-issued' ? /Complete build-tool closure/ : /cannot issue build authority/
    ));
    expect(spawnSync.mock.calls).toHaveLength(1);
    expect(spawnSync.mock.calls[0]?.[0]).toBe('/actual/node');
    expect(spawnSync.mock.calls[0]?.[1]).toEqual(['--input-type=module']);
    expect(spawnSync.mock.calls[0]?.[2]).toMatchObject({
      input: expect.stringContaining('not-issued'), timeout: 30_000, maxBuffer: 64 * 1024, encoding: 'utf8',
      env: { PATH: '/actual/bin', DOCKER_CONFIG: '/job/temporary/docker', LIFTOFF_DIGEST_RECIPE: JSON.stringify(recipe) }
    });
    expect(Object.keys(spawnSync.mock.calls[0]?.[2].env ?? {}).sort())
      .toEqual(['DOCKER_CONFIG', 'LIFTOFF_DIGEST_RECIPE', 'PATH']);
  });
});
