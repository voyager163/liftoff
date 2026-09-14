import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import { loadManifest, parseManifest } from '../src/application/project/manifest.js';
import { validateGeneratedProject } from '../src/application/diagnose/generated-project.js';
import { inspectProjectUpdate } from '../src/application/update/inspection.js';
import { planUpdateWrites } from '../src/application/update/write-plan.js';
import { writeProjectFile } from '../src/adapters/filesystem/project-files.js';
import {
  isManagedCoreLogicalName, managedCoreArtifactPaths, managedCoreLogicalNames,
  preAssessmentManagedCoreLogicalNames, preCodexManagedCoreLogicalNames,
  preRepairManagedCoreLogicalNames, repairManagedCoreLogicalNames
} from '../src/domain/project/artifact-lifecycle.js';
import { governanceAgentIntegrations, governanceArtifactPaths } from '../src/domain/project/catalog.js';
import type { ProjectOptions } from '../src/domain/project/contracts.js';
import { repairContractVersion, repairRecipes, repairSchemaVersions } from '../src/domain/repair/identity.js';
import { currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import { historicalActivationIdentities } from '../src/domain/governance/policy/identity.js';
import { validateGovernanceCompatibilityMetadata } from '../src/governance-activation/compatibility.js';
import { historicalMetadataPathParts } from '../src/governance-activation/history-contracts.js';
import { finalizeActivationHistoryMigration, planActivationHistoryMigration } from '../src/governance-activation/migration-history.js';
import {
  canonicalSha256, evidenceBodyDigest, evidenceContextForPhase, phaseIds, validateEvidenceHeader
} from '../src/governance-activation/index.js';
import { buildProjectPlan } from '../src/planner.js';
import { openSpecIntegrationPaths } from '../src/openspec-profile.js';
import { buildRepositoryGovernanceArtifacts } from '../src/repository-governance.js';
import { buildArtifacts } from '../src/templates.js';
import { liftoffVersion } from '../src/version.js';
import { CaptureStream } from './helpers.js';
import { writeHistoricalV1Fixture } from './fixtures/activation-v1/fixture.js';
import {
  cleanupUpdateTestRoots, createReviewedUpdateFixture, createUpdateTestRoot, fingerprintUpdateTestProject, updateTestPreviewOptions
} from './reviewed-update-helpers.js';

const agentIds = ['github-copilot', 'claude', 'codex'] as const;
const combinations = Array.from({ length: 7 }, (_, index) =>
  agentIds.filter((_, bit) => ((index + 1) & (1 << bit)) !== 0)
);
const repairIdentities = [
  { agent: 'github-copilot', logicalName: 'liftoff-repair-copilot', pathParts: ['.github', 'prompts', 'liftoff-repair.prompt.md'], invocation: '/liftoff-repair' },
  { agent: 'claude', logicalName: 'liftoff-repair-claude', pathParts: ['.claude', 'commands', 'liftoff-repair.md'], invocation: '/liftoff-repair' },
  { agent: 'codex', logicalName: 'liftoff-repair-codex', pathParts: ['.agents', 'skills', 'liftoff-repair', 'SKILL.md'], invocation: '$liftoff-repair' }
] as const;
const repairNames = new Set<string>(repairIdentities.map((entry) => entry.logicalName));
const sha = (content: string | Buffer) => `sha256:${createHash('sha256').update(content).digest('hex')}`;

function options(extra: Partial<ProjectOptions> = {}): ProjectOptions {
  return {
    projectName: 'Repair Integrations', projectType: 'standard', apiStack: 'node', cloud: 'azure',
    region: 'eastus', environments: ['dev'], includeFrontend: false, agents: [...agentIds], ...extra
  };
}

function rendered(extra: Partial<ProjectOptions> = {}) {
  return buildArtifacts(buildProjectPlan(options(extra), { requireProjectName: true }));
}

function manifestFrom(artifacts: ReturnType<typeof rendered>) {
  return JSON.parse(artifacts.find((artifact) => artifact.logicalName === 'manifest')!.content);
}

function nativeBody(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n\n/u, '').replace(/^#[^\n]*\n/u, '');
}

afterEach(cleanupUpdateTestRoots);

describe('selected native repair contracts', () => {
  for (const specWorkflow of ['openspec', 'spec-kit'] as const) {
    for (const governanceProfile of ['single-maintainer-gitflow', 'none'] as const) {
      it.each(combinations.map((agents) => [agents.join('+'), agents] as const))(
        `${specWorkflow}/${governanceProfile} renders only selected repair identities for %s`,
        (_label, agents) => {
          const artifacts = rendered({
            agents: [...agents], specWorkflow, governanceProfile,
            ...(specWorkflow === 'spec-kit' ? { defaultAgent: agents[0] } : {})
          });
          const selected = repairIdentities.filter((entry) => (agents as readonly string[]).includes(entry.agent));
          const repairs = artifacts.filter((artifact) => repairNames.has(artifact.logicalName));
          expect(repairs.map(({ logicalName, pathParts }) => ({ logicalName, pathParts })))
            .toEqual(selected.map(({ logicalName, pathParts }) => ({ logicalName, pathParts: [...pathParts] })));
          const manifest = parseManifest(manifestFrom(artifacts));
          for (const artifact of repairs) {
            expect(artifact.lifecycle).toBe('managed-core');
            expect(artifact.category).toBe('governance');
            expect(manifest.managedArtifacts).toContainEqual({
              logicalName: artifact.logicalName, category: 'governance',
              pathParts: artifact.pathParts, contentHash: sha(artifact.content)
            });
            expect(manifest.projectArtifacts.some((entry) => entry.logicalName === artifact.logicalName)).toBe(false);
            expect(artifact.content).not.toMatch(/skill[- ]?version|^version:|liftoff -repair|liftoff setup/miu);
          }
          if (governanceProfile === 'none') {
            expect(manifest.governance).toEqual({ profile: 'none', state: 'disabled' });
            expect(manifest.managedArtifacts.map((entry) => entry.logicalName)).toEqual(repairs.map((entry) => entry.logicalName));
            expect(artifacts.some((entry) => entry.pathParts[0] === 'governance' ||
              entry.pathParts[0] === '.liftoff' && entry.pathParts[1] === 'governance')).toBe(false);
          } else {
            const metadata = validateGovernanceCompatibilityMetadata(JSON.parse(artifacts.find((entry) =>
              entry.logicalName === 'repository-governance-compatibility')!.content), { agents });
            expect(metadata.schemaVersion).toBe(4);
            expect(metadata.managedCore.logicalNameAllowlist).toEqual(managedCoreLogicalNames);
            for (const artifact of repairs) {
              expect(metadata.managedCore.updateInventory).toContainEqual({
                logicalName: artifact.logicalName, pathParts: artifact.pathParts, lifecycle: 'managed-core',
                contentHashAuthority: 'liftoff.manifest.json managedArtifacts[].contentHash'
              });
            }
          }
        }
      );
    }
  }

  it('shares native bodies across all agents while keeping repair, setup and assessment separate', () => {
    const artifacts = buildRepositoryGovernanceArtifacts(buildProjectPlan(options(), { requireProjectName: true }));
    for (const operation of ['setup', 'assessment', 'repair'] as const) {
      const entries = agentIds.map((agent) => artifacts.find((entry) =>
        entry.logicalName === governanceAgentIntegrations[agent][operation].logicalName)!);
      expect(new Set(entries.map((entry) => nativeBody(entry.content))).size).toBe(1);
      for (const [index, entry] of entries.entries()) {
        expect(entry.content).toContain(`# ${governanceAgentIntegrations[agentIds[index]!][operation].invocation}\n`);
        expect(entry.content.length, entry.logicalName).toBeLessThan(operation === 'repair' ? 8_000 : operation === 'setup' ? 3_000 : 2_500);
      }
    }
    const repair = artifacts.find((entry) => entry.logicalName === 'liftoff-repair-copilot')!.content;
    expect([...repair.matchAll(/`(liftoff [^`]+)`/gu)][0]![1]).toBe('liftoff repair --capabilities --json');
    for (const phrase of [
      'before project access', `repairContractVersion: ${repairContractVersion}`, 'azure-local-layout` v1',
      '`schemaVersion: 1`', '`kind: liftoff-repair-capabilities`', '`cliVersion`',
      '`schemas`', '`recipes`', '`modes`',
      'application-layout-patch` v1', 'liftoff upgrade --check --json', 'Never emulate missing features',
      'command.executable', 'command.args', 'approvalRequired', 'current target artifact IDs',
      'imports/module paths', 'build/test', 'Docker/Compose', 'scripts, CI and documentation',
      '--inspect-layout --json', '--check --application-patch <external-patch.json> --json',
      'external isolated', 'staging OUTSIDE the project', 'Unresolved mappings or reference coverage remain plan-only',
      'NOT an OS or network sandbox', 'can affect the host and access the network',
      'Declaring `network: false` is not proof scripts cannot access the network',
      'independent consent', '--verify-plan <fingerprint> --json', '--allow-network',
      'ask SEPARATELY', '--approve-plan <fingerprint> --json', 'confined transaction alone',
      'interactive-repair', 'exact immutable plan', 'Yes/No, default No',
      'JSON/nonTTY bare repair previews only', 'No/Ctrl-C/EOF',
      'genuine input and stderr TTYs', 'exact explicit execution flags',
      'stale-after-prompt inputs refuse execution',
      'Mandatory isolation unsupported by this executor blocks verification',
      'no file transaction committed', 'Never report "nothing happened"',
      'Never use a generic yes flag or piped answers as authority',
      'Optional agent automation', 'Do not ask humans to copy hashes',
      'same immutable plan and action scopes the actual user separately approved',
      'Generic repair requests, unrelated approval, autopilot, agent-generated Yes and piped input grant no consent',
      "Azure recipe's registered reviewed manifest/history writes",
      'Missing tools, locks, or unsupported hooks/sources are explicit blockers',
      'Registered providers (npm-ci v1, uv-locked-sync v1, go-mod-download v1)',
      'lifecycle scripts suppressed (lifecycle: disabled)',
      '--allow-dependency-preparation',
      'manifest/provenance', 'Never fabricate evidence', 'private rollback material and immutable history',
      'inventory, proposed, verified and committed', 'Report only declared checks actually executed',
      'not full application/cloud conformance',
      "--recover --json` is only for the CLI's reported interrupted repair scope",
      'Governance none stays disabled'
    ]) expect(repair.replace(/\s+/gu, ' ')).toContain(phrase);
    expect(repair.indexOf('Prefer `liftoff repair <project>`')).toBeLessThan(repair.indexOf('Optional agent automation'));
    expect(repair.indexOf('`liftoff repair <project> --application-patch <external-patch.json>`'))
      .toBeLessThan(repair.indexOf('Optional agent automation'));
    expect(repair.indexOf('Optional agent automation')).toBeLessThan(repair.indexOf('--verify-plan'));
    expect(repair.indexOf('--verify-plan')).toBeLessThan(repair.indexOf('--approve-plan'));
    expect(repair).not.toContain('Bare repair also previews');
    expect(repair).toMatch(/allow-dependency-preparation/);
    expect(repair).toMatch(/npm-ci/);
    expect(repair).toMatch(/uv-locked-sync/);
    expect(repair).toMatch(/go-mod-download/);
    const setup = artifacts.find((entry) => entry.logicalName === 'liftoff-setup-copilot')!.content;
    expect(setup).toContain('separate native repair');
    expect(setup).toContain('liftoff governance resume --scope local --json');
    expect(setup.indexOf('liftoff update --check')).toBeLessThan(setup.indexOf('liftoff governance resume'));
    const assessment = artifacts.find((entry) => entry.logicalName === 'liftoff-governance-assess-copilot')!.content;
    expect(assessment).toContain('Do not invoke it, inventory source or stage a patch here');
    expect([...assessment.matchAll(/`(liftoff [^`]+)`/gu)].map((match) => match[1])).toEqual([
      'liftoff governance assess --json', 'liftoff governance assess --live --json'
    ]);
  });

  it('appends exact ownership and history paths without changing release, activation or repair identities', () => {
    expect(liftoffVersion).toBe('0.12.3');
    expect(currentActivationIdentity).toMatchObject({
      liftoffVersion: '0.12.0', manifestArtifactVersion: 7, policyVersion: '6',
      activationContractVersion: 3, phaseGraphSchemaVersion: 2, activationStateSchemaVersion: 3,
      evidenceHeaderSchemaVersion: 3, approvalEnvelopeSchemaVersion: 3
    });
    expect(managedCoreLogicalNames).toEqual([...preRepairManagedCoreLogicalNames, ...repairManagedCoreLogicalNames]);
    expect(preRepairManagedCoreLogicalNames).toHaveLength(12);
    for (const { agent, logicalName, pathParts, invocation } of repairIdentities) {
      expect(governanceAgentIntegrations[agent].repair).toEqual({ logicalName, pathParts, invocation });
      expect(managedCoreArtifactPaths.get(logicalName)).toEqual(pathParts);
      expect(isManagedCoreLogicalName(logicalName)).toBe(true);
      expect(historicalMetadataPathParts).toContainEqual(pathParts);
      expect(path.join('project', ...pathParts)).toBe(path.join('project', ...governanceArtifactPaths.repair[agent]));
    }
    for (const alias of ['liftoff-repair', 'liftoff-repair-other', 'liftoff-repair-copilot-extra', 'liftoff-repair-*']) {
      expect(isManagedCoreLogicalName(alias)).toBe(false);
    }
    expect(repairRecipes['application-layout-patch'].version).toBe(1);
    expect(repairSchemaVersions).toMatchObject({ report: 2, preview: 2, history: 2, journal: 2 });
  });
});

describe('exact repair manifest and compatibility readership', () => {
  it.each([3, 4, 5, 6, 7])('keeps old complete v%s manifests readable without requiring repair additions', (version) => {
    const value = manifestFrom(rendered());
    value.managedArtifacts = value.managedArtifacts.filter((entry: { logicalName: string }) => !repairNames.has(entry.logicalName));
    value.artifactVersion = version;
    if (version < 7) delete value.governance.activationIdentity;
    if (version < 5) delete value.governance;
    if (version < 6) {
      value.artifacts = [...value.managedArtifacts, ...value.projectArtifacts.map((entry: {
        logicalName: string; category: string; pathParts: string[]; generationHash: string;
      }) => ({ logicalName: entry.logicalName, category: entry.category, pathParts: entry.pathParts, contentHash: entry.generationHash }))];
      delete value.managedArtifacts;
      delete value.projectArtifacts;
    }
    if (version === 3) {
      const workload = value.project.workload;
      value.project = { ...value.project, ...workload, projectType: workload.kind };
      delete value.project.workload;
      delete value.project.kind;
    }
    const before = JSON.stringify(value);
    expect(parseManifest(value).managedArtifacts.some((entry) => repairNames.has(entry.logicalName))).toBe(false);
    expect(JSON.stringify(value)).toBe(before);
  });

  for (const governanceProfile of ['single-maintainer-gitflow', 'none'] as const) {
    it.each([
      ['path', { pathParts: ['.github', 'prompts', 'neighbor.prompt.md'] }, /invalid identity/],
      ['other agent path', { pathParts: ['.claude', 'commands', 'liftoff-repair.md'] }, /invalid identity/],
      ['category', { category: 'documentation' }, /invalid identity/],
      ['unselected agent', { logicalName: 'liftoff-repair-claude', pathParts: ['.claude', 'commands', 'liftoff-repair.md'] }, /inapplicable repair/],
      ['unknown name', { logicalName: 'liftoff-repair-other' }, /not an explicit managed-core/]
    ])(`${governanceProfile} rejects repair %s authority`, (_label, change, error) => {
      const value = manifestFrom(rendered({ agents: ['copilot'], governanceProfile }));
      Object.assign(value.managedArtifacts.find((entry: { logicalName: string }) =>
        entry.logicalName === 'liftoff-repair-copilot'), change);
      expect(() => parseManifest(value)).toThrow(error);
    });
  }

  it('rejects repair in legacy unselected manifests and project provenance', async () => {
    const legacy = JSON.parse(await readFile(path.join('tests', 'fixtures', 'manifest-v2.json'), 'utf8'));
    legacy.artifacts.push({
      logicalName: 'liftoff-repair-copilot', category: 'governance',
      pathParts: [...repairIdentities[0].pathParts], contentHash: sha('legacy')
    });
    expect(() => parseManifest(legacy)).toThrow(/inapplicable repair/);
    const value = manifestFrom(rendered({ governanceProfile: 'none' }));
    const repair = value.managedArtifacts.pop();
    value.projectArtifacts.push({
      logicalName: repair.logicalName, category: repair.category, pathParts: repair.pathParts,
      generationHash: repair.contentHash, generatedBy: liftoffVersion, provisioningGroup: 'base'
    });
    expect(() => parseManifest(value)).toThrow(/cannot contain a managed-core logical name/);
  });

  it('allows missing old repair inventories but distinguishes partial adoption from complete governance', () => {
    const value = manifestFrom(rendered());
    value.managedArtifacts = value.managedArtifacts.filter((entry: { logicalName: string }) => entry.logicalName !== 'liftoff-repair-codex');
    expect(() => parseManifest(value)).toThrow(/missing artifact liftoff-repair-codex/);
    value.governance.state = 'handoff-partial';
    expect(() => parseManifest(value)).not.toThrow();
    const disabled = manifestFrom(rendered({ governanceProfile: 'none' }));
    disabled.managedArtifacts.pop();
    expect(parseManifest(disabled).governance).toEqual({ profile: 'none', state: 'disabled' });
  });

  it.each([
    { label: 'pre-assessment', names: preAssessmentManagedCoreLogicalNames },
    { label: 'pre-Codex', names: preCodexManagedCoreLogicalNames },
    { label: 'pre-repair', names: preRepairManagedCoreLogicalNames }
  ])(
    'retains the $label exact allowlist without retagging records', ({ names }) => {
      const metadata = JSON.parse(rendered().find((entry) => entry.logicalName === 'repository-governance-compatibility')!.content);
      metadata.managedCore.logicalNameAllowlist = names;
      metadata.managedCore.updateInventory = metadata.managedCore.updateInventory.filter((entry: { logicalName: string }) => names.includes(entry.logicalName));
      metadata.managedCore.pathAllowlist = metadata.managedCore.updateInventory.map((entry: { pathParts: string[] }) => entry.pathParts);
      const before = JSON.stringify(metadata);
      expect(validateGovernanceCompatibilityMetadata(metadata).activation.historicalReadability.tuples).toEqual(historicalActivationIdentities);
      expect(JSON.stringify(metadata)).toBe(before);
    }
  );

  it.each(['unknown-name', 'wrong-path', 'duplicate', 'future-allowlist', 'future-schema', 'unselected-agent'])(
    'rejects %s in compatibility even without an expected full inventory', (kind) => {
      const metadata = JSON.parse(rendered({ agents: ['copilot'] }).find((entry) =>
        entry.logicalName === 'repository-governance-compatibility')!.content);
      const entry = metadata.managedCore.updateInventory.find((entry: { logicalName: string }) => entry.logicalName === 'liftoff-repair-copilot');
      if (kind === 'unknown-name') entry.logicalName = 'liftoff-repair-other';
      if (kind === 'wrong-path') entry.pathParts = ['.github', 'prompts', 'neighbor.prompt.md'];
      if (kind === 'duplicate') metadata.managedCore.updateInventory.push(entry);
      if (kind === 'future-allowlist') metadata.managedCore.logicalNameAllowlist.push('liftoff-repair-future');
      if (kind === 'future-schema') metadata.schemaVersion = 5;
      if (kind === 'unselected-agent') {
        entry.logicalName = 'liftoff-repair-claude';
        entry.pathParts = [...repairIdentities[1].pathParts];
      }
      expect(() => validateGovernanceCompatibilityMetadata(metadata, { agents: ['github-copilot'] })).toThrow();
    }
  );
});

async function removeRepairInventory(root: string, keepFiles = false) {
  const value = JSON.parse(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8'));
  value.managedArtifacts = value.managedArtifacts.filter((entry: { logicalName: string }) => !repairNames.has(entry.logicalName));
  if (value.governance.profile !== 'none') {
    const metadata = JSON.parse(await readFile(path.join(root, ...governanceArtifactPaths.compatibility), 'utf8'));
    metadata.managedCore.logicalNameAllowlist = [...preRepairManagedCoreLogicalNames];
    metadata.managedCore.updateInventory = metadata.managedCore.updateInventory.filter((entry: { logicalName: string }) => !repairNames.has(entry.logicalName));
    metadata.managedCore.pathAllowlist = metadata.managedCore.updateInventory.map((entry: { pathParts: string[] }) => entry.pathParts);
    const content = `${JSON.stringify(metadata, null, 2)}\n`;
    await writeProjectFile(root, governanceArtifactPaths.compatibility, content);
    value.managedArtifacts.find((entry: { logicalName: string }) =>
      entry.logicalName === 'repository-governance-compatibility').contentHash = sha(content);
  }
  await writeProjectFile(root, ['liftoff.manifest.json'], `${JSON.stringify(value, null, 2)}\n`);
  if (!keepFiles) await Promise.all(repairIdentities.map((entry) => rm(path.join(root, ...entry.pathParts), { force: true })));
}

async function fixture(governanceProfile: 'single-maintainer-gitflow' | 'none' = 'single-maintainer-gitflow') {
  const root = await createReviewedUpdateFixture(options({ governanceProfile }));
  for (const agent of agentIds) {
    for (const parts of openSpecIntegrationPaths(agent)) {
      await writeProjectFile(root, parts, '# Framework-owned fixture marker\n');
    }
  }
  return root;
}

async function update(root: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const code = await runCommand(parseArgs(['update', ...args, '--json']), {
    cwd: root, stdout, stderr, env, updatePreview: updateTestPreviewOptions(root),
    terminal: { layout: 'plain', color: false },
    runner: { async run() { throw new Error('Managed repair integration maintenance must not run project/provider commands.'); } }
  });
  return { code, report: JSON.parse(stdout.text()), error: stderr.text() };
}

async function approveUpdate(root: string, force = false, env?: NodeJS.ProcessEnv) {
  const preview = await update(root, ['--check']);
  expect(preview.code, JSON.stringify(preview.report)).toBe(2);
  const selected = preview.report.plans.find((entry: { mode: string }) => entry.mode === (force ? 'force' : 'normal'));
  expect(selected).toBeDefined();
  return update(root, [...(force ? ['--force'] : []), '--approve-plan', selected.fingerprint], env);
}

async function protectedFiles(root: string, governance: boolean) {
  const files: Array<{ pathParts: readonly string[]; content: string }> = [
    { pathParts: ['.github', 'prompts', 'liftoff-repair-extra.prompt.md'], content: '# Custom neighboring prompt\r\n' },
    { pathParts: ['.claude', 'commands', 'liftoff-repair-custom.md'], content: '# Custom neighboring command\n' },
    { pathParts: ['.agents', 'skills', 'liftoff-repair-custom', 'SKILL.md'], content: '# Custom neighboring skill\n' },
    { pathParts: ['backend', 'src', 'custom.ts'], content: 'export const customization = "preserved";\n' },
    { pathParts: ['.liftoff', 'repair-history', 'prior', 'receipt.json'], content: '{"schemaVersion":1,"recipe":"azure-local-layout-v1"}\n' }
  ];
  if (governance) {
    const timestamp = '2026-09-04T00:00:00.000Z';
    const state = {
      schemaVersion: 3, identity: currentActivationIdentity,
      repository: { id: 'R_repair', name: 'owner/repair-integrations', defaultBranch: 'develop' },
      activeChange: null, applicability: { statePath: 'bootstrap-local', privateStagingDast: true, credentialRequired: false },
      phases: Object.fromEntries(phaseIds.map((phase) => [phase, {
        state: 'pending', updatedAt: timestamp, evidence: [], approvals: [], blockers: []
      }])), createdAt: timestamp, updatedAt: timestamp
    };
    const context = evidenceContextForPhase('seed-valid', {
      repositoryId: state.repository.id, baselineSha: canonicalSha256('prior baseline'), inputDigest: canonicalSha256('prior input')
    });
    const payload = { kind: 'seed-valid.v1', validated: false };
    const evidence = {
      evidenceId: 'retained-repair-evidence', payload,
      header: validateEvidenceHeader({
        schemaVersion: 3, repositoryId: state.repository.id, identity: currentActivationIdentity,
        phaseGraphHash: context.phaseGraphHash, phaseId: context.phaseId, phaseContractDigest: context.phaseContractDigest,
        baselineSha: context.baselineSha, inputDigest: context.inputDigest, transition: context.transition,
        producedAt: timestamp, producer: 'repair-integration-fixture', result: 'failed', bodyDigest: evidenceBodyDigest(payload)
      })
    };
    files.push(
      { pathParts: ['governance', 'activation-state.json'], content: `${JSON.stringify(state, null, 2)}\n` },
      { pathParts: ['governance', 'evidence', 'retained-repair-evidence.json'], content: `${JSON.stringify(evidence, null, 2)}\n` }
    );
  }
  for (const file of files) await writeProjectFile(root, file.pathParts, file.content);
  return async () => {
    for (const file of files) expect(await readFile(path.join(root, ...file.pathParts), 'utf8')).toBe(file.content);
  };
}

describe('reviewed additive native repair installation', () => {
  it.each(['single-maintainer-gitflow', 'none'] as const)(
    'installs the old selected inventory only after approval with %s', async (governanceProfile) => {
      const root = await fixture(governanceProfile);
      await removeRepairInventory(root);
      const assertPreserved = await protectedFiles(root, governanceProfile !== 'none');
      const source = await loadManifest(root);
      const before = await fingerprintUpdateTestProject(root);
      expect(await validateGeneratedProject(root)).toEqual([]);
      const preview = await update(root, ['--check']);
      expect(preview.code).toBe(2);
      expect(preview.report.entries.filter((entry: { logicalName: string }) => repairNames.has(entry.logicalName)))
        .toEqual(repairIdentities.map((entry) => expect.objectContaining({
          logicalName: entry.logicalName, path: path.posix.join(...entry.pathParts), status: 'new'
        })));
      expect(await fingerprintUpdateTestProject(root)).toEqual(before);
      const unapproved = await update(root, []);
      expect(unapproved.code).toBe(1);
      expect(await fingerprintUpdateTestProject(root)).toEqual(before);
      const applied = await approveUpdate(root);
      expect(applied.code, JSON.stringify(applied.report)).toBe(0);
      const next = await loadManifest(root);
      expect(next.projectArtifacts).toEqual(source.projectArtifacts);
      expect(next.framework).toEqual(source.framework);
      expect(next.governance).toEqual(source.governance);
      expect(next.managedArtifacts.filter((entry) => repairNames.has(entry.logicalName))).toHaveLength(3);
      await assertPreserved();
      expect(await validateGeneratedProject(root)).toEqual([]);
      expect((await update(root, ['--check'])).code).toBe(0);
    }
  );

  it.each(['single-maintainer-gitflow', 'none'] as const)(
    'preserves an unowned repair collision under reviewed force with %s', async (governanceProfile) => {
      const root = await fixture(governanceProfile);
      await removeRepairInventory(root);
      const collision = repairIdentities[0];
      const custom = '# Project-owned repair command\r\nDo not overwrite.\r\n';
      await writeProjectFile(root, collision.pathParts, custom);
      const assertPreserved = await protectedFiles(root, governanceProfile !== 'none');
      for (const force of [false, true]) {
        const applied = await approveUpdate(root, force, {
          ...process.env, LIFTOFF_UPDATE_INJECT_FAILURE: `before-path:${path.posix.join(...collision.pathParts)}`
        });
        expect(applied.code, JSON.stringify(applied.report)).toBe(0);
        expect(applied.report.skipped).toContainEqual(expect.objectContaining({ logicalName: collision.logicalName, status: 'conflict' }));
        const manifest = await loadManifest(root);
        expect(manifest.managedArtifacts.some((entry) => entry.logicalName === collision.logicalName)).toBe(false);
        expect(manifest.governance.state).toBe(governanceProfile === 'none' ? 'disabled' : 'handoff-partial');
        expect(await readFile(path.join(root, ...collision.pathParts), 'utf8')).toBe(custom);
        await assertPreserved();
        expect(await validateGeneratedProject(root)).toEqual([]);
      }
    }
  );

  it('adopts identical unowned bytes and preserves managed-conflict reviewed force rules', async () => {
    const root = await fixture();
    const expected = await readFile(path.join(root, ...repairIdentities[2].pathParts));
    await removeRepairInventory(root, true);
    expect((await approveUpdate(root)).code).toBe(0);
    expect(await readFile(path.join(root, ...repairIdentities[2].pathParts))).toEqual(expected);
    const assertPreserved = await protectedFiles(root, true);
    await writeProjectFile(root, repairIdentities[2].pathParts, '# Customized managed repair\n');
    const inspection = await inspectProjectUpdate(root);
    expect(planUpdateWrites(inspection, false).mutations.some((entry) =>
      entry.pathParts.join('\0') === repairIdentities[2].pathParts.join('\0'))).toBe(false);
    expect(planUpdateWrites(inspection, true).mutations).toContainEqual({
      type: 'write', pathParts: [...repairIdentities[2].pathParts], content: expected.toString('utf8')
    });
    expect((await approveUpdate(root)).code).toBe(0);
    expect(await readFile(path.join(root, ...repairIdentities[2].pathParts), 'utf8')).toBe('# Customized managed repair\n');
    expect((await approveUpdate(root, true)).code).toBe(0);
    expect(await readFile(path.join(root, ...repairIdentities[2].pathParts))).toEqual(expected);
    await assertPreserved();
  });

  it('rejects an additive approval when an unowned destination appears after preview', async () => {
    const root = await fixture();
    await removeRepairInventory(root);
    const preview = await update(root, ['--check']);
    const selected = preview.report.plans.find((entry: { mode: string }) => entry.mode === 'normal');
    expect(selected).toBeDefined();
    await writeProjectFile(root, repairIdentities[0].pathParts, '# Newly occupied native command\n');
    const before = await fingerprintUpdateTestProject(root);
    expect((await update(root, ['--approve-plan', selected.fingerprint])).code).toBe(1);
    expect(await fingerprintUpdateTestProject(root)).toEqual(before);
    expect((await loadManifest(root)).managedArtifacts.some((entry) => repairNames.has(entry.logicalName))).toBe(false);
  });

  it('includes maintained repair integrations in immutable activation history without retagging old proof', async () => {
    const root = await createUpdateTestRoot();
    const historical = await writeHistoricalV1Fixture(root);
    const maintained = buildRepositoryGovernanceArtifacts(buildProjectPlan(options({ agents: ['copilot'] }), { requireProjectName: true }));
    const repair = maintained.find((entry) => entry.logicalName === 'liftoff-repair-copilot')!;
    const compatibility = maintained.find((entry) => entry.logicalName === 'repository-governance-compatibility')!;
    await writeProjectFile(root, repair.pathParts, repair.content);
    await writeProjectFile(root, compatibility.pathParts, compatibility.content);
    const manifest = JSON.parse(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8'));
    manifest.liftoffVersion = liftoffVersion;
    manifest.managedArtifacts.push({
      logicalName: repair.logicalName, category: repair.category, pathParts: repair.pathParts, contentHash: sha(repair.content)
    });
    manifest.managedArtifacts.find((entry: { logicalName: string }) =>
      entry.logicalName === compatibility.logicalName).contentHash = sha(compatibility.content);
    await writeProjectFile(root, ['liftoff.manifest.json'], `${JSON.stringify(manifest, null, 2)}\n`);
    const before = await fingerprintUpdateTestProject(root);
    const planned = await planActivationHistoryMigration(root);
    expect(planned.status, JSON.stringify(planned.status === 'blocked' ? planned.issues : {})).toBe('eligible');
    if (planned.status !== 'eligible') throw new Error('Expected an exact historical successor plan.');
    expect(planned.index.sourceIdentity).toEqual(historical.state.identity);
    const original = planned.index.files.find((entry) =>
      entry.originalPathParts.join('\0') === repair.pathParts.join('\0'));
    expect(original).toMatchObject({
      kind: 'metadata', digest: createHash('sha256').update(repair.content).digest('hex')
    });
    const finalized = finalizeActivationHistoryMigration(planned, 'a'.repeat(64), new Date('2026-09-04T00:00:00.000Z'));
    expect(finalized.mutations).toContainEqual(expect.objectContaining({
      type: 'write', pathParts: original!.copyPathParts, content: Buffer.from(repair.content)
    }));
    expect(await fingerprintUpdateTestProject(root)).toEqual(before);
    expect(await readFile(path.join(root, 'governance', 'activation-state.json')))
      .toEqual(historical.files.get('governance/activation-state.json'));
  });

  it('rolls back exact integration additions and all identity bytes on injected failure', async () => {
    const root = await fixture();
    await removeRepairInventory(root);
    const assertPreserved = await protectedFiles(root, true);
    const before = await fingerprintUpdateTestProject(root);
    const applied = await approveUpdate(root, false, {
      ...process.env, LIFTOFF_UPDATE_INJECT_FAILURE: `before-path:${path.posix.join(...repairIdentities[1].pathParts)}`
    });
    expect(applied.code).toBe(1);
    expect(await fingerprintUpdateTestProject(root)).toEqual(before);
    await assertPreserved();
    expect((await approveUpdate(root)).code).toBe(0);
    await assertPreserved();
  });

  it('rejects unsafe repair destinations before either reviewed write plan', async () => {
    const root = await fixture();
    await removeRepairInventory(root);
    const outside = path.join(path.dirname(root), 'outside-repair');
    await mkdir(outside);
    await writeProjectFile(outside, ['SKILL.md'], 'unowned outside bytes\n');
    const destination = path.join(root, ...repairIdentities[2].pathParts.slice(0, -1));
    await rm(destination, { recursive: true });
    await symlink(outside, destination, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(inspectProjectUpdate(root)).rejects.toThrow(/symbolic|symlink|unsafe|regular/iu);
    expect(await readFile(path.join(outside, 'SKILL.md'), 'utf8')).toBe('unowned outside bytes\n');
  });
});
