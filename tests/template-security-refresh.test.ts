import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parse as parseToml } from 'smol-toml';
import { resolvedTemplateAdvisories } from '../scripts/template-dependency-security.mjs';

const read = (parts: string) => readFileSync(new URL(`../${parts}`, import.meta.url), 'utf8');
const python = 'assets/plugins/python-fastapi';
const node = 'assets/plugins/node-fastify/node-backend';

function lockedVersion(source: string, name: string) {
  const entry = source.split(/(?=^\[\[package\]\]$)/m).find(section => section.includes(`\nname = "${name}"\n`));
  if (!entry) throw new Error(`Missing locked package ${name}`);
  return entry.match(/^version = "([^"]+)"$/m)?.[1];
}

describe('reviewed patched template dependency closure', () => {
  it.each(['python-standard', 'python-genai'])('pins official patched Certifi artifacts in %s', template => {
    const lock = parseToml(read(`${python}/${template}/uv.lock`)) as {
      version: number; revision: number; package: Array<Record<string, unknown>>;
    };
    expect(lock.version).toBe(1);
    expect(lock.revision).toBe(3);
    expect(lock.package.find(entry => entry.name === 'certifi')).toEqual({
      name: 'certifi',
      version: '2026.10.19',
      source: { registry: 'https://pypi.org/simple' },
      sdist: {
        url: 'https://files.pythonhosted.org/packages/a6/bd/1436c50cc46699de0230fbaacc1d1de7bfec413176099949e9d5112e88f2/certifi-2026.10.19.tar.gz',
        hash: 'sha256:035c1e85572b141bf1c3a3eff0e33a8eb74917522f2559075ff8d2fea780a1ae'
      },
      wheels: [{
        url: 'https://files.pythonhosted.org/packages/c4/51/29046e48f693c54e5b7412216d447a1d8362c9653148d98c02cdf65fa733/certifi-2026.10.19-py3-none-any.whl',
        hash: 'sha256:42d35340cc5b9ba78e818ddbff0c5b1c2b779de448a340fd1b989f5fa8670e1b'
      }]
    });
  });

  it('exports the same Certifi pin and both verified hashes without claiming a new global baseline', () => {
    const exported = read(`${python}/python-genai/function-requirements.txt`);
    expect(exported).toContain(
      '\ncertifi==2026.10.19 \\\n' +
      '    --hash=sha256:035c1e85572b141bf1c3a3eff0e33a8eb74917522f2559075ff8d2fea780a1ae \\\n' +
      '    --hash=sha256:42d35340cc5b9ba78e818ddbff0c5b1c2b779de448a340fd1b989f5fa8670e1b\n'
    );
    expect(exported).not.toContain('certifi==2026.7.22');
    const baseline = JSON.parse(read('assets/supported-stack.json'));
    expect([baseline.id, baseline.verifiedOn, baseline.packageManagers.uv.version])
      .toEqual(['2026.10.19', '2026-10-19', '0.12.7']);
  });

  it('pins patched Vite with its original dependency roles and tracks all six advisories for both inventories', () => {
    for (const [directory, inventoryId, group, requirement] of [
      [node, 'node-backend', 'devDependencies', '8.2.4'],
      ['assets/templates/common/frontend', 'standard-frontend', 'dependencies', '^8.2.4']
    ]) {
      const manifest = JSON.parse(read(`${directory}/package.json`));
      const lock = JSON.parse(read(`${directory}/package-lock.json`));
      expect(manifest[group].vite).toBe(requirement);
      expect(lock.packages[''][group]).toEqual(manifest[group]);
      expect(lock.packages['node_modules/vite']).toMatchObject({
        version: '8.2.4',
        resolved: 'https://registry.npmjs.org/vite/-/vite-8.2.4.tgz',
        integrity: 'sha512-lfauXnrf2x0p+UoA+wXh0dgFWnUjCyG6Js95KBkgaCwUU9k0DAHI4W6Q0WCx+h+5g+Alce1y4Zi2QjjK0UvGBw=='
      });
      if (group === 'dependencies') expect(manifest).not.toHaveProperty('devDependencies');
      expect(resolvedTemplateAdvisories.filter(entry => entry.manifestId === inventoryId &&
        ['GHSA-587H-7WMJ-H5PM', 'GHSA-698V-4R3X-3VCV', 'GHSA-9JRQ-W75R-8GCW',
          'GHSA-R825-W8MM-5PXW', 'GHSA-RQ7H-C2JC-7F22', 'GHSA-VFPM-58RQ-9QCG'].includes(entry.advisoryId)))
        .toHaveLength(6);
    }
  });

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

  it.each(['python-standard', 'python-genai'])('pins patched Mako in %s', (template) => {
    expect(lockedVersion(read(`${python}/${template}/uv.lock`), 'mako')).toBe('1.4.2');
  });

  it('keeps the patched GenAI SDK closure and Functions export on the same reviewed versions', () => {
    const lock = read(`${python}/python-genai/uv.lock`);
    const exported = read(`${python}/python-genai/function-requirements.txt`);
    for (const [name, version] of [
      ['mako', '1.4.2'], ['pydantic-ai-slim', '2.53.0'], ['pydantic-graph', '2.53.0'],
      ['werkzeug', '3.1.9'], ['openai', '3.35.1'], ['genai-prices', '0.1.13']
    ]) {
      expect(lockedVersion(lock, name)).toBe(version);
      expect(exported).toContain(`\n${name}==${version} \\\n`);
    }
    expect(read(`${python}/python-genai/pyproject.toml`)).toContain('"pydantic-ai-slim[openai]==2.53.0"');
    const baseline = JSON.parse(read('assets/supported-stack.json'));
    expect(baseline.id).toBe('2026.10.19');
    expect(baseline.pythonProjects['genai-backend'].dependencies['pydantic-ai-slim']).toBe('2.53.0');
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
