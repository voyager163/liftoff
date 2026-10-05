import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const read = (parts: string) => readFileSync(new URL(`../${parts}`, import.meta.url), 'utf8');
const python = 'assets/plugins/python-fastapi';
const node = 'assets/plugins/node-fastify/node-backend';

function lockedVersion(source: string, name: string) {
  const entry = source.split(/(?=^\[\[package\]\]$)/m).find(section => section.includes(`\nname = "${name}"\n`));
  if (!entry) throw new Error(`Missing locked package ${name}`);
  return entry.match(/^version = "([^"]+)"$/m)?.[1];
}

describe('reviewed patched template dependency closure', () => {
  it('retains both required Linux checks and qualifies generated Node projects on all three native hosts', () => {
    const job = parseYaml(read('.github/workflows/ci.yml')).jobs['standard-node-templates'];
    expect(job.name).toBe('${{ matrix.check-name }}');
    expect(job['runs-on']).toBe('${{ matrix.os }}');
    expect(job['timeout-minutes']).toBe(30);
    expect(job.strategy['fail-fast']).toBe(false);
    expect(job.strategy.matrix.include).toEqual(['ubuntu-latest', 'macos-latest', 'windows-latest'].flatMap(os =>
      [['22.12.0', '10.9.4'], ['24.20.0', '12.0.2']].map(([node, npm]) => ({
        os, 'node-version': node, 'npm-version': npm,
        'check-name': os === 'ubuntu-latest' ? `Standard Node templates (npm ${npm})` : `Standard Node templates (${os}, npm ${npm})`
      }))
    ));
    expect(job.steps).toContainEqual(expect.objectContaining({
      name: 'Store actual generated-project qualification',
      with: expect.objectContaining({ 'if-no-files-found': 'error' })
    }));
    const names = job.steps.map((step: { name?: string }) => step.name);
    expect(names.indexOf('Install Liftoff dependencies')).toBeLessThan(names.indexOf('Capture the exact generated-project runtime'));
    expect(names.indexOf('Capture the exact generated-project runtime')).toBeLessThan(names.indexOf('Select the supported Liftoff generator runtime'));
    expect(names.indexOf('Select the supported Liftoff generator runtime')).toBeLessThan(names.indexOf('Verify standard Node.js templates'));
    expect(job.steps.find((step: { name?: string }) => step.name === 'Select the supported Liftoff generator runtime').with['node-version']).toBe('24.20.0');
    expect(parseYaml(read('.github/workflows/ci.yml')).jobs['test-shards'].steps.some(
      (step: { name?: string }) => step.name === 'Capture the exact generated-project runtime'
    )).toBe(false);
  });

  it.each(['python-standard', 'python-genai'])('pins patched urllib3 in %s', (template) => {
    expect(lockedVersion(read(`${python}/${template}/uv.lock`), 'urllib3')).toBe('2.8.0');
  });

  it('uses the same patched PyJWT and urllib3 in GenAI and the Functions export', () => {
    expect(lockedVersion(read(`${python}/python-genai/uv.lock`), 'pyjwt')).toBe('2.15.1');
    const exported = read(`${python}/python-genai/function-requirements.txt`);
    expect(exported).toContain('\npyjwt==2.15.1 \\\n');
    expect(exported).toContain('\nurllib3==2.8.0 \\\n');
    expect(exported).not.toMatch(/\n(?:pyjwt==2\.13\.0|urllib3==2\.7\.0)/);
  });

  it('binds Fastify and both fast-uri release lines to patched compatible versions', () => {
    const manifest = JSON.parse(read(`${node}/package.json`));
    const lock = JSON.parse(read(`${node}/package-lock.json`));
    const baseline = JSON.parse(read('assets/supported-stack.json')).npmProjects['node-backend'];
    expect(manifest.dependencies.fastify).toBe('^5.12.5');
    expect(lock.packages[''].dependencies).toEqual(manifest.dependencies);
    expect(lock.packages['node_modules/fastify'].version).toBe('5.12.5');
    expect(lock.packages['node_modules/fast-uri'].version).toBe('3.1.8');
    expect(lock.packages['node_modules/fast-json-stringify/node_modules/fast-uri'].version).toBe('4.2.1');
    expect(baseline.requirements.dependencies).toEqual(manifest.dependencies);
    expect(baseline.resolved.dependencies.fastify).toBe('5.12.5');
  });

  it('replaces only the retired loader esbuild dependency with its qualified patched version', () => {
    const manifest = JSON.parse(read(`${node}/package.json`));
    const lock = JSON.parse(read(`${node}/package-lock.json`));
    const policy = JSON.parse(read('security/template-dependency-exceptions.json'));
    expect(manifest.overrides).toEqual({ '@esbuild-kit/core-utils': { esbuild: '0.25.12' } });
    expect(lock.packages['node_modules/@esbuild-kit/core-utils/node_modules/esbuild'].version).toBe('0.25.12');
    expect(lock.packages['node_modules/@esbuild-kit/core-utils'].dependencies.esbuild).toBe('~0.18.20');
    expect(policy.exceptions).toHaveLength(0);
  });
});
