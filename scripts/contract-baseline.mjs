#!/usr/bin/env node
// Frozen 0.12.3 contract baseline. The capture records what the checkout and the
// published packages actually do; it never rewrites an existing baseline, so a
// later behavior change must be recorded explicitly instead of being blessed.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export const contractBaselineParts = ['tests', 'fixtures', 'contract-baseline-0.12.3'];
export const contractChangesParts = ['tests', 'fixtures', 'contract-baseline-changes.json'];
export const contractBaselineRevision = '8281c46ab99a83b7226a6520a1a9e444e4a04ab8';
export const contractBaselineSchemaVersion = 1;
// Hosts on which help/JSON comparisons are enabled. This is eligibility, not a
// claim that a comparison has run there; provenance records observed hosts.
export const comparisonPlatforms = Object.freeze(['darwin', 'linux']);

export const publishedBaseline = Object.freeze({
  name: '@msn-control/liftoff',
  version: '0.12.3',
  integrity: 'sha512-3bqqnkMq20pR0igkr33ESkfxZ4iB11DfgHo8VTHoke5hkSKi06/ZLjkh3+k4mBvBdi0CCjWSHCQHSkDnbZGRpg==',
  shasum: 'eaec1c17678441628a00d7c50a0b4dc9f1873bf1',
  gitHead: '70d10881b46d873118d825735696f39b6d35ebe0'
});

// Last (or first) published writer of each supported manifest and activation family.
export const historicalWriters = Object.freeze([
  { version: '0.3.4', integrity: 'sha512-CVSI1kSfVmXJ9xtnUjpmBaxEufZuiV+b2cLZxjDIcSYTOy8OEkfJyHNDgGYAz/ojTZSuzIbKHI5oryzfhEVkDg==', manifestVersion: 2 },
  { version: '0.4.1', integrity: 'sha512-BJHzEyweGDdwo/FLMX/5VrsG6s5MNLNpbuBffkbBKrCepHM3jho5RHSRiTOzt5yL/5amw7XUhD9omf2H+QBOrA==', manifestVersion: 3 },
  { version: '0.7.0', integrity: 'sha512-2/qu8cWe0uBPizXeJe9YTQ8uEWfwv8XIQzia7Gns3olimzQeDPBpXONxofZnQrcP6ece74ayz4jd1EUZitslOw==', manifestVersion: 4 },
  { version: '0.8.0', integrity: 'sha512-TFWGemLL0umBzzH7hRpD9dtF1MqrsR4c7dWJq9ZFASETvLsI6Yw3DF/Aes0xVpF5K5V7YVaWz/YkAjkjh09sdg==', manifestVersion: 5 },
  { version: '0.9.9', integrity: 'sha512-/lsELk9+r0MmeyM1pxktJgcxBrXnyavhKS6SkWAPXde9ZuUXlfuHxaeW+QzGFz57WT6oCpbpikFFcQb8Y9IbBQ==', manifestVersion: 6 },
  { version: '0.10.0', integrity: 'sha512-bVQEusAptLd/GV8iutsvaTvjPCuPONVbN/ct9f2HfrWujk8s3CsLl0Z+SBVj0thfcln4tUO2MxhIqryJXKRGcA==', manifestVersion: 7, activationContractVersion: 1 },
  { version: '0.11.3', integrity: 'sha512-1DWo3lVRojFBK0wCNsbi+Tx7DB5CzZ/18cJUI5DdzmM3TkOt4qKqIGqZst5tdxMFX5B0D1Ohjmx1blVoLqqrhA==', manifestVersion: 7, activationContractVersion: 2 },
  { version: '0.12.3', integrity: publishedBaseline.integrity, manifestVersion: 7, activationContractVersion: 3 }
]);

export const existingManifestFixtures = Object.freeze([
  'tests/fixtures/manifest-v2.json',
  'tests/fixtures/manifest-v3.json',
  'tests/fixtures/manifest-v4-genai.json',
  'tests/fixtures/manifest-v4-standard.json',
  'tests/fixtures/manifest-v4-power-apps.json'
]);

const commandNames = ['help', 'init', 'plan', 'patterns', 'providers', 'regions', 'validate', 'update', 'repair',
  'upgrade', 'migrate', 'doctor', 'governance', 'dev', 'infra'];

