import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { installedCapabilities } from '../src/application/capabilities.js';
import { commandDefinitions } from '../src/cli/args/definitions.js';
import { parseArgs } from '../src/cli/args/parser.js';
import { buildCurrentProjectPlan } from '../src/application/project/planning.js';
import { parseProjectManifest } from '../src/application/project/manifest.js';
import { buildCurrentArtifacts } from '../src/templates.js';
import { modernActivationSourceContracts } from '../src/domain/governance/policy/identity.js';
import type { ModernMigrationJournalV2 } from '../src/governance-activation/modern-history-contracts.js';

describe('documented public command contracts', () => {
  it('documents doctor without an unsupported positional project path', async () => {
    const reference = await readFile(path.join(process.cwd(), 'docs/cli-reference.md'), 'utf8');
    const row = reference.split('\n').find(line => /^\|\s*`liftoff doctor\b/.test(line));
    const syntax = row?.match(/^\|\s*`([^`]+)`\s*\|/)?.[1];
    expect(syntax).toBe('liftoff doctor');
    expect(commandDefinitions.doctor.defaultMaxPositionals).toBe(0);
    expect(parseArgs(['doctor']).command).toBe('doctor');
    expect(() => parseArgs(['doctor', './selected-project'])).toThrow('Too many positional arguments for doctor');
  });

  it('documents fresh manifest writes from the actual advertised generation contract', async () => {
    const reference = await readFile(path.join(process.cwd(), 'docs/cli-reference.md'), 'utf8');
    const capabilities = installedCapabilities();
    const artifacts = buildCurrentArtifacts(buildCurrentProjectPlan({
      projectName: 'Documentation contract',
      projectType: 'standard',
      apiStack: 'node-fastify',
      cloud: 'azure',
      region: 'eastus',
      environments: ['dev'],
      includeFrontend: false,
      specWorkflow: 'manual',
      agents: [],
      governanceProfile: 'none'
    }, { requireProjectName: true }));
    const file = artifacts.find(artifact => artifact.logicalName === 'manifest');
    if (!file) throw new Error('Current generation did not produce a manifest.');
    const manifest = parseProjectManifest(JSON.parse(file.content));
    expect(manifest.artifactVersion).toBe(capabilities.schemas.currentGeneration.manifestWrite);
    expect(capabilities.schemas.manifestRead).toContain(manifest.artifactVersion);
    expect(reference).toContain(`Fresh project generation writes manifest v${manifest.artifactVersion}`);
    expect(reference).toContain('`plan`, `init`, and sibling `migrate`');
    expect(reference).not.toContain('All current writes use v7.');
    expect(reference).toContain('Historical manifest artifact versions v2 through v7 remain supported');
    expect(reference).toContain('individually known but unsupported tuples');
    expect(reference).toContain('phase-graph hashes block and report an upgrade');
    expect(reference).toContain('Exact known activation-v1 identity remains non-executable.');
    expect(reference).toContain('These are historical 0.6.x commands,\nnot current syntax:');
  });

  it.each([
    ['docs/getting-started.md', '## Maintain or repair an existing project'],
    ['docs/cli-reference.md', '### Migration from 0.6.x and earlier manifest readers']
  ])('keeps %s public successor guidance on the current record contract', async (file, heading) => {
    const document = await readFile(path.join(process.cwd(), file), 'utf8');
    const start = document.indexOf(`${heading}\n`);
    if (start < 0) throw new Error(`Missing successor guidance section: ${heading}`);
    const section = document.slice(start).split('\n## ')[0].replace(/\s+/g, ' ');
    const stateVersions = [...new Set(modernActivationSourceContracts().map(source => source.identity.activationStateSchemaVersion))];
    expect(stateVersions).toEqual([4]);
    const journalVersion: ModernMigrationJournalV2['schemaVersion'] = 2;
    const capabilities = installedCapabilities().schemas.currentUpdate;
    expect(section).toContain(`state${stateVersions[0]}/journal${journalVersion} and v${capabilities.manifestWrite} metadata`);
    expect(section).toContain('schemas.currentUpdate');
    expect(section).not.toContain('linked v3 activation');
    expect(section).not.toContain('establishing new v2 state');
  });
});
