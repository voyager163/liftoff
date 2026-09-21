import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

const expectedConfig = `version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    groups:
      root-minor-and-patch:
        applies-to: version-updates
        update-types:
          - minor
          - patch
    ignore:
      - dependency-name: "@types/node"
        update-types:
          - version-update:semver-major
  - package-ecosystem: npm
    directory: /services/telemetry-ingest
    schedule:
      interval: weekly
    groups:
      telemetry-minor-and-patch:
        applies-to: version-updates
        update-types:
          - minor
          - patch
    ignore:
      - dependency-name: "@types/node"
        update-types:
          - version-update:semver-major
  - package-ecosystem: npm
    directory: /assets/locks/node-backend
    schedule:
      interval: weekly
    groups:
      node-backend-minor-and-patch:
        applies-to: version-updates
        update-types:
          - minor
          - patch
    ignore:
      - dependency-name: "@types/node"
        update-types:
          - version-update:semver-major
  - package-ecosystem: npm
    directory: /assets/locks/frontend
    schedule:
      interval: weekly
    groups:
      frontend-minor-and-patch:
        applies-to: version-updates
        update-types:
          - minor
          - patch
  - package-ecosystem: uv
    directory: /assets/locks/python-standard
    schedule:
      interval: weekly
    groups:
      python-standard-minor-and-patch:
        applies-to: version-updates
        update-types:
          - minor
          - patch
  - package-ecosystem: uv
    directory: /assets/locks/python-genai
    schedule:
      interval: weekly
    groups:
      python-genai-minor-and-patch:
        applies-to: version-updates
        update-types:
          - minor
          - patch
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
`;

describe('Dependabot configuration', () => {
  it('groups owned npm and uv graphs while preserving branch and provenance boundaries', async () => {
    const config = (await readFile(
      path.resolve('.github', 'dependabot.yml'),
      'utf8'
    )).replaceAll('\r\n', '\n');

    expect(config).toBe(expectedConfig);
    expect(config).not.toContain('target-branch:');
    expect(config).not.toContain('/assets/power-apps-code-app/');
  });

  it('binds Python update entries to actual PEP 621 manifests and universal locks without duplicate worker jobs', async () => {
    const config = parseYaml(expectedConfig);
    expect(config.version).toBe(2);
    expect(config.updates).toHaveLength(7);
    for (const [name, extras] of [
      ['python-standard', ['test']], ['python-genai', ['functions', 'test']]
    ] as const) {
      const root = path.join(process.cwd(), 'assets', 'locks', name);
      const [manifest, lock] = await Promise.all([
        readFile(path.join(root, 'pyproject.toml'), 'utf8'),
        readFile(path.join(root, 'uv.lock'), 'utf8')
      ]);
      const parsed = parseToml(manifest);
      expect(parsed).toHaveProperty('project.requires-python', '>=3.14,<3.15');
      for (const extra of extras) expect(parsed).toHaveProperty(`project.optional-dependencies.${extra}`);
      expect(parseToml(lock)).toMatchObject({ version: 1, revision: 3, 'requires-python': '==3.14.*' });
      expect(config.updates).toContainEqual({
        'package-ecosystem': 'uv', directory: `/assets/locks/${name}`,
        schedule: { interval: 'weekly' },
        groups: { [`${name}-minor-and-patch`]: {
          'applies-to': 'version-updates', 'update-types': ['minor', 'patch']
        } }
      });
    }
  });

  it('records unsupported update surfaces without pretending that scans or hosted updater behavior passed', async () => {
    const capability = JSON.parse(await readFile(path.join(
      process.cwd(), 'security', 'dependency-update-capabilities.json'
    ), 'utf8'));
    expect(capability).toMatchObject({
      evidenceKind: 'read-only-upstream-source-inspection-not-hosted-execution',
      upstreamCommit: '6a3570b5be207c5bd2ea497c046805d47f71bb1e',
      uv: { status: 'prepared-not-hosted-qualified', runtimeVersion: '0.12.7' },
      go: { status: 'blocked-source-free-template-shape', scanExempt: false },
      providerAndImages: { scanExempt: false },
      defaultBranchTargeting: true, automaticApprovalOrMerge: false,
      hostedExecuted: false, enforced: false
    });
    expect(expectedConfig).not.toContain('package-ecosystem: gomod');
    expect(expectedConfig).not.toContain('package-ecosystem: pip');
    const baseline = JSON.parse(await readFile(path.join(process.cwd(), 'assets', 'supported-stack.json'), 'utf8'));
    expect(baseline.packageManagers.uv.version).toBe(capability.uv.runtimeVersion);
  });
});