export const textInvocations = Object.freeze([
  ['help'], ['--help'], ['--version'],
  ...commandNames.map((command) => [command, '--help']),
  ...['status', 'plan', 'approve', 'apply-next', 'credential-enroll', 'recover', 'resume', 'verify', 'assess']
    .map((subcommand) => ['governance', subcommand, '--help']),
  ['regions', 'search', '--help'],
  ...['up', 'down', 'logs', 'reset'].map((subcommand) => ['dev', subcommand, '--help']),
  ...['init', 'plan', 'apply', 'output'].map((subcommand) => ['infra', subcommand, '--help']),
  ['patterns'], ['providers'], ['regions'], ['regions', 'search', 'korea'],
  ['create'], ['update', '--apply'], ['init', '--bogus'], ['update', '--check', '--force'],
  ['init', '--agents', ''], ['init', '--spec', 'manual'], ['repair', '--check', '--capabilities']
]);

export const jsonProject = Object.freeze({
  projectName: 'Contract Baseline', genai: false, apiStack: 'go', cloud: 'azure', region: 'eastus',
  environments: ['dev'], specWorkflow: 'openspec', agents: ['copilot'], governanceProfile: 'single-maintainer-gitflow'
});

export const jsonInvocations = Object.freeze([
  ['validate', '--json'],
  ['update', '--check', '--json'],
  ['repair', '--capabilities', '--json'],
  ['repair', '--check', '--json'],
  ['repair', '--inspect-layout', '--json'],
  ['governance', 'status', '--json'],
  ['governance', 'plan', '--json'],
  ['governance', 'assess', '--json']
]);

const renderBase = { projectName: 'Contract Baseline', cloud: 'azure', region: 'eastus', environments: ['dev', 'staging', 'prod'] };
export const artifactCases = Object.freeze([
  { id: 'standard-python', options: { projectType: 'standard', apiStack: 'python' } },
  { id: 'standard-node-frontend', options: { projectType: 'standard', apiStack: 'node', includeFrontend: true } },
  { id: 'standard-go', options: { projectType: 'standard', apiStack: 'go' } },
  ...['generic', 'rag', 'chatbot', 'agent', 'prompt', 'multi-agent', 'fine-tuned', 'streaming', 'workflow']
    .map((pattern) => ({ id: `genai-${pattern}`, options: { pattern } })),
  { id: 'genai-rag-spec-kit-claude-default', options: { pattern: 'rag', includeFrontend: true, specWorkflow: 'spec-kit', agents: ['copilot', 'claude'], defaultAgent: 'claude' } },
  { id: 'standard-node-all-agents', options: { projectType: 'standard', apiStack: 'node', agents: ['copilot', 'claude', 'codex'] } },
  { id: 'standard-go-governance-none', options: { projectType: 'standard', apiStack: 'go', governanceProfile: 'none' } },
  { id: 'genai-generic-copilot-cloud', options: { pattern: 'generic', copilotCloud: true } }
].map((entry) => ({ id: entry.id, options: { ...renderBase, ...entry.options } })));

export const manifestCases = Object.freeze([
  { id: 'standard-go', options: { projectName: 'Contract Baseline', genai: false, apiStack: 'go', cloud: 'azure', region: 'eastus', environments: ['dev'] } },
  { id: 'genai-rag', options: { projectName: 'Contract Baseline', pattern: 'rag', cloud: 'azure', region: 'eastus', includeFrontend: true, environments: ['dev', 'prod'] } }
]);

export const modulePaths = Object.freeze({
  args: 'args.js',
  commands: 'commands.js',
  planner: 'planner.js',
  templates: 'templates.js',
  fileSystem: 'file-system.js',
  identity: 'domain/governance/policy/identity.js',
  graph: 'domain/governance/activation/graph.js',
  compatibility: 'governance-activation/compatibility.js'
});

export class ContractBaselineError extends Error {}

function fail(message) {
  throw new ContractBaselineError(message);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

// Independent of the code under test: sorted-key JSON used only for digests.
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function stableDigest(value) {
  return sha256(stableJson(value));
}

class CaptureStream extends Writable {
  chunks = [];

  _write(chunk, _encoding, callback) {
    this.chunks.push(String(chunk));
    callback();
  }

  text() {
    return this.chunks.join('');
  }
}

const timestampPatterns = [
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g,
  /\d{8}T\d{6,9}Z/g
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Replaces host-specific roots with stable placeholders and portable separators.
export function normalizeHostText(text, roots) {
  let value = String(text);
  const variants = roots.flatMap(([root, placeholder]) => [...new Set([root, safeRealpath(root)])]
    .filter(Boolean).map((candidate) => [candidate, placeholder]))
    .sort((left, right) => right[0].length - left[0].length);
  for (const [candidate, placeholder] of variants) {
    value = value.replace(new RegExp(`${escapeRegExp(candidate)}((?:[\\\\/][^\\s"'\\\\/]+)*)`, 'g'),
      (_match, rest) => `${placeholder}${rest.replaceAll('\\', '/')}`);
  }
  for (const pattern of timestampPatterns) value = value.replace(pattern, '<timestamp>');
  return value;
}

function safeRealpath(value) {
  try {
    return realpathSync.native(value);
  } catch {
    return undefined;
  }
}

function mapStrings(value, transform) {
  if (typeof value === 'string') return transform(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, transform));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, transform)]));
  }
  return value;
}

