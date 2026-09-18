import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { nativeExecutableObserver } from '../src/adapters/filesystem/executables.js';
import { createScopedUserLocalRecordStore } from '../src/adapters/filesystem/update-previews.js';
import * as projectCatalog from '../src/application/project/catalog.js';
import {
  buildComponentMaintenanceManifest, buildComponentManagedArtifacts, componentDesiredState,
  componentMaintenancePlan, renderComponentGovernanceContext
} from '../src/application/project/component-artifacts.js';
import { loadManifest, parseManifest } from '../src/application/project/manifest.js';
import { buildProjectPlan } from '../src/application/project/planning.js';
import { applicationBounds } from '../src/application/repair/application-types.js';
import { inspectAdoptionFramework, readPreparedAdoptionFramework } from '../src/application/project-evolution/adoption/framework.js';
import { inspectAdoption } from '../src/application/project-evolution/adoption/planning.js';
import { parseAdoptionFramework, parseAdoptionProposal, type AdoptionProposal } from '../src/application/project-evolution/adoption/proposal.js';
import { managedCoreArtifactPaths } from '../src/domain/project/artifact-lifecycle.js';
import type { LiftoffManifestV8 } from '../src/domain/project/contracts.js';
import { manifestPortablePath } from '../src/domain/project/manifest/current.js';
import type { AdoptionFrameworkBinding, AdoptionRecord } from '../src/domain/project-evolution/adoption/contracts.js';
import { validateAdoptionRecord } from '../src/domain/project-evolution/adoption/record-reader.js';
import { NodeCommandRunner, type CommandRunner } from '../src/process-runner.js';
import { buildArtifacts, buildManifest } from '../src/templates.js';
import {
  adoptionFixtureClock, adoptionFixtureProposal, adoptionFixtureStorage, arrayField, createAdoptionFixture,
  firstObject, invokeAdoptionFixture, objectField, objectValue, stringField, type AdoptionFixture
} from './adoption-fixtures.js';
import { ReadyInitRunner } from './helpers.js';

type Mutation = readonly [string, (value: Record<string, unknown>) => void, RegExp];
const roots: string[] = [];
let proposal: AdoptionProposal;
let manifest: LiftoffManifestV8;
let governed: LiftoffManifestV8;
let generated: LiftoffManifestV8;
let record: AdoptionRecord;
let frameworkFixture: AdoptionFixture;
let frameworkBinding: AdoptionFrameworkBinding;
let frameworkRecordId: string;
let frameworkCreatedAt: string;
let frameworkHeader: Record<string, unknown>;
const frameworkRecords = new Map<string, unknown>();
const encoded = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8');
const copiedObject = (value: unknown) => objectValue(structuredClone(value));

beforeAll(async () => {
  const metadataFixture = await createAdoptionFixture(roots);
  proposal = await adoptionFixtureProposal(metadataFixture);
  const preview = await invokeAdoptionFixture(metadataFixture, { profile: 'vue-component', check: true });
  expect(preview.code, preview.stderr).toBe(2);
  if (!preview.report.plan) throw new Error('Missing real adoption preview.');
  const applied = await invokeAdoptionFixture(metadataFixture, { approvePlan: preview.report.plan.fingerprint });
  expect(applied.code, applied.report.blockers.join(' ')).toBe(0);
  const current = await loadManifest(metadataFixture.root);
  if (current.artifactVersion !== 8 || current.provenance.kind !== 'adopted') throw new Error('Missing committed adopted manifest.');
  manifest = current;
  record = validateAdoptionRecord(JSON.parse(await readFile(
    path.join(metadataFixture.root, '.liftoff', 'adoption-history', current.provenance.recordId, 'record.json'), 'utf8'
  )), { recordId: current.provenance.recordId, standards: current.standards, assessmentDigest: current.provenance.observationDigest });

  const plan = buildProjectPlan({
    projectName: 'generated-boundary', projectType: 'standard', apiStack: 'node-fastify',
    includeFrontend: false, agents: ['github-copilot'], governanceProfile: 'none'
  }, { requireProjectName: true });
  const generatedValue = parseManifest(buildManifest(plan, buildArtifacts(plan)));
  if (generatedValue.artifactVersion !== 8) throw new Error('Expected current generated writer.');
  generated = generatedValue;
});

