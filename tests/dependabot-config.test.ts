import { readFile } from 'node:fs/promises';
import path from 'node:path';
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
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
`;

describe('Dependabot configuration', () => {
  it('groups owned npm graphs while preserving branch and provenance boundaries', async () => {
    const config = (await readFile(
      path.resolve('.github', 'dependabot.yml'),
      'utf8'
    )).replaceAll('\r\n', '\n');

    expect(config).toBe(expectedConfig);
    expect(config).not.toContain('target-branch:');
    expect(config).not.toContain('/assets/power-apps-code-app/');
  });
});