function pointerPart(value) {
  return String(value).replaceAll('~', '~0').replaceAll('/', '~1');
}

// Lists leaves that differ between two independent captures of the same input.
export function volatilePointers(left, right, pointer = '') {
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) fail(`Nondeterministic structure at ${pointer || '/'}: ${left.length} versus ${right.length} items.`);
    return left.flatMap((item, index) => volatilePointers(item, right[index], `${pointer}/${index}`));
  }
  if (left && right && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    return keys.flatMap((key) => {
      if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) fail(`Nondeterministic structure at ${pointer}/${pointerPart(key)}.`);
      return volatilePointers(left[key], right[key], `${pointer}/${pointerPart(key)}`);
    });
  }
  if (typeof left !== typeof right) fail(`Nondeterministic value type at ${pointer || '/'}.`);
  return stableJson(left) === stableJson(right) ? [] : [pointer || '/'];
}

export function maskPointers(value, pointers) {
  const masked = structuredClone(value);
  for (const pointer of pointers) {
    const parts = pointer.split('/').slice(1).map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
    if (parts.length === 0) return '<volatile>';
    let target = masked;
    for (const part of parts.slice(0, -1)) target = target?.[part];
    if (target && Object.hasOwn(target, parts.at(-1))) target[parts.at(-1)] = '<volatile>';
  }
  return masked;
}

async function isolatedHost(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const home = path.join(root, 'home');
  const env = {
    HOME: home,
    USERPROFILE: home,
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    APPDATA: path.join(root, 'appdata'),
    LOCALAPPDATA: path.join(root, 'localappdata'),
    LIFTOFF_TELEMETRY: '0',
    DO_NOT_TRACK: '1',
    CI: 'true'
  };
  for (const directory of [home, env.XDG_STATE_HOME, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.APPDATA, env.LOCALAPPDATA]) {
    await mkdir(directory, { recursive: true });
  }
  const stateBases = [
    path.join(home, 'Library', 'Application Support'),
    path.join(home, 'AppData', 'Local'),
    path.join(home, '.local', 'state'),
    env.XDG_STATE_HOME,
    env.LOCALAPPDATA
  ];
  return { root, env, roots: [...stateBases.map((base) => [base, '<state-base>']), [home, '<home>'], [root, '<host>']] };
}