let frameworkSetup: Promise<void> | undefined;
const ensureFrameworkFixture = () => frameworkSetup ??= prepareFrameworkFixture();
async function prepareFrameworkFixture(): Promise<void> {
  frameworkFixture = await createAdoptionFixture(roots);
  const frameworkProposal = await adoptionFixtureProposal(frameworkFixture);
  frameworkProposal.framework = {
    workflow: 'openspec', agents: ['github-copilot', 'claude', 'codex'], initialize: true, copilotCloud: false
  };
  frameworkProposal.governanceProfile = 'single-maintainer-gitflow';
  const proposalPath = path.join(frameworkFixture.staging, 'proposal.json');
  await writeFile(proposalPath, JSON.stringify(frameworkProposal));
  const originalResolve = nativeExecutableObserver.resolve.bind(nativeExecutableObserver);
  const resolver = vi.spyOn(nativeExecutableObserver, 'resolve').mockImplementation(async (name, context) =>
    name === 'openspec'
      ? { executable: name, resolution: 'resolved', resolvedPath: process.execPath, realPath: process.execPath, kind: 'executable', origin: 'standalone', evidence: 'path-search' }
      : originalResolve(name, context));
  const contract = new ReadyInitRunner(), real = new NodeCommandRunner();
  const runner: CommandRunner = {
    run: async (command, options) => {
      if (options?.cwd?.endsWith(`${path.sep}project`) && ['init', '--version'].includes(command.args[0] ?? '')) {
        return { ...await contract.run({ executable: 'openspec', args: command.args }, options), processTreeSettled: true };
      }
      return real.run(command, options);
    }
  };
  try {
    const inspection = await inspectAdoption({
      project: frameworkFixture.root, proposal: proposalPath, now: adoptionFixtureClock,
      storage: adoptionFixtureStorage(frameworkFixture), runner
    });
    if (!inspection.framework) throw new Error('Missing official staged framework binding.');
    frameworkBinding = inspection.framework.binding;
    const initial = await invokeAdoptionFixture(frameworkFixture, { proposal: proposalPath, check: true }, { runner });
    expect(initial.report.blockers).toEqual([]);
    if (!initial.report.plan) throw new Error('Missing framework preview.');
    const staged = await invokeAdoptionFixture(frameworkFixture, {
      verifyPlan: initial.report.plan.fingerprint, allowNetwork: true
    }, { runner });
    expect(staged.report.blockers).toEqual([]);
    if (!staged.report.plan) throw new Error('Missing exact-byte framework plan.');
    frameworkRecordId = staged.report.plan.recordId;
    frameworkCreatedAt = staged.report.plan.createdAt;
    const committed = await invokeAdoptionFixture(frameworkFixture, { approvePlan: staged.report.plan.fingerprint }, { runner });
    expect(committed.code, committed.report.blockers.join(' ')).toBe(0);
    const result = await loadManifest(frameworkFixture.root);
    if (result.artifactVersion !== 8 || result.provenance.kind !== 'adopted') throw new Error('Missing reviewed component handoff.');
    governed = result;
  } finally {
    resolver.mockRestore();
  }
  const store = createScopedUserLocalRecordStore(frameworkFixture.root, 'adoption-framework', adoptionFixtureStorage(frameworkFixture));
  const saved = await store.read(frameworkRecordId);
  if (!saved) throw new Error('Missing real prepared framework receipt.');
  frameworkHeader = objectValue(saved.value);
  frameworkRecords.set(frameworkRecordId, saved.value);
  for (const value of arrayField(frameworkHeader, 'files')) {
    const key = stringField(objectValue(value), 'key');
    const chunk = await store.read(key);
    if (!chunk) throw new Error('Missing real prepared framework bytes.');
    frameworkRecords.set(key, chunk.value);
  }
}