// Process environment is swapped only for the duration of one capture so any
// code path that ignores the injected env still cannot reach real user state.
async function withEnvironment(env, action) {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    return await action();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function runInvocation(modules, args, { cwd, env, roots }) {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  let parsed;
  try {
    parsed = modules.args.parseArgs([...args]);
  } catch (error) {
    return { parseError: normalizeHostText(error instanceof Error ? error.message : String(error), roots) };
  }
  let exitCode;
  try {
    // An empty, non-TTY stdin makes any accidental prompt end deterministically.
    exitCode = await modules.commands.runCommand(parsed, {
      cwd, stdout, stderr, env, stdin: Readable.from([]),
      updateNow: () => new Date('2026-01-01T00:00:00.000Z'),
      terminal: { snapshot: true, columns: 80 }
    });
  } catch (error) {
    return { thrown: normalizeHostText(error instanceof Error ? error.message : String(error), roots) };
  }
  return { exitCode, stdout: stdout.text(), stderr: normalizeHostText(stderr.text(), roots) };
}

export async function captureText(modules) {
  const host = await isolatedHost('liftoff contract text ');
  try {
    const cwd = path.join(host.root, 'workspace');
    await mkdir(cwd, { recursive: true });
    const roots = [[cwd, '<cwd>'], ...host.roots];
    return await withEnvironment(host.env, async () => {
      const results = {};
      for (const args of textInvocations) {
        const result = await runInvocation(modules, args, { cwd, env: { ...process.env, ...host.env }, roots });
        results[args.join(' ')] = result.stdout === undefined ? result : { ...result, stdout: normalizeHostText(result.stdout, roots) };
      }
      return results;
    });
  } finally {
    await rm(host.root, { recursive: true, force: true });
  }
}

async function captureJsonOnce(modules, label) {
  const host = await isolatedHost(`liftoff contract ${label} `);
  try {
    return await withEnvironment(host.env, async () => {
      const project = await modules.commands.createFixtureProject({ ...jsonProject });
      const roots = [[project, '<project>'], [path.dirname(project), '<project-parent>'], ...host.roots, [os.tmpdir(), '<tmp>']];
      const results = {};
      try {
        for (const args of jsonInvocations) {
          const result = await runInvocation(modules, args, { cwd: project, env: { ...process.env, ...host.env }, roots });
          let json;
          try {
            json = JSON.parse(result.stdout ?? '');
          } catch {
            fail(`${args.join(' ')} did not emit one JSON result.`);
          }
          results[args.join(' ')] = { exitCode: result.exitCode, stderr: result.stderr, json: mapStrings(json, (text) => normalizeHostText(text, roots)) };
        }
      } finally {
        await rm(path.dirname(project), { recursive: true, force: true });
      }
      return results;
    });
  } finally {
    await rm(host.root, { recursive: true, force: true });
  }
}

// Captures twice with different roots and clocks; values that differ are
// recorded as volatile so they are neither frozen nor silently ignored.
export async function captureJson(modules) {
  const first = await captureJsonOnce(modules, 'json a');
  await new Promise((resolve) => setTimeout(resolve, 25));
  const second = await captureJsonOnce(modules, 'json second capture b');
  const results = {};
  for (const key of Object.keys(first)) {
    const left = first[key];
    const right = second[key];
    if (left.exitCode !== right.exitCode || left.stderr !== right.stderr) fail(`${key} is not reproducible across isolated captures.`);
    const volatile = volatilePointers(left.json, right.json);
    results[key] = { exitCode: left.exitCode, stderr: left.stderr, volatile, json: maskPointers(left.json, volatile) };
  }
  return results;
}

// artifactSha256 covers every rendered field (path, category, lifecycle,
// provisioning group, content); the other fields make a difference readable.
export function artifactRecord(artifact) {
  return {
    path: (artifact.pathParts ?? []).join('/'),
    lifecycle: artifact.lifecycle ?? null,
    contentSha256: sha256(String(artifact.content ?? '')),
    artifactSha256: sha256(JSON.stringify(artifact))
  };
}

export function captureArtifacts(modules) {
  const cases = {};
  for (const entry of artifactCases) {
    const plan = modules.planner.buildProjectPlan({ ...entry.options }, { requireProjectName: true });
    const artifacts = modules.templates.buildArtifacts(plan);
    const again = modules.templates.buildArtifacts(plan);
    if (stableJson(artifacts) !== stableJson(again)) fail(`${entry.id} renders nondeterministically.`);
    const records = {};
    for (const artifact of artifacts) {
      if (Object.hasOwn(records, artifact.logicalName)) fail(`${entry.id} renders duplicate logical name ${artifact.logicalName}.`);
      records[artifact.logicalName] = artifactRecord(artifact);
    }
    cases[entry.id] = { options: entry.options, artifactCount: artifacts.length, artifacts: records };
  }
  return cases;
}

export function renderManifest(modules, options) {
  const plan = modules.planner.buildProjectPlan({ ...options }, { requireProjectName: true });
  const manifest = modules.templates.buildArtifacts(plan).find((artifact) => artifact.logicalName === 'manifest');
  if (!manifest) fail('The writer rendered no manifest artifact.');
  return String(manifest.content);
}

export function interpretManifest(modules, text) {
  try {
    const parsed = modules.fileSystem.parseManifest(JSON.parse(text));
    return {
      ok: true,
      artifactVersion: parsed.artifactVersion,
      liftoffVersion: parsed.liftoffVersion,
      managedArtifacts: parsed.managedArtifacts.length,
      projectArtifacts: parsed.projectArtifacts.length,
      generationHashes: stableDigest(parsed.projectArtifacts.map((artifact) => [artifact.logicalName, artifact.generationHash ?? null])),
      interpretationSha256: stableDigest(parsed)
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function captureActivation(modules) {
  const identity = modules.identity;
  return {
    current: modules.graph.currentActivationIdentity,
    canonicalPhaseGraphHash: modules.graph.canonicalPhaseGraphHash,
    phaseContractDigests: modules.graph.canonicalPhaseContractDigests,
    historical: identity.historicalActivationIdentities,
    knownActivationVersions: identity.knownActivationVersions,
    constants: Object.fromEntries([
      'liftoffActivationPackageVersion', 'liftoffManifestArtifactVersion', 'governanceActivationPolicyVersion',
      'activationContractVersion', 'phaseGraphSchemaVersion', 'activationStateSchemaVersion',
      'evidenceHeaderSchemaVersion', 'approvalEnvelopeSchemaVersion', 'compatibilityMetadataSchemaVersion',
      'supersessionSchemaVersion', 'credentialPolicySchemaVersion'
    ].map((name) => [name, identity[name]])),
    manifest: {
      supportedManifestReadVersions: modules.compatibility.supportedManifestReadVersions,
      minimumLiftoffForManifestV7: modules.compatibility.minimumLiftoffForManifestV7
    },
    successorMigrations: modules.compatibility.packagedActivationSuccessorMigrations()
  };
}

const governanceLogicalName = /^(?:repository-governance-|liftoff-setup-|liftoff-governance-assess-)/;

// The governance handoff a released writer generates is the original history a
// project retains; its graph must hash to that release's activation identity.
export function captureGovernanceHistory(modules) {
  const plan = modules.planner.buildProjectPlan({ ...manifestCases[0].options, specWorkflow: 'openspec', agents: ['copilot'] }, { requireProjectName: true });
  const artifacts = modules.templates.buildArtifacts(plan).filter((artifact) => governanceLogicalName.test(artifact.logicalName));
  const graph = artifacts.find((artifact) => artifact.logicalName === 'repository-governance-phase-graph');
  return {
    artifacts: Object.fromEntries(artifacts.map((artifact) => [artifact.logicalName, {
      path: artifact.pathParts.join('/'), contentSha256: sha256(String(artifact.content))
    }])),
    phaseGraphCanonicalSha256: graph ? canonicalGraphHash(JSON.parse(String(graph.content))) : null
  };
}

// Canonical JSON as used by activation identities: sorted keys, no whitespace,
// one trailing newline.
export function canonicalGraphHash(value) {
  return sha256(`${stableJson(value)}\n`);
}

// Classifies one surface against the frozen baseline. Only an exact reviewed
// record naming both digests may account for a difference.
export function baselineComparison(surface, key, current, baseline, changes) {
  const records = changes.filter((change) => change.surface === surface && change.key === key);
  const baselineSha256 = stableDigest(baseline ?? null);
  const currentSha256 = stableDigest(current ?? null);
  if (baselineSha256 === currentSha256) {
    return records.length === 0 ? { status: 'unchanged' } : { status: 'stale-record', records };
  }
  if (records.length === 0) return { status: 'unrecorded-change', baselineSha256, currentSha256 };
  if (records.length > 1) return { status: 'ambiguous-record', records };
  const [record] = records;
  if (record.baselineSha256 !== baselineSha256 || record.currentSha256 !== currentSha256 ||
      typeof record.task !== 'string' || !record.task || typeof record.reason !== 'string' || !record.reason) {
    return { status: 'mismatched-record', record, baselineSha256, currentSha256 };
  }
  return { status: 'recorded-change', record };
}

export function assertCaptureDestination(directory) {
  if (existsSync(directory)) {
    fail(`Refusing to overwrite the frozen contract baseline at ${path.relative(repositoryRoot, directory) || directory}. Record intentional changes instead.`);
  }
}

// The governance handoff each published writer renders, with an explicit
// status: a writer that predates governance renders none, and any producer
// failure is reported rather than dropped.
export function captureWriterGovernance(modules) {
  let history;
  try {
    history = captureGovernanceHistory(modules);
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
  return Object.keys(history.artifacts).length === 0 ? { status: 'none' } : { status: 'rendered', ...history };
}

export function captureWriterHistory(modules) {
  const manifests = {};
  for (const entry of manifestCases) {
    try {
      manifests[entry.id] = { content: renderManifest(modules, entry.options) };
    } catch (error) {
      manifests[entry.id] = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { manifests, governance: captureWriterGovernance(modules) };
}

export function assertWriterObservations(writers) {
  for (const writer of writers) {
    const status = writer.governance?.status;
    if (status === 'failed') fail(`Published ${writer.version} governance capture failed: ${writer.governance.error}`);
    if (status !== 'rendered' && status !== 'none') fail(`Published ${writer.version} has no explicit governance observation.`);
  }
}

export async function loadDistModules(distRoot) {
  const entries = await Promise.all(Object.entries(modulePaths).map(async ([key, file]) => {
    const target = path.join(distRoot, ...file.split('/'));
    return [key, existsSync(target) ? await import(pathToFileURL(target).href) : undefined];
  }));
  return Object.fromEntries(entries);
}

export async function captureCurrentSurfaces(modules) {
  return {
    text: await captureText(modules),
    json: await captureJson(modules),
    artifacts: captureArtifacts(modules),
    activation: captureActivation(modules),
    governanceHistory: captureGovernanceHistory(modules)
  };
}

function relativeFiles(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile()) files.push(path.relative(root, target).split(path.sep).join('/'));
      else fail(`Contract baseline contains a non-regular entry: ${target}`);
    }
  };
  walk(root);
  return files.sort();
}

export function baselineInventory(directory) {
  return relativeFiles(directory).filter((file) => file !== 'provenance.json').map((file) => {
    const bytes = readFileSync(path.join(directory, ...file.split('/')));
    return { path: file, sha256: sha256(bytes), bytes: bytes.length };
  });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: false, timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) fail(`${command} ${args.join(' ')} failed: ${result.error?.message ?? result.stderr?.trim() ?? result.status}`);
  return result.stdout;
}

// Read-only retrieval: npm pack downloads the exact published tarball, which is
// then checked against the pinned registry integrity before any use.
async function publishedPackage(version, integrity, cacheRoot) {
  const destination = path.join(cacheRoot, version);
  const tarball = path.join(cacheRoot, `msn-control-liftoff-${version}.tgz`);
  if (!existsSync(tarball)) {
    run('npm', ['pack', `${publishedBaseline.name}@${version}`, '--json', '--ignore-scripts', '--pack-destination', cacheRoot], cacheRoot);
  }
  const bytes = await readFile(tarball);
  const actual = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (actual !== integrity) fail(`${publishedBaseline.name}@${version} integrity ${actual} does not match ${integrity}.`);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  run('tar', ['-xzf', tarball, '-C', destination], cacheRoot);
  return { dist: path.join(destination, 'package', 'dist'), tarballSha256: sha256(bytes), integrity: actual };
}

function compareSurfaces(checkout, published) {
  const differences = [];
  for (const surface of ['text', 'json', 'artifacts', 'activation', 'governanceHistory']) {
    const left = checkout[surface];
    const right = published[surface];
    const keys = left && typeof left === 'object' && !Array.isArray(left) && surface !== 'activation' && surface !== 'governanceHistory'
      ? [...new Set([...Object.keys(left), ...Object.keys(right ?? {})])].sort()
      : [null];
    for (const key of keys) {
      const a = key === null ? left : left?.[key];
      const b = key === null ? right : right?.[key];
      if (stableJson(a) !== stableJson(b)) differences.push({ surface, key, checkoutSha256: stableDigest(a ?? null), publishedSha256: stableDigest(b ?? null) });
    }
  }
  return differences;
}

async function captureChild(distRoot, operation) {
  const output = run(process.execPath, [fileURLToPath(import.meta.url), 'capture-dist', operation, distRoot], repositoryRoot);
  return JSON.parse(output);
}

// Builds the exact baseline commit from git, independent of uncommitted work in
// the checkout, using the checkout's installed TypeScript.
async function baselineCheckout(cacheRoot) {
  const exportRoot = path.join(cacheRoot, `checkout-${contractBaselineRevision}`);
  await rm(exportRoot, { recursive: true, force: true });
  await mkdir(exportRoot, { recursive: true });
  const archive = path.join(cacheRoot, `checkout-${contractBaselineRevision}.tar`);
  run('git', ['archive', '--format=tar', `--output=${archive}`, contractBaselineRevision,
    'package.json', 'tsconfig.json', 'src', 'assets'], repositoryRoot);
  run('tar', ['-xf', archive, '-C', exportRoot], repositoryRoot);
  await rm(archive, { force: true });
  run(path.join(repositoryRoot, 'node_modules', '.bin', 'tsc'), ['-p', path.join(exportRoot, 'tsconfig.json')], exportRoot);
  return {
    root: exportRoot,
    dist: path.join(exportRoot, 'dist'),
    tree: run('git', ['rev-parse', `${contractBaselineRevision}^{tree}`], repositoryRoot).trim()
  };
}

function baselineFile(file) {
  return Buffer.from(run('git', ['show', `${contractBaselineRevision}:${file}`], repositoryRoot), 'utf8');
}

async function captureBaseline() {
  const directory = path.join(repositoryRoot, ...contractBaselineParts);
  assertCaptureDestination(directory);
  if (!comparisonPlatforms.includes(process.platform)) fail(`Capture runs on ${comparisonPlatforms.join(' or ')}; ${process.platform} is not a comparison host.`);
  const revision = run('git', ['rev-parse', '--verify', `${contractBaselineRevision}^{commit}`], repositoryRoot).trim();
  if (revision !== contractBaselineRevision) fail(`Baseline commit ${contractBaselineRevision} is unavailable.`);

  const cacheRoot = path.join(repositoryRoot, '.cache', 'contract-baseline', 'published');
  await mkdir(cacheRoot, { recursive: true });
  const baseline = await baselineCheckout(path.join(repositoryRoot, '.cache', 'contract-baseline'));
  const checkoutDist = baseline.dist;
  const checkout = await captureChild(checkoutDist, 'surfaces');
  const published = await publishedPackage(publishedBaseline.version, publishedBaseline.integrity, cacheRoot);
  const publishedSurfaces = await captureChild(published.dist, 'surfaces');
  const differences = compareSurfaces(checkout, publishedSurfaces);

  const staging = await mkdtemp(path.join(repositoryRoot, '.cache', 'contract-baseline-staging-'));
  try {
    const manifestDirectory = path.join(staging, 'manifests');
    await mkdir(manifestDirectory, { recursive: true });
    const writers = [];
    const manifestFiles = [];
    for (const writer of historicalWriters) {
      const pkg = await publishedPackage(writer.version, writer.integrity, cacheRoot);
      const result = await captureChild(pkg.dist, 'history');
      writers.push({ ...writer, tarballSha256: pkg.tarballSha256, governance: result.governance, manifests: Object.keys(result.manifests) });
      for (const [caseId, entry] of Object.entries(result.manifests)) {
        if (entry.error) {
          writers.at(-1)[`unsupported:${caseId}`] = entry.error;
          continue;
        }
        const file = `manifests/${writer.version}-${caseId}.json`;
        await writeFile(path.join(staging, ...file.split('/')), entry.content);
        manifestFiles.push({ file, writer: writer.version, case: caseId });
      }
    }
    assertWriterObservations(writers);
    const readers = {};
    const interpret = async (dist, key) => {
      const values = {};
      for (const entry of [...manifestFiles.map((item) => ({ file: item.file, bytes: readFileSync(path.join(staging, ...item.file.split('/'))) })),
        ...existingManifestFixtures.map((file) => ({ file, bytes: baselineFile(file) }))]) {
        values[entry.file] = await captureChild(dist, `interpret:${entry.bytes.toString('base64')}`);
      }
      readers[key] = values;
    };
    await interpret(checkoutDist, 'checkout');
    await interpret(published.dist, 'published');
    const readerDifferences = Object.keys(readers.checkout).filter((file) =>
      stableJson(readers.checkout[file]) !== stableJson(readers.published[file]));

    const surfaces = {
      'cli-text.json': checkout.text,
      'cli-json.json': checkout.json,
      'rendered-artifacts.json': checkout.artifacts,
      'activation-identities.json': checkout.activation,
      'history.json': {
        governanceWriters: Object.fromEntries(writers.filter((writer) => writer.governance.status === 'rendered')
          .map((writer) => {
            const { status: _status, ...governance } = writer.governance;
            return [writer.version, { activationContractVersion: writer.activationContractVersion, ...governance }];
          })),
        checkoutGovernance: checkout.governanceHistory,
        packagedHistoricalGraph: {
          path: 'assets/governance/single-maintainer-gitflow/activation-v2-graph.json',
          sha256: sha256(baselineFile('assets/governance/single-maintainer-gitflow/activation-v2-graph.json')),
          canonicalSha256: canonicalGraphHash(JSON.parse(baselineFile('assets/governance/single-maintainer-gitflow/activation-v2-graph.json').toString('utf8')))
        }
      },
      'manifest-readers.json': {
        existingFixtures: Object.fromEntries(existingManifestFixtures.map((file) => [file, sha256(baselineFile(file))])),
        capturedManifests: manifestFiles,
        interpretations: readers.checkout
      }
    };
    for (const [file, value] of Object.entries(surfaces)) {
      await writeFile(path.join(staging, file), `${JSON.stringify(value, null, 2)}\n`);
    }
    const inventory = baselineInventory(staging);
    const provenance = {
      schemaVersion: contractBaselineSchemaVersion,
      kind: 'liftoff-contract-baseline',
      purpose: 'Frozen pre-modernization public contracts; later behavior changes must be recorded in tests/fixtures/contract-baseline-changes.json, never by regenerating this directory.',
      checkout: {
        revision,
        tree: baseline.tree,
        describe: run('git', ['describe', '--tags', '--always', contractBaselineRevision], repositoryRoot).trim(),
        packageVersion: JSON.parse(baselineFile('package.json').toString('utf8')).version,
        build: 'git archive of package.json, tsconfig.json, src and assets at the revision, compiled with the checkout TypeScript into an isolated directory',
        sourceNote: 'Two repository-setup commits after the published gitHead (governance/community files, workflows, README, scripts, a Windows job-runner change); captured CLI surfaces were compared with the published package below.'
      },
      published: { ...publishedBaseline, tarballSha256: published.tarballSha256, retrieval: 'npm pack <name>@<version> (read-only), sha512 integrity verified before extraction' },
      historicalWriters: writers.map(({ governance, ...writer }) => ({ ...writer, governance: governance.status })),
      comparison: {
        surfaces: differences.length === 0 ? 'identical' : 'differs',
        differences,
        manifestReaders: readerDifferences.length === 0 ? 'identical' : 'differs',
        manifestReaderDifferences: readerDifferences
      },
      capture: {
        command: 'node scripts/contract-baseline.mjs capture',
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        observedPlatforms: [`${process.platform}/${process.arch}`],
        comparisonPlatforms: [...comparisonPlatforms],
        unrunPlatforms: comparisonUnrunPlatforms(process.platform),
        environment: { LIFTOFF_TELEMETRY: '0', DO_NOT_TRACK: '1', CI: 'true', isolation: 'temporary HOME/XDG/APPDATA/LOCALAPPDATA; no credentials, accounts or network except read-only package retrieval' },
        volatileJsonValues: 'Values that differed between two isolated captures are stored as <volatile> with their JSON pointers.'
      },
      files: inventory
    };
    await writeFile(path.join(staging, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`);
    await mkdir(path.dirname(directory), { recursive: true });
    await rename(staging, directory);
    const changes = path.join(repositoryRoot, ...contractChangesParts);
    if (!existsSync(changes)) {
      await writeFile(changes, `${JSON.stringify({
        schemaVersion: 1, baseline: contractBaselineParts.at(-1), knownDefects: [], intendedRejections: [], changes: []
      }, null, 2)}\n`);
    }
    process.stdout.write(`Captured ${inventory.length} frozen contract files; surfaces vs published 0.12.3: ${provenance.comparison.surfaces}; readers: ${provenance.comparison.manifestReaders}.\n`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export function comparisonUnrunPlatforms(observed) {
  return [
    ...comparisonPlatforms.filter((platform) => platform !== observed)
      .map((platform) => `${platform} (comparison enabled; native execution unrun until CI)`),
    'win32 (help/JSON comparison disabled; host paths, modes and shell renderings not captured)'
  ];
}

// Read-only re-observation of every published writer, for review against the
// frozen history; it writes nothing into the baseline directory.
async function observeWriters() {
  const cacheRoot = path.join(repositoryRoot, '.cache', 'contract-baseline', 'published');
  await mkdir(cacheRoot, { recursive: true });
  const writers = [];
  for (const writer of historicalWriters) {
    const pkg = await publishedPackage(writer.version, writer.integrity, cacheRoot);
    const result = await captureChild(pkg.dist, 'history');
    writers.push({
      version: writer.version,
      tarballSha256: pkg.tarballSha256,
      governance: result.governance,
      manifests: Object.fromEntries(Object.entries(result.manifests).map(([caseId, entry]) =>
        [caseId, entry.error ? { error: entry.error } : { sha256: sha256(entry.content) }]))
    });
  }
  return writers;
}

async function captureDist(operation, distRoot) {
  const modules = await loadDistModules(path.resolve(distRoot));
  if (operation === 'surfaces') return captureCurrentSurfaces(modules);
  if (operation === 'history') return captureWriterHistory(modules);
  if (operation.startsWith('interpret:')) {
    return interpretManifest(modules, Buffer.from(operation.slice('interpret:'.length), 'base64').toString('utf8'));
  }
  fail(`Unknown capture operation ${operation}.`);
}

async function main() {
  const [operation, ...rest] = process.argv.slice(2);
  if (operation === 'capture' && rest.length === 0) return captureBaseline();
  if (operation === 'observe-writers' && rest.length === 0) {
    process.stdout.write(`${JSON.stringify(await observeWriters(), null, 2)}\n`);
    return undefined;
  }
  if (operation === 'capture-dist' && rest.length === 2) {
    const host = await isolatedHost('liftoff contract child ');
    try {
      const value = await withEnvironment(host.env, () => captureDist(rest[0], rest[1]));
      process.stdout.write(JSON.stringify(value));
    } finally {
      await rm(host.root, { recursive: true, force: true });
    }
    return undefined;
  }
  fail('Usage: node scripts/contract-baseline.mjs <capture|observe-writers>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Contract baseline failed: ${error.message}`);
    process.exitCode = 1;
  });
}