afterAll(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('adoption proposal admission boundaries', () => {
  it('round-trips the current observed metadata proposal without changing its inputs', () => {
    expect(parseAdoptionProposal(encoded(proposal))).toEqual(proposal);
  });

  it.each([
    ['an array root', Buffer.from('[]')],
    ['duplicate JSON fields', Buffer.from('{"schemaVersion":1,"schemaVersion":1}')],
    ['invalid UTF-8', Buffer.from([0xff])],
    ['over-bound input', Buffer.alloc(applicationBounds.patchBytes + 1, 32)]
  ])('rejects %s before deriving any proposal authority', (_name, bytes) => {
    expect(() => parseAdoptionProposal(bytes)).toThrow(/schema-1|UTF-8|64 KiB/);
  });

  it.each<Mutation>([
    ['unknown operation permission', (value) => { value.force = true; }, /documented/],
    ['another schema', (value) => { value.schemaVersion = 2; }, /exact project/],
    ['relative root', (value) => { value.projectRoot = 'relative'; }, /exact project/],
    ['unreviewed references', (value) => { value.dynamicReferencesReviewed = false; }, /reference review/],
    ['missing source digest', (value) => { delete value.inspectionDigest; }, /current inspection/],
    ['noncanonical source digest', (value) => { value.inspectionDigest = `${value.inspectionDigest}\n`; }, /current inspection/],
    ['empty project name', (value) => { value.projectName = ' '; }, /exact project/],
    ['controlled project name', (value) => { value.projectName = 'name\n'; }, /exact project/],
    ['unsupported governance', (value) => { value.governanceProfile = 'invented'; }, /metadata decisions/],
    ['nonportable profile ID', (value) => { value.profile = 'Vue'; }, /portable logical/],
    ['profile ID with a trailing newline', (value) => { value.profile = 'vue-component\n'; }, /portable logical/],
    ['missing addition inventory', (value) => { delete value.additions; }, /bounded explicit/],
    ['oversized addition inventory', (value) => { value.additions = Array.from({ length: applicationBounds.mappings + 1 }, () => ({})); }, /bounded explicit/],
    ['missing check inventory', (value) => { delete objectField(value, 'verification').commands; }, /bounded array/],
    ['oversized check inventory', (value) => { objectField(value, 'verification').commands = Array.from({ length: applicationBounds.commands + 1 }, () => ({})); }, /bounded array/],
    ['standalone preparation', (value) => {
      objectField(value, 'verification').preparation = [{
        provider: 'npm-ci', version: 1, cwdPathParts: [], packageSource: 'microsoft-npm', network: true, lifecycle: 'disabled'
      }];
    }, /serve explicit staged checks/]
  ])('rejects %s with the production proposal reader', (_name, mutate, error) => {
    const value = copiedObject(proposal);
    mutate(value);
    expect(() => parseAdoptionProposal(encoded(value))).toThrow(error);
  });

  it.each<Mutation>([
    ['an unbounded timeout', (value) => { value.timeoutMs = applicationBounds.commandTimeoutMs + 1; }, /bounded literal argv/],
    ['missing output bound', (value) => { delete value.maxOutputBytes; }, /bounded literal argv/],
    ['unbounded argv', (value) => { value.args = Array.from({ length: 33 }, () => 'test'); }, /bounded literal argv/],
    ['nonliteral argv', (value) => { value.args = [7]; }, /bounded literal argv/],
    ['undeclared network intent', (value) => { value.network = 'false'; }, /bounded literal argv/],
    ['an escaping working directory', (value) => { value.cwdPathParts = ['..']; }, /path|relative|traversal/i]
  ])('rejects checks with %s', (_name, mutate, error) => {
    const value = copiedObject(proposal);
    const command: Record<string, unknown> = {
      executable: 'node', args: ['check.mjs'], cwdPathParts: [], timeoutMs: 1000, maxOutputBytes: 1024, network: false
    };
    mutate(command);
    objectField(value, 'verification').commands = [command];
    expect(() => parseAdoptionProposal(encoded(value))).toThrow(error);
  });

  it('keeps exact candidate references and identical-addition intent in a parsed proposal', () => {
    const value = copiedObject(proposal);
    value.additions = [{
      logicalName: 'existing-feature', componentId: 'application', targetPathParts: ['feature.mjs'],
      stagedPathParts: ['feature.mjs'], targetMode: 0o600, precondition: 'identical',
      references: [{ referenceId: 'a'.repeat(64), disposition: 'updated', afterTargetPathParts: ['value.mjs'] }]
    }];
    objectField(value, 'verification').commands = [{
      executable: 'node', args: ['check.mjs'], cwdPathParts: [], timeoutMs: 1000, maxOutputBytes: 1024, network: false
    }];
    const parsed = parseAdoptionProposal(encoded(value));
    expect(parsed.additions[0]?.precondition).toBe('identical');
    expect(parsed.additions[0]?.references[0]?.afterTargetPathParts).toEqual(['value.mjs']);
    firstObject(value, 'additions').targetMode = 0o1000;
    expect(() => parseAdoptionProposal(encoded(value))).toThrow(/ordinary modes/);
  });

  it.each(['missing', 'unregistered', 'noncanonical'] as const)('rejects %s addition reference review', (kind) => {
    const value = copiedObject(proposal);
    value.additions = [{
      logicalName: 'feature', componentId: 'application', targetPathParts: ['feature.mjs'], stagedPathParts: ['feature.mjs'],
      targetMode: 0o600, precondition: 'absent', references: [{
        referenceId: kind === 'missing' ? '' : kind === 'noncanonical' ? `${'a'.repeat(64)}\n` : 'a'.repeat(64),
        disposition: kind === 'unregistered' ? 'ignored' : 'updated', afterTargetPathParts: ['value.mjs']
      }]
    }];
    expect(() => parseAdoptionProposal(encoded(value))).toThrow(/exact observed candidate IDs/);
  });
});

describe('adoption framework selection boundaries', () => {
  it.each(['project', 'staging'] as const)('refuses a framework executable owned by the %s without running it', async (location) => {
    const current = await createAdoptionFixture(roots);
    const executable = path.join(location === 'project' ? current.root : current.staging, 'local-openspec');
    await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    vi.spyOn(nativeExecutableObserver, 'resolve').mockResolvedValue({
      executable: 'openspec', resolution: 'resolved', resolvedPath: executable, realPath: executable,
      kind: 'executable', origin: 'standalone', evidence: 'path-search'
    });
    const run = vi.fn(async () => { throw new Error('Project/staging executables cannot become trusted framework tools.'); });
    await expect(inspectAdoptionFramework({
      workflow: 'openspec', agents: ['github-copilot'], initialize: true, copilotCloud: false
    }, current.root, current.staging, { runner: { run }, env: {} })).rejects.toThrow(/installed outside the project\/staging boundary/);
    expect(run).not.toHaveBeenCalled();
    expect(await readdir(current.root)).not.toContain('liftoff.manifest.json');
  });

  it('accepts a canonical Spec Kit target without claiming it was executed', () => {
    const selection = {
      workflow: 'spec-kit', agents: ['github-copilot', 'claude', 'codex'], defaultAgent: 'codex', initialize: true, copilotCloud: true
    };
    expect(parseAdoptionFramework(selection)).toEqual(selection);
  });

  it.each<Mutation>([
    ['unknown workflow', (value) => { value.workflow = 'custom'; }, /explicit workflow/],
    ['nonstring agent', (value) => { value.agents = [1]; }, /canonical agents/],
    ['agent alias', (value) => { value.agents = ['copilot']; }, /exact canonical/],
    ['duplicate agent', (value) => { value.agents = ['github-copilot', 'github-copilot']; }, /unique exact/],
    ['unknown agent', (value) => { value.agents = ['invented']; }, /exact canonical/],
    ['default on OpenSpec', (value) => { value.defaultAgent = 'github-copilot'; }, /inconsistent/],
    ['unknown default', (value) => { value.defaultAgent = 'invented'; }, /inconsistent/],
    ['unselected default', (value) => { value.workflow = 'spec-kit'; value.defaultAgent = 'codex'; }, /inconsistent/],
    ['missing Spec Kit default', (value) => { value.workflow = 'spec-kit'; }, /inconsistent/],
    ['cloud Copilot without Copilot', (value) => { value.agents = ['claude']; value.copilotCloud = true; }, /inconsistent/],
    ['invented initialization', (value) => { value.initialize = false; }, /inconsistent/],
    ['unknown field', (value) => { value.install = true; }, /documented/]
  ])('rejects %s', (_name, mutate, error) => {
    const value: Record<string, unknown> = {
      workflow: 'openspec', agents: ['github-copilot'], initialize: true, copilotCloud: false
    };
    mutate(value);
    expect(() => parseAdoptionFramework(value)).toThrow(error);
  });
});

describe('truthful adopted component maintenance boundaries', () => {
  beforeAll(ensureFrameworkFixture, 90_000);

  it('renders the reviewed three-host handoff without backend, cloud or generation claims', () => {
    const desired: unknown = JSON.parse(componentDesiredState(governed));
    const plan = componentMaintenancePlan(governed, desired);
    const context = objectValue(JSON.parse(renderComponentGovernanceContext(plan)));
    expect(objectField(context, 'project').workloadFacts).toEqual({ kind: 'components' });
    expect(objectField(context, 'applicability').cloud).toBe('not-declared');
    expect(objectField(context, 'generatedBoundaries').application).toBe('not-generated');
    expect(objectField(context, 'policy').liveEnforcement).toBe('not-active');
    const artifacts = buildComponentManagedArtifacts(plan);
    for (const artifact of artifacts) {
      expect(artifact.lifecycle).toBe('managed-core');
      expect(artifact.pathParts).toEqual(managedCoreArtifactPaths.get(artifact.logicalName));
    }
    expect(artifacts.some((artifact) => artifact.pathParts.join('/') === '.github/skills/liftoff-setup/SKILL.md')).toBe(false);
    const next = buildComponentMaintenanceManifest(governed, plan, artifacts);
    expect(parseManifest(next)).toEqual(next);
    expect(next.projectArtifacts).toEqual(governed.projectArtifacts);
    expect(next.provenance).toEqual(governed.provenance);
    expect(governed.project.workload).toEqual({ kind: 'components' });
  });

  it('keeps an uninitialized metadata-only component truthful', () => {
    const plan = componentMaintenancePlan(manifest, JSON.parse(componentDesiredState(manifest)));
    expect(objectField(objectValue(JSON.parse(renderComponentGovernanceContext(plan))), 'framework').state).toBe('uninitialized');
    expect(buildComponentManagedArtifacts(plan)).toEqual([]);
    const next = buildComponentMaintenanceManifest(manifest, plan, []);
    expect(next.governance).toEqual({ profile: 'none', state: 'disabled' });
    expect(next.projectArtifacts).toEqual(manifest.projectArtifacts);
  });

  it('refuses generated provenance rather than treating it as an adopted component', () => {
    expect(() => componentMaintenancePlan(generated, JSON.parse(componentDesiredState(generated)))).toThrow(/actual adopted provenance/);
  });

  it.each<Mutation>([
    ['unknown config field', (value) => { value.force = true; }, /retain its exact/],
    ['another schema', (value) => { value.schemaVersion = 2; }, /retain its exact/],
    ['renamed project', (value) => { value.projectName = 'different'; }, /retain its exact/],
    ['changed components', (value) => { value.components = []; }, /retain its exact/],
    ['missing workflow', (value) => { delete value.specWorkflow; }, /Changing an adopted framework/],
    ['another workflow', (value) => { value.specWorkflow = 'spec-kit'; }, /Changing an adopted framework/],
    ['missing agents', (value) => { delete value.agents; }, /Changing recorded component agent/],
    ['changed agents', (value) => { value.agents = []; }, /Changing recorded component agent/],
    ['changed default', (value) => { value.defaultAgent = 'codex'; }, /Changing recorded component agent/],
    ['unknown governance', (value) => { value.governanceProfile = 'custom'; }, /unsupported governance profile/],
    ['malformed governance', (value) => { value.governanceProfile = 7; }, /unsupported governance profile/]
  ])('refuses %s as ordinary managed maintenance', (_name, mutate, error) => {
    const value = objectValue(JSON.parse(componentDesiredState(governed)));
    mutate(value);
    expect(() => componentMaintenancePlan(governed, value)).toThrow(error);
  });

  it('surfaces loss of a registered selected agent without inventing a replacement', () => {
    vi.spyOn(projectCatalog, 'getCodingAgent').mockReturnValue(undefined);
    expect(() => componentMaintenancePlan(governed, JSON.parse(componentDesiredState(governed)))).toThrow(/Unsupported recorded agent/);
  });
});

describe('strict current manifest scalar and identity boundaries', () => {
  it.each<Mutation>([
    ['non-object standards', (value) => { value.standards = null; }, /must be an object/],
    ['standards schema', (value) => { objectField(value, 'standards').schemaVersion = 2; }, /schemaVersion must be 1/],
    ['catalog mismatch', (value) => { objectField(value, 'standards').catalogDigest = `sha256:${'a'.repeat(64)}`; }, /catalogs are not registered/],
    ['empty component set', (value) => { objectField(value, 'standards').components = []; }, /1 through 32/],
    ['noncanonical component ID', (value) => { firstObject(objectField(value, 'standards'), 'components').id = 'application\n'; }, /portable component identity/],
    ['profile schema', (value) => { objectField(firstObject(objectField(value, 'standards'), 'components'), 'profile').schemaVersion = 2; }, /schemaVersion must be 1/],
    ['unknown profile', (value) => { objectField(firstObject(objectField(value, 'standards'), 'components'), 'profile').id = 'custom'; }, /installed supported profile/],
    ['profile revision mismatch', (value) => { objectField(firstObject(objectField(value, 'standards'), 'components'), 'profile').revision = 'different'; }, /installed supported profile/],
    ['missing provenance', (value) => { delete value.provenance; }, /provenance must be an object/],
    ['unknown provenance kind', (value) => { objectField(value, 'provenance').kind = 'imported'; }, /generated or adopted/],
    ['raw adoption hash', (value) => { objectField(value, 'provenance').recordId = 'invalid'; }, /complete.*SHA-256/],
    ['adoption hash with trailing newline', (value) => { const p = objectField(value, 'provenance'); p.recordId = `${p.recordId}\n`; }, /complete.*SHA-256/],
    ['non-array repair lineage', (value) => { objectField(value, 'provenance').repairs = null; }, /bounded array/],
    ['unknown workflow', (value) => { objectField(value, 'project').specWorkflow = 'custom'; }, /specWorkflow is invalid/],
    ['non-array agents', (value) => { objectField(value, 'project').agents = null; }, /canonical array/],
    ['agent alias', (value) => { objectField(value, 'project').agents = ['copilot']; }, /unique canonical/],
    ['unknown default agent', (value) => { objectField(value, 'project').defaultAgent = 'custom'; }, /registered identity/],
    ['invented uninitialized agents', (value) => { objectField(value, 'project').agents = ['github-copilot']; }, /Uninitialized framework/],
    ['missing project inventory', (value) => { delete value.projectArtifacts; }, /projectArtifacts must be an array/]
  ])('rejects %s without modifying its input', (_name, mutate, error) => {
    const value = copiedObject(manifest);
    mutate(value);
    const before = JSON.stringify(value);
    expect(() => parseManifest(value)).toThrow(error);
    expect(JSON.stringify(value)).toBe(before);
  });

  it.each(['0.13.0\n', '0.13.0-01', 'not-semver'])('rejects noncanonical generated origin version %j', (version) => {
    const value = copiedObject(generated);
    objectField(objectField(value, 'provenance'), 'origin').cliVersion = version;
    expect(() => parseManifest(value)).toThrow(/semantic version/);
  });

  it.each([
    Array.from({ length: 33 }, () => 'part'), ['a'.repeat(256)], ['\uFF21pp.vue'], ['bad\u0000path']
  ])('rejects nonportable or over-bound path %j', (parts) => {
    expect(() => manifestPortablePath(parts, 'Manifest fixture')).toThrow(/path|portable|component/i);
  });

  it('accepts the exact portable path-depth boundary', () => {
    const parts = Array.from({ length: 32 }, (_, index) => `part-${index}`);
    expect(manifestPortablePath(parts, 'Manifest fixture')).toEqual(parts);
  });
});

describe('independent adoption record schema boundaries', () => {
  const expected = () => ({ recordId: record.recordId, standards: record.standards, assessmentDigest: record.assessmentDigest });
  it('reads the actual committed metadata-only record', () => {
    expect(validateAdoptionRecord(record, expected())).toEqual(record);
  });

  it.each<Mutation>([
    ['unknown field', (value) => { value.apply = true; }, /missing or unknown/],
    ['wrong record kind', (value) => { value.kind = 'liftoff-repair-history'; }, /exact declared provenance/],
    ['issued activation evidence', (value) => { value.activationEvidence = 'issued'; }, /exact declared provenance/],
    ['invalid review time', (value) => { value.reviewedAt = 'not-a-date'; }, /exact declared provenance/],
    ['malformed project inode', (value) => { objectField(value, 'projectIdentity').inode = 'unknown'; }, /project identity is malformed/],
    ['missing project creation identity', (value) => { delete objectField(value, 'projectIdentity').birthtime; }, /missing or unknown/],
    ['non-array source', (value) => { value.source = {}; }, /registered bounds/],
    ['oversized source', (value) => { value.source = Array.from({ length: 4097 }, () => ({})); }, /registered bounds/],
    ['oversized effects', (value) => { value.effects = Array.from({ length: 1025 }, () => ({})); }, /registered bounds/],
    ['source mode with special bits', (value) => { firstObject(value, 'source').mode = 0o1000; }, /ordinary mode bits/],
    ['incomplete source hash', (value) => {
      const existing = arrayField(value, 'source').map(objectValue).find((file) => file.digest !== null);
      if (!existing) throw new Error('Missing real existing-source fixture.');
      existing.digest = 'a';
    }, /complete SHA-256/],
    ['unknown effect producer', (value) => { firstObject(value, 'effects').producer = 'cloud'; }, /unregistered producer/],
    ['unknown effect kind', (value) => { firstObject(value, 'effects').type = 'copy'; }, /unregistered producer/],
    ['an adopted changed file', (value) => { firstObject(value, 'effects').type = 'adopt'; }, /inconsistent/],
    ['a deletion retaining bytes', (value) => { firstObject(value, 'effects').type = 'delete'; }, /inconsistent/],
    ['a write without target bytes', (value) => { objectField(firstObject(value, 'effects'), 'after').digest = null; }, /complete SHA-256|inconsistent/],
    ['duplicate source identity', (value) => { arrayField(value, 'source').push(structuredClone(firstObject(value, 'source'))); }, /duplicate, aliased or overlapping/],
    ['duplicate effect identity', (value) => { arrayField(value, 'effects').push(structuredClone(firstObject(value, 'effects'))); }, /duplicate, aliased or overlapping/],
    ['unsupported verification status', (value) => { objectField(value, 'verification').status = 'skipped'; }, /verification scope/],
    ['unrequired verification with a digest', (value) => { objectField(value, 'verification').digest = 'a'.repeat(64); }, /verification scope/],
    ['passed verification without a digest', (value) => { objectField(value, 'verification').status = 'passed'; }, /complete SHA-256/],
    ['another backup namespace', (value) => { value.backup = { namespace: 'repair-backup', indexKey: 'a'.repeat(64) }; }, /unregistered recovery namespace/],
    ['another approval namespace', (value) => { objectField(value, 'authorization').namespace = 'repair-approval'; }, /external transaction authority/],
    ['mismatched approval fingerprint', (value) => { objectField(value, 'authorization').fingerprint = 'a'.repeat(64); }, /external transaction authority/],
    ['noncanonical fingerprint', (value) => {
      value.fingerprint = `${value.fingerprint}\n`;
      objectField(value, 'authorization').fingerprint = value.fingerprint;
    }, /complete SHA-256/]
  ])('rejects %s rather than normalizing history', (_name, mutate, error) => {
    const value = copiedObject(record);
    mutate(value);
    const before = JSON.stringify(value);
    expect(() => validateAdoptionRecord(value, expected())).toThrow(error);
    expect(JSON.stringify(value)).toBe(before);
  });
});

describe('prepared framework receipt boundaries', () => {
  beforeAll(ensureFrameworkFixture, 90_000);

  it('reads the actual staged contract output without issuing a new operation', async () => {
    const result = await readPreparedAdoptionFramework(
      frameworkFixture.root, frameworkRecordId, frameworkBinding, frameworkCreatedAt,
      adoptionFixtureClock, adoptionFixtureStorage(frameworkFixture)
    );
    expect(result?.artifacts.length).toBe(arrayField(frameworkHeader, 'files').length);
    expect(result?.artifacts.every((artifact) => artifact.lifecycle === 'framework')).toBe(true);
  });

  it('refuses an invalid current clock rather than treating every receipt as unexpired', async () => {
    await expect(readPreparedAdoptionFramework(
      frameworkFixture.root, frameworkRecordId, frameworkBinding, frameworkCreatedAt,
      new Date('invalid'), adoptionFixtureStorage(frameworkFixture)
    )).rejects.toThrow(/receipt is invalid/);
  });

  it.each<Mutation>([
    ['unregistered schema', (value) => { value.schemaVersion = 2; }, /receipt is invalid/],
    ['wrong source binding', (value) => { value.bindingDigest = 'a'.repeat(64); }, /receipt is invalid/],
    ['expired output', (value) => { value.expiresAt = adoptionFixtureClock.toISOString(); }, /receipt is invalid/],
    ['missing expiry', (value) => { delete value.expiresAt; }, /receipt is invalid/],
    ['invalid expiry', (value) => { value.expiresAt = 'not-a-date'; }, /receipt is invalid/],
    ['noncanonical source fingerprint', (value) => { value.sourceFingerprint = `${value.sourceFingerprint}\n`; }, /receipt is invalid/],
    ['missing output', (value) => { value.files = []; }, /receipt is invalid/],
    ['changed command count', (value) => { value.commandsExecuted = Number(value.commandsExecuted) + 1; }, /receipt is invalid/],
    ['wrong file mode', (value) => { firstObject(value, 'files').mode = 0o1000; }, /inventory is malformed/],
    ['unregistered logical name', (value) => { firstObject(value, 'files').logicalName = 'framework-invented'; }, /logical identity changed/],
    ['escaping file path', (value) => { firstObject(value, 'files').pathParts = ['..', 'file']; }, /path|relative|traversal/i],
    ['missing chunk', (value) => { firstObject(value, 'files').key = 'a'.repeat(64); }, /bytes are missing/],
    ['noncanonical file hash', (value) => { firstObject(value, 'files').digest = `${firstObject(value, 'files').digest}\n`; }, /inventory is malformed/]
  ])('rejects %s even in a valid independent private-store envelope', async (_name, mutate, error) => {
    const home = path.join(frameworkFixture.parent, `receipt-${randomUUID()}`);
    await mkdir(home, { mode: 0o700 });
    const storage = { ...adoptionFixtureStorage(frameworkFixture), homedir: home };
    const store = createScopedUserLocalRecordStore(frameworkFixture.root, 'adoption-framework', storage);
    for (const [key, original] of frameworkRecords) {
      const value = copiedObject(original);
      if (key === frameworkRecordId) mutate(value);
      await store.write(key, value);
    }
    const before = await readdir(frameworkFixture.root, { recursive: true });
    await expect(readPreparedAdoptionFramework(
      frameworkFixture.root, frameworkRecordId, frameworkBinding, frameworkCreatedAt, adoptionFixtureClock, storage
    )).rejects.toThrow(error);
    expect(await readdir(frameworkFixture.root, { recursive: true })).toEqual(before);
  });
});
