import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { transformSync } from 'rolldown/utils';
import { verifyReleaseIdentity } from '../src/release-identity.js';
import * as nativeContracts from '../src/domain/distribution/index.js';
import * as telemetryContract from '../src/telemetry/contract.js';
import { canonicalPhaseGraph, canonicalPhaseGraphHash, canonicalPhaseContractDigests, phaseContractDigests } from '../src/domain/governance/activation/graph.js';
import { phaseCapabilities } from '../src/domain/governance/activation/capabilities.js';
import { phaseIds } from '../src/domain/governance/activation/types.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { buildPublicCapabilitiesEnvelope } from '../src/application/engine-composition.js';
import { validatePublicCapabilitiesEnvelope } from '../src/protocol/capabilities.js';
import { loadCanonicalSkillCatalog } from '../src/adapters/packaged-assets/skill-assets.js';
import { CANONICAL_SKILL_IDS, SUPPORTED_SKILL_HOSTS } from '../src/domain/skills/contracts.js';
import { validateSkillCatalogMetadata, validateEnrichedSkillCatalog } from '../src/domain/skills/catalog.js';
import { projectSkillForHost, renderRetainedProjectSkill } from '../src/adapters/skills/host-projections.js';
import { governanceAgentIntegrations } from '../src/domain/project/catalog.js';
import { governanceProfiles } from '../src/application/project/catalog.js';
import { repairContractVersion, repairRecipes, repairRecoveryCompatibility, repairSchemaVersions } from '../src/domain/repair/identity.js';
import { repairCapabilities } from '../src/application/repair/capabilities.js';
import { validateStandardsProfileCatalog } from '../src/domain/standards/profile-schema.js';
import { computeComponentDigest, computeTemplateCatalogDigest, validateTemplateCatalog } from '../src/domain/standards/resource-catalog-schema.js';
import { renderHomebrewDefinition, renderWinGetDefinitions } from '../scripts/distribution/channel-definitions.mjs';
import { copyInventoriedFile, inventoryTree } from '../scripts/distribution/native-build-files.mjs';
import { validateNativeBuildInfo } from '../src/adapters/packaged-assets/build-info.js';
import { nativeBuildInfoDocument } from '../scripts/distribution/assemble-native-bundle.mjs';
import { computeResourceInventorySummary } from '../src/adapters/packaged-assets/resource-catalog.js';
import { observeNativeHost } from '../src/adapters/distribution/native-admission.js';
import { darwinStateSystemProgram } from '../src/adapters/state/darwin-system-program.js';
import { posixStateLockProgram, linuxPosixStateLockProgram } from '../src/adapters/state/posix-lock-program.js';
import { linuxReadonlyProcessProgram } from '../src/adapters/state/linux-readonly-process-program.js';
import { nativeStatePythonVersionProbe } from '../src/adapters/state/native-system.js';
import { EMBEDDED_NATIVE_HELPERS, nativeHelpersForPlatform } from '../scripts/native-helper-inventory.mjs';
import {
  evaluateReleaseGate, evaluateReleaseGateFixture, formatReleaseGateReport, REQUIRED_REPORT_IDS
} from '../scripts/release-gate.mjs';
import {
  buildReleaseSubject, canonicalJson, collectPublicDocumentInventory, DASHBOARD_CHECKS, EVIDENCE_KIND, HELPER_CHECKS, inspectFile,
  inspectNativeArchive, loadReleaseContext, loadReleaseContracts, loadReleaseScope, NATIVE_CHECKS, REQUIRED_NATIVE_TARGETS,
  sha256, verifyNativeArchiveContents
} from '../scripts/release-evidence.mjs';
import {
  createGitHubEvidenceVerifier, validateAttestationResults, validateWorkflowPolicy, validateWorkflowRun
} from '../scripts/release-evidence-github.mjs';
import { parseCollectionArgs } from '../scripts/collect-release-evidence.mjs';
import { getCanonicalProductionInventory } from '../scripts/coverage-gate.mjs';
import { ACTION_PURPOSES, QUALIFICATION_PURPOSES, buildActionRequest, loadQualificationRegistry, qualificationPlans, validateEffect, verifyQualificationExecutions } from '../scripts/release-qualification.mjs';
import { actionApprovalReceipt, parseProducerArgs, releaseReport } from '../scripts/produce-release-evidence.mjs';
import { gatewayImageTestRequest, loadTelemetryReleaseContract, TELEMETRY_BASELINE_FIXTURE, TELEMETRY_CONTRACT_PATH,
  TELEMETRY_PROFILE_ID, telemetryAcceptanceCases, telemetryGatewayRejectionCases, validateGatewayRegistration } from '../scripts/release-telemetry-gateway.mjs';

const SOURCE = 'a'.repeat(40);
const SIGNER = 'b'.repeat(40);
const GATEWAY_SOURCE = 'e'.repeat(40);
const CATALOG = 'c'.repeat(40);
const REPO = 'voyager163/liftoff';
const NOW = Date.parse('2026-09-14T20:00:00.000Z');
const START = '2026-09-14T19:00:00.000Z';
const WITNESS = '2026-09-14T19:31:00.000Z';
const END = '2026-09-14T19:40:00.000Z';
const EXPIRY = '2026-09-14T21:00:00.000Z';
const root = path.join(process.env.LIFTOFF_RELEASE_TEST_PARENT ?? path.join(process.cwd(), 'tests'), `.release-gate-fixture-${randomUUID()}`);
const evidenceRoot = path.join(root, 'build', 'release-evidence');
const python = process.platform === 'win32' ? 'python' : 'python3';
const key = generateKeyPairSync('ed25519');
const saved = new Map<string, Buffer>();
const signatures = new Map<string, Buffer>();
const apiResponses = new Map<string, any>();
const fileOrigins = new Map<string, any>();
let scope: any;
let base: any;
let context: any;
let subject: any;
let binding: any;
let manifest: any;
let contracts: any;
let fault: ((args: string[], value: any) => any) | undefined;

function write(relative: string, content: string | Buffer) {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
  return absolute;
}

function writeJson(relative: string, value: unknown) {
  return write(relative, `${JSON.stringify(value, null, 2)}\n`);
}

function remember(file: string) {
  saved.set(file, fs.readFileSync(file));
}

function signedPointer(relative: string, origin: any) {
  const file = inspectFile(evidenceRoot, relative);
  signatures.set(file.absolutePath, sign(null, fs.readFileSync(file.absolutePath), key.privateKey));
  fileOrigins.set(file.absolutePath, origin);
  remember(file.absolutePath);
  return { path: relative, sha256: file.sha256, origin };
}

function checks(ids: readonly string[]) {
  return ids.map((id) => ({ id, passed: 1, failed: 0, skipped: 0 }));
}

function measuredHost(target: string, minimum = false) {
  const [os, arch] = target.split('-');
  if (os === 'linux') return { os, arch, kernelRelease: minimum ? '4.18.0-513.el8' : '6.8.0-1041-azure', glibcVersion: minimum ? '2.31' : '2.39' };
  if (os === 'darwin') return { os, arch, kernelRelease: minimum ? '22.6.0' : '24.6.0', darwinRelease: minimum ? '22.6.0' : '24.6.0', hostVersion: minimum ? '13.5' : '15.6.1' };
  return { os, arch, kernelRelease: minimum ? '10.0.17763' : '10.0.26100', windowsBuild: minimum ? 17763 : 26100 };
}

function policy(name: string, kinds: string[], index: number, target?: string) {
  const workflowPath = `.github/workflows/${name}.yml`;
  const value = {
    repositoryId: '123', workflowId: String(100 + index), path: workflowPath,
    kinds, sourceRef: 'refs/heads/main', signerWorkflow: `${REPO}/${workflowPath}`,
    signerCommit: SIGNER, signerRef: 'refs/heads/main', event: 'workflow_dispatch',
    runnerEnvironment: 'github-hosted', requiredJobs: [`measured-${name}`],
    artifactName: `evidence-${name}`, maxAgeSeconds: 7200, ...(target ? { nativeTarget: target } : {})
  };
  const origin = { workflow: name, runId: String(1000 + index), runAttempt: 1 };
  const run = {
    id: Number(origin.runId), run_attempt: 1, repository: { id: 123, full_name: REPO, private: false },
    head_repository: { id: 123, full_name: REPO, private: false }, head_sha: SOURCE, head_commit: { id: SOURCE },
    path: workflowPath, workflow_id: Number(value.workflowId), event: 'workflow_dispatch',
    head_branch: 'main', status: 'completed', conclusion: 'success', run_started_at: START,
    updated_at: END, actor: { id: 1, login: 'controlled-maintainer', type: 'User' },
    triggering_actor: { id: 1, login: 'controlled-maintainer', type: 'User' }
  };
  const matrix = scope.nativeQualificationMatrix.find((entry: any) => entry.target === target);
  const jobs = {
    total_count: 1, jobs: [{ id: 3000 + index, run_id: run.id, head_sha: SOURCE, name: value.requiredJobs[0],
      status: 'completed', conclusion: 'success', labels: [matrix?.runnerLabel ?? 'ubuntu-latest'],
      runner_id: 4000 + index, runner_name: `controlled-${name}`, started_at: START, completed_at: END }]
  };
  const artifacts = {
    total_count: 1, artifacts: [{ id: 5000 + index, name: value.artifactName, expired: false,
      digest: `sha256:${'d'.repeat(64)}`, size_in_bytes: 1024, created_at: WITNESS, expires_at: EXPIRY,
      workflow_run: { id: run.id, head_sha: SOURCE, repository_id: 123, head_repository_id: 123 } }]
  };
  const baseEndpoint = `repos/${REPO}/actions/runs/${origin.runId}`;
  apiResponses.set(baseEndpoint, run);
  apiResponses.set(`${baseEndpoint}/attempts/1`, structuredClone(run));
  apiResponses.set(`${baseEndpoint}/attempts/1/jobs?per_page=100&page=1`, jobs);
  apiResponses.set(`${baseEndpoint}/artifacts?per_page=100&page=1`, artifacts);
  apiResponses.set(`repos/${REPO}/actions/workflows/${value.workflowId}`, { id: Number(value.workflowId), path: value.path, state: 'active' });
  return { policy: value, origin };
}

function retime(origin: any, start: string, witness: string, end: string) {
  const endpoint = `repos/${REPO}/actions/runs/${origin.runId}`;
  for (const name of [endpoint, `${endpoint}/attempts/1`]) Object.assign(apiResponses.get(name), { run_started_at: start, updated_at: end });
  Object.assign(apiResponses.get(`${endpoint}/attempts/1/jobs?per_page=100&page=1`).jobs[0], { started_at: start, completed_at: end });
  apiResponses.get(`${endpoint}/artifacts?per_page=100&page=1`).artifacts[0].created_at = witness;
}

function attestation(filePath: string) {
  const origin = fileOrigins.get(filePath);
  const trusted = scope.verification.workflows[origin.workflow];
  const sourceCommit = apiResponses.get(`repos/${REPO}/actions/runs/${origin.runId}`).head_sha;
  const uri = `https://github.com/${trusted.signerWorkflow}@${trusted.signerRef}`;
  return [{
    verificationResult: {
      signature: { certificate: {
        issuer: 'https://token.actions.githubusercontent.com', sourceRepositoryURI: `https://github.com/${REPO}`,
        sourceRepositoryIdentifier: '123', sourceRepositoryDigest: sourceCommit, sourceRepositoryRef: trusted.sourceRef,
        buildSignerDigest: SIGNER, buildSignerURI: uri, subjectAlternativeName: uri,
        buildConfigURI: `https://github.com/${REPO}/${trusted.path}@${trusted.sourceRef}`,
        buildConfigDigest: sourceCommit, buildTrigger: trusted.event,
        runInvocationURI: `https://github.com/${REPO}/actions/runs/${origin.runId}/attempts/1`,
        runnerEnvironment: trusted.runnerEnvironment
      } },
      statement: { _type: 'https://in-toto.io/Statement/v1', predicateType: 'https://slsa.dev/provenance/v1',
        subject: [{ name: origin.workflow === 'fixture-gateway-image' ? scope.verification.telemetryGateway.image.split('@')[0] : path.basename(filePath),
          digest: { sha256: sha256(fs.readFileSync(filePath)) } }] },
      verifiedTimestamps: [{ type: 'tlog', uri: 'https://rekor.sigstore.dev',
        timestamp: apiResponses.get(`repos/${REPO}/actions/runs/${origin.runId}/artifacts?per_page=100&page=1`).artifacts[0].created_at }]
    }
  }];
}

async function commands(args: string[]) {
  let value: any;
  if (args[0] === 'api') {
    const endpoint = args.at(-1)!;
    if (!apiResponses.has(endpoint)) throw new Error(`Unregistered fixture API: ${endpoint}`);
    value = structuredClone(apiResponses.get(endpoint));
    expect(args).toContain('--method');
    expect(args[args.indexOf('--method') + 1]).toBe('GET');
    expect(args[args.indexOf('--hostname') + 1]).toBe('github.com');
  } else {
    expect(args.slice(0, 2)).toEqual(['attestation', 'verify']);
    const filePath = args[2]!;
    const signature = signatures.get(filePath);
    if (!signature || !verify(null, fs.readFileSync(filePath), key.publicKey, signature)) throw new Error('Controlled fixture cryptographic signature verification failed');
    expect(args[args.indexOf('--repo') + 1]).toBe(REPO);
    expect(args[args.indexOf('--source-digest') + 1]).toBe(apiResponses.get(`repos/${REPO}/actions/runs/${fileOrigins.get(filePath).runId}`).head_sha);
    expect(args[args.indexOf('--signer-digest') + 1]).toBe(SIGNER);
    expect(args).toContain('--cert-identity');
    expect(args).toContain('--deny-self-hosted-runners');
    value = attestation(filePath);
  }
  return fault ? fault(args, value) : value;
}

function fixture() {
  return {
    name: 'controlled Ed25519 files and pinned GitHub-response fixtures; not production',
    now: NOW, commands,
    verifySource: (_projectRoot: string, commit: string) => {
      if (commit !== SOURCE) throw new Error('Fixture reviewed source mismatch');
      return { sourceCommit: SOURCE };
    },
    loadContracts: async () => contracts
  };
}

function evaluate(input = structuredClone(base), options: Record<string, unknown> = {}) {
  return evaluateReleaseGateFixture(input, { projectRoot: root, evidenceRoot: 'build/release-evidence', ...options }, fixture());
}

function updateReport(input: any, id: string, mutate: (report: any) => void) {
  const pointer = input.reports[id];
  const absolute = path.join(evidenceRoot, pointer.path);
  const report = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  mutate(report);
  fs.writeFileSync(absolute, JSON.stringify(report));
  pointer.sha256 = sha256(fs.readFileSync(absolute));
  signatures.set(absolute, sign(null, fs.readFileSync(absolute), key.privateKey));
}

function updateExecutions(input: any, mutate: (report: any) => void) {
  const pointer = input.executionReports[0];
  const absolute = path.join(evidenceRoot, pointer.path);
  const report = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  mutate(report);
  fs.writeFileSync(absolute, JSON.stringify(report));
  pointer.sha256 = sha256(fs.readFileSync(absolute));
  signatures.set(absolute, sign(null, fs.readFileSync(absolute), key.privateKey));
}

function makeArchive(target: string, destination: string, mutate?: (bundle: string) => void,
  archiveRoot = `liftoff-v0.13.0-${target}`) {
  const bundle = path.join(root, 'bundle');
  fs.rmSync(bundle, { recursive: true, force: true });
  fs.mkdirSync(bundle, { recursive: true });
  const shipping = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).files;
  for (const asset of inventoryTree(path.join(root, 'assets'))) {
    const name = `assets/${asset.path}`;
    if (shipping.some((entry: string) => name === entry || name.startsWith(`${entry}/`))) {
      copyInventoriedFile(root, bundle, { ...asset, path: name });
    }
  }
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(bundle, 'LICENSE'));
  fs.copyFileSync(path.join(root, 'package.json'), path.join(bundle, 'package.json'));
  for (const name of Object.keys(context.documentationFiles)) {
    fs.mkdirSync(path.dirname(path.join(bundle, name)), { recursive: true });
    fs.copyFileSync(path.join(root, name), path.join(bundle, name));
  }
  const payload = manifest.targets[target];
  const runtime = Buffer.alloc(256);
  if (target.startsWith('linux')) {
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(runtime);
    runtime.writeUInt16LE(target.endsWith('x64') ? 62 : 183, 18);
  } else if (target.startsWith('darwin')) {
    runtime.writeUInt32LE(0xfeedfacf, 0);
    runtime.writeUInt32LE(target.endsWith('x64') ? 0x1000007 : 0x100000c, 4);
  } else {
    runtime.write('MZ'); runtime.writeUInt32LE(0x80, 0x3c);
    runtime.write('PE\0\0', 0x80); runtime.writeUInt16LE(target.endsWith('x64') ? 0x8664 : 0xaa64, 0x84);
  }
  const nativeWrite = (name: string, value: string | Buffer) => {
    const file = path.join(bundle, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value, { mode: 0o755 });
  };
  nativeWrite(target.startsWith('win32') ? 'runtime/node.exe' : 'runtime/node', runtime);
  nativeWrite(target.startsWith('win32') ? 'bin/liftoff.exe' : 'bin/liftoff', target.startsWith('win32') ? runtime : 'fixture launcher; never executed\n');
  nativeWrite('dist/cli.js', '/* controlled archive fixture, not an executable qualification */\n');
  for (const compiledPath of new Set(EMBEDDED_NATIVE_HELPERS.map((helper) => helper.compiledPath))) {
    nativeWrite(compiledPath, fs.readFileSync(path.join(root, compiledPath)));
  }
  nativeWrite('build-info.json', JSON.stringify(nativeBuildInfoDocument({
    version: '0.13.0', sourceCommit: SOURCE, target, nodeVersion: '24.20.0', builtAt: START,
    resourcesDigest: JSON.parse(fs.readFileSync(path.join(bundle, 'assets/templates/catalog.json'), 'utf8')).digest,
    profilesDigest: JSON.parse(fs.readFileSync(path.join(bundle, 'assets/profiles/catalog.json'), 'utf8')).digest
  })));
  nativeWrite('liftoff-build-manifest.json', JSON.stringify({ schemaVersion: 1, product: 'liftoff', version: '0.13.0',
    sourceCommit: SOURCE, target, runtime: payload.runtime, resources: payload.resources, builtAt: START }));
  mutate?.(bundle);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  execFileSync(python, ['-c', [
    'import pathlib,sys,tarfile,zipfile',
    'root=pathlib.Path(sys.argv[1]); dest=sys.argv[2]; prefix=sys.argv[3]',
    'def archive_name(p): return "/".join(part for part in (prefix,p.relative_to(root).as_posix()) if part)',
    'if dest.endswith(".zip"):',
    ' with zipfile.ZipFile(dest,"w",zipfile.ZIP_DEFLATED) as z:',
    '  for p in sorted(root.rglob("*")):',
    '   if p.is_file(): z.write(p,archive_name(p))',
    'else:',
    ' with tarfile.open(dest,"w:gz") as t:',
    '  for p in sorted(root.rglob("*")):',
    '   if p.is_file(): t.add(p,arcname=archive_name(p),recursive=False)'
  ].join('\n'), bundle, destination, archiveRoot], { timeout: 30000 });
}

function updateArchive(input: any, target: string, mutate: (bundle: string) => void, archiveRoot?: string) {
  const pointer = input.artifacts[target];
  const destination = path.join(evidenceRoot, pointer.path);
  makeArchive(target, destination, mutate, archiveRoot);
  pointer.sha256 = sha256(fs.readFileSync(destination));
  signatures.set(destination, sign(null, fs.readFileSync(destination), key.privateKey));
  const file = path.join(evidenceRoot, input.manifest.path);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.targets[target].checksumSha256 = pointer.sha256;
  fs.writeFileSync(file, JSON.stringify(raw));
  input.manifest.sha256 = sha256(fs.readFileSync(file));
  signatures.set(file, sign(null, fs.readFileSync(file), key.privateKey));
}

beforeAll(async () => {
  fs.mkdirSync(evidenceRoot, { recursive: true });
  scope = JSON.parse(fs.readFileSync('assets/qualification/release-scope.json', 'utf8'));
  const definitions = ['LICENSE', 'assets/templates/catalog.json', 'assets/profiles/catalog.json',
    'assets/skills/catalog.json', 'assets/supported-stack.json', 'assets/repair/windows-job-controller.ps1',
    'infrastructure/opentofu/telemetry/dashboard.json', 'scripts/release-evidence-archive.py',
    TELEMETRY_CONTRACT_PATH, TELEMETRY_BASELINE_FIXTURE,
    'services/telemetry-ingest/src/handler.ts', 'services/telemetry-ingest/src/server.ts', 'services/telemetry-ingest/src/index.ts'];
  const catalog = JSON.parse(fs.readFileSync('assets/templates/catalog.json', 'utf8'));
  const sourcePackage = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  definitions.push(...Object.keys(collectPublicDocumentInventory(process.cwd(), sourcePackage.files)));
  definitions.push(...EMBEDDED_NATIVE_HELPERS.map((helper) => helper.path));
  for (const resource of Object.values(catalog.resources) as any[]) definitions.push(resource.path);
  for (const relative of new Set(definitions)) write(relative, fs.readFileSync(relative));
  for (const helper of EMBEDDED_NATIVE_HELPERS) {
    write(helper.compiledPath, transformSync(helper.path, fs.readFileSync(helper.path, 'utf8'), { lang: 'ts' }).code);
  }
  for (const resource of Object.values(catalog.resources) as any[]) {
    const bytes = fs.readFileSync(path.join(root, resource.path));
    resource.digest = `sha256:${sha256(bytes)}`; resource.size = bytes.length;
  }
  for (const component of Object.values(catalog.components) as any[]) component.digest = computeComponentDigest(component, catalog.resources);
  catalog.digest = computeTemplateCatalogDigest(catalog);
  writeJson('assets/templates/catalog.json', catalog);
  for (const capability of scope.capabilities) fs.mkdirSync(path.join(root, 'openspec/changes/modernize-liftoff-platform/specs', capability.id), { recursive: true });
  const pkg = { name: '@msn-control/liftoff', version: '0.13.0', license: 'GPL-3.0-only',
    repository: { url: `git+https://github.com/${REPO}.git` }, files: sourcePackage.files };
  writeJson('package.json', pkg);
  writeJson('package-lock.json', { name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': pkg } });
  for (const relative of ['src/main.ts', 'services/telemetry-ingest/src/main.ts',
    'assets/governance/single-maintainer-gitflow/activation-v4-policy7-reader/domain/reader.js',
    'assets/governance/single-maintainer-gitflow/activation-v3-reader/domain/reader.js', 'scripts/distribution/assemble.mjs',
    'scripts/capture-activation-v3-baseline.mjs', 'src/verify.ts']) write(relative, 'export const example = 1;\n');
  const common = policy('fixture-common', REQUIRED_REPORT_IDS.filter((id) => !id.startsWith('native-')).concat(['native-manifest', 'native-artifact', 'evidence-collection']), 0);
  const origins: Record<string, any> = {};
  scope.verification = {
    schemaVersion: 1, collectionWorkflow: 'fixture-common', workflows: { 'fixture-common': common.policy },
    nativeSigning: { workflow: 'fixture-common', identities: Object.fromEntries(REQUIRED_NATIVE_TARGETS.map((target: string) => [target, `controlled-${target}-signer`])) },
    minimumNativeHosts: {},
    authorities: {}, qualificationPlans: {},
    channels: {
      homebrewCask: { repository: REPO, ref: 'refs/heads/main', packageId: nativeContracts.canonicalHomebrewCask, paths: { cask: 'Casks/liftoff.rb' } },
      winget: { repository: 'microsoft/winget-pkgs', ref: 'refs/heads/master', packageId: nativeContracts.canonicalWinGetId, publisher: 'Controlled Fixture Publisher',
        paths: { version: 'manifests/version.yaml', installer: 'manifests/installer.yaml', locale: 'manifests/locale.yaml' } },
      linuxDirect: { repository: REPO, packageId: 'liftoff' }
    }
  };
  for (const [index, target] of REQUIRED_NATIVE_TARGETS.entries()) {
    const configured = policy(`fixture-${target}`, [`native-${target}`], index + 1, target);
    scope.verification.workflows[`fixture-${target}`] = configured.policy;
    origins[`native-${target}`] = configured.origin;
    const minimum = policy(`fixture-minimum-${target}`, [`native-minimum-${target}`], 20 + index, target);
    const runnerLabels = [`controlled-minimum-${target}`];
    apiResponses.get(`repos/${REPO}/actions/runs/${minimum.origin.runId}/attempts/1/jobs?per_page=100&page=1`).jobs[0].labels = runnerLabels;
    scope.verification.workflows[minimum.origin.workflow] = minimum.policy;
    scope.verification.minimumNativeHosts[target] = { workflow: minimum.origin.workflow, job: minimum.policy.requiredJobs[0], runnerLabels };
    origins[`native-minimum-${target}`] = minimum.origin;
  }
  const collection = policy('fixture-collection', ['evidence-collection'], 10);
  const approval = policy('fixture-approval', ACTION_PURPOSES.map((purpose: string) => `authority-${purpose}`), 11);
  const execution = policy('fixture-execution', ['qualification-execution'], 12);
  const observation = policy('fixture-observation', ['qualification-case', 'telemetry-gateway'], 13);
  const nativeSigning = policy('fixture-native-signing', ['native-manifest', 'native-artifact'], 14);
  nativeSigning.policy.maxAgeSeconds = 10800;
  const gatewayImage = policy('fixture-gateway-image', ['telemetry-gateway-image'], 15);
  gatewayImage.policy.maxAgeSeconds = 10800;
  for (const item of [collection, approval, execution, observation, nativeSigning, gatewayImage]) scope.verification.workflows[item.origin.workflow] = item.policy;
  scope.verification.collectionWorkflow = collection.origin.workflow;
  scope.verification.nativeSigning.workflow = nativeSigning.origin.workflow;
  retime(nativeSigning.origin, '2026-09-14T18:20:00.000Z', '2026-09-14T18:29:00.000Z', '2026-09-14T18:30:00.000Z');
  retime(gatewayImage.origin, '2026-09-14T18:05:00.000Z', '2026-09-14T18:14:00.000Z', '2026-09-14T18:15:00.000Z');
  const imageRun = `repos/${REPO}/actions/runs/${gatewayImage.origin.runId}`;
  for (const endpoint of [imageRun, `${imageRun}/attempts/1`]) {
    apiResponses.get(endpoint).head_sha = GATEWAY_SOURCE;
    apiResponses.get(endpoint).head_commit.id = GATEWAY_SOURCE;
  }
  apiResponses.get(`${imageRun}/attempts/1/jobs?per_page=100&page=1`).jobs[0].head_sha = GATEWAY_SOURCE;
  apiResponses.get(`${imageRun}/artifacts?per_page=100&page=1`).artifacts[0].workflow_run.head_sha = GATEWAY_SOURCE;
  const oci = { schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: `sha256:${'f'.repeat(64)}`, size: 100 },
    layers: [{ mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: `sha256:${'a'.repeat(64)}`, size: 200 }] };
  writeJson('build/release-evidence/manifest/gateway-image.json', oci);
  scope.verification.telemetryGateway = {
    schemaVersion: 1, resourceId: '/subscriptions/00000000-0000-4000-8000-000000000000/resourceGroups/fixture/providers/Microsoft.App/containerApps/fixture-gateway',
    revision: 'fixture-gateway--qualified', container: 'telemetry-ingest',
    image: `fixture.azurecr.io/telemetry-ingest@sha256:${sha256(fs.readFileSync(path.join(evidenceRoot, 'manifest/gateway-image.json')))}`,
    sourceCommit: GATEWAY_SOURCE, workflow: observation.origin.workflow, imageWorkflow: gatewayImage.origin.workflow,
    apiVersion: '2025-01-01', maxAgeSeconds: 3600
  };
  const gatewayImagePointer = signedPointer('manifest/gateway-image.json', gatewayImage.origin);
  origins['telemetry-gateway'] = observation.origin;
  for (const sourcePath of [TELEMETRY_CONTRACT_PATH, 'services/telemetry-ingest/src/handler.ts', 'services/telemetry-ingest/src/server.ts', 'services/telemetry-ingest/src/index.ts']) {
    apiResponses.set(`repos/${REPO}/contents/${sourcePath}?ref=${GATEWAY_SOURCE}`, {
      type: 'file', path: sourcePath, encoding: 'base64', content: fs.readFileSync(path.join(root, sourcePath)).toString('base64')
    });
  }
  retime(collection.origin, '2026-09-14T18:40:00.000Z', '2026-09-14T18:49:00.000Z', '2026-09-14T18:50:00.000Z');
  retime(approval.origin, '2026-09-14T18:51:00.000Z', '2026-09-14T18:59:00.000Z', '2026-09-14T19:00:00.000Z');
  retime(execution.origin, '2026-09-14T19:05:00.000Z', '2026-09-14T19:14:00.000Z', '2026-09-14T19:15:00.000Z');
  retime(observation.origin, '2026-09-14T19:16:00.000Z', '2026-09-14T19:29:00.000Z', '2026-09-14T19:30:00.000Z');
  for (const purpose of ACTION_PURPOSES) {
    scope.verification.authorities[purpose] = { mechanism: 'github-explicit-dispatch-v1', workflow: approval.origin.workflow,
      allowedActors: [{ id: 1, type: 'User', role: 'maintainer' }], maxAgeSeconds: 10800 };
    origins[`authority-${purpose}`] = approval.origin;
  }
  apiResponses.set(`repos/${REPO}/collaborators/controlled-maintainer/permission`, { user: { id: 1 }, permission: 'write', role_name: 'maintain' });
  const source = (name: string) => ({ path: name, sha256: sha256(fs.readFileSync(path.join(root, name))) });
  const dashboardId = JSON.parse(fs.readFileSync(path.join(root, 'infrastructure/opentofu/telemetry/dashboard.json'), 'utf8')).uid;
  const telemetry = loadTelemetryReleaseContract(root, scope, telemetryContract);
  const registration: any = {
    schemaVersion: 1,
    profiles: { 'python-fastapi': { kind: 'standards', source: source('assets/profiles/catalog.json') },
      [dashboardId]: { kind: 'operator', source: source('infrastructure/opentofu/telemetry/dashboard.json') },
      [TELEMETRY_PROFILE_ID]: { kind: 'telemetry', source: source(TELEMETRY_CONTRACT_PATH) } },
    hosts: {
      executor: { role: 'executor', workflow: execution.origin.workflow, job: execution.policy.requiredJobs[0], runnerLabels: ['ubuntu-latest'], runnerEnvironment: 'github-hosted' },
      verifier: { role: 'verifier', workflow: observation.origin.workflow, job: observation.policy.requiredJobs[0], runnerLabels: ['ubuntu-latest'], runnerEnvironment: 'github-hosted' }
    },
    recipes: {}, producers: {}, dashboard: {}, telemetryGateway: {}
  };
  const planEntries: Record<string, any[]> = Object.fromEntries(QUALIFICATION_PURPOSES.map((purpose: string) => [purpose, []]));
  const producerGroups = [
    ...canonicalPhaseGraph.phases.map((phase) => ({ id: phase.id, digest: canonicalPhaseContractDigests[phase.id],
      providers: phase.evidence.liveReadbackProviders.length ? phase.evidence.liveReadbackProviders : ['local'],
      operation: phase.allowedMutations.local[0], purpose: 'liveQualification', profile: 'python-fastapi' })),
    { id: 'operator-dashboard', digest: source('infrastructure/opentofu/telemetry/dashboard.json').sha256,
      providers: ['azure'], operation: 'azure-dashboard-write', purpose: 'dashboard', profile: dashboardId },
    { id: 'telemetry-gateway', digest: telemetry.sha256, providers: ['azure'], operation: 'qualify-gateway-image',
      purpose: 'telemetryGateway', profile: TELEMETRY_PROFILE_ID }
  ];
  const target = (provider: string) => provider === 'local' ? { rootId: 'controlled-disposable-root', path: 'qualification/record.json' } :
    provider === 'github' ? { repository: 'controlled/disposable-fixture', kind: 'repository', id: 'fixture' } :
      { resourceId: '/subscriptions/00000000-0000-4000-8000-000000000000/resourceGroups/fixture/providers/Microsoft.Dashboard/dashboards/fixture' };
  for (const group of producerGroups) {
    const producer: any = { contractDigest: group.digest, cases: [] };
    for (const provider of group.providers) {
      const recipe = `fixture-${group.id}-${provider}`;
      const readbackOperation = provider === 'local' ? 'read-worktree' : provider === 'github' ? 'github-read' : 'azure-read';
      registration.recipes[recipe] = { producer: group.id, provider, source: source('src/main.ts'), verifierSource: source('src/verify.ts'),
        verificationHost: 'verifier', operations: [group.operation], verificationOperations: [readbackOperation] };
      for (const outcome of ['success', 'failure', 'recovery']) {
        const id = `${recipe}-${outcome}`;
        producer.cases.push({ id, provider, executionHost: 'executor', recipe, profile: group.profile, outcome });
        const executionProvider = group.id === 'operator-dashboard' ? 'azure' : 'local';
        const effects = [
          { id: 'execute', stage: 'execution', type: executionProvider, operation: group.operation, target: target(executionProvider), requestSha256: sha256(`${id}:execute`) },
          { id: 'readback', stage: 'verification', type: provider, operation: readbackOperation, target: target(provider), requestSha256: sha256(`${id}:readback`) }
        ];
        if (group.purpose === 'telemetryGateway') {
          effects[0]!.requestSha256 = sha256(canonicalJson(gatewayImageTestRequest({ scope, telemetry })));
          effects[1]!.target = { resourceId: scope.verification.telemetryGateway.resourceId };
        }
        planEntries[group.purpose]!.push({ caseId: id, principals: { execution: 'controlled-executor-principal', verification: 'controlled-readback-principal' },
          effects, expectedEffectIds: outcome === 'failure' && group.purpose !== 'telemetryGateway' ? ['readback'] : ['execute', 'readback'] });
      }
    }
    if (group.id === 'operator-dashboard') registration.dashboard = producer;
    else if (group.id === 'telemetry-gateway') registration.telemetryGateway = producer;
    else registration.producers[group.id] = producer;
  }
  scope.verification.qualificationRegistry = registration;
  for (const purpose of QUALIFICATION_PURPOSES) scope.verification.qualificationPlans[purpose] = [{
    schemaVersion: 2, id: `controlled-${purpose}`, purpose, entries: planEntries[purpose],
    maxCost: { minorUnits: 100000, currency: 'USD' }, maxDurationSeconds: 3600,
    notBefore: '2026-09-14T18:50:00.000Z', expiresAt: EXPIRY, retention: 'retain-evidence-and-separately-approve-recovery'
  }];
  apiResponses.set(`repos/${REPO}/commits/${SOURCE}`, { sha: SOURCE, html_url: `https://github.com/${REPO}/commit/${SOURCE}` });
  writeJson('assets/qualification/release-scope.json', scope);
  const publicCapabilities = buildPublicCapabilitiesEnvelope();
  const nativePrograms: Record<string, string> = {
    darwinStateSystemProgram, posixStateLockProgram, linuxPosixStateLockProgram,
    linuxReadonlyProcessProgram, nativeStatePythonVersionProbe
  };
  contracts = {
    nativeHelperPrograms: Object.fromEntries(EMBEDDED_NATIVE_HELPERS.map((helper) => [helper.id, {
      program: nativePrograms[helper.programExport],
      compiledSha256: sha256(fs.readFileSync(path.join(root, helper.compiledPath)))
    }])),
    verifyReleaseIdentity, native: nativeContracts, graph: canonicalPhaseGraph, phaseGraphHash: canonicalPhaseGraphHash,
    phaseDigests: canonicalPhaseContractDigests,
    phaseIds, computePhaseDigests: phaseContractDigests, canonicalSha256,
    phases: Object.fromEntries(Object.entries(phaseCapabilities).map(([id, value]) => [id, { ...value, executor: 'built-in', implementation: 'complete' }])),
    publicCapabilities: { ...publicCapabilities, capabilities: publicCapabilities.capabilities.map((capability) =>
      ({ ...capability, executor: 'built-in', verifier: 'built-in', qualificationState: 'unqualified' })) },
    validatePublicCapabilities: validatePublicCapabilitiesEnvelope,
    skillCatalog: loadCanonicalSkillCatalog(), skillIds: CANONICAL_SKILL_IDS, skillHosts: SUPPORTED_SKILL_HOSTS,
    validateSkillMetadata: validateSkillCatalogMetadata, validateSkillCatalog: validateEnrichedSkillCatalog,
    projectSkillForHost, renderRetainedProjectSkill, retainedSkillIntegrations: governanceAgentIntegrations, governanceProfiles,
    repair: { contractVersion: repairContractVersion, schemas: repairSchemaVersions, recipes: repairRecipes,
      recoveryCompatibility: repairRecoveryCompatibility, capabilities: repairCapabilities },
    validateProfiles: validateStandardsProfileCatalog, validateResources: validateTemplateCatalog,
    telemetry: telemetryContract, validateNativeBuildInfo, computeResourceInventorySummary
  };
  context = await loadReleaseContext(root, SOURCE, contracts);
  context.qualificationRegistry = loadQualificationRegistry(context);
  manifest = { schemaVersion: 1, product: 'liftoff', version: '0.13.0', sourceCommit: SOURCE, publishedAt: START, targets: {} };
  base = { schemaVersion: 1, kind: EVIDENCE_KIND, product: 'liftoff', version: '0.13.0', sourceCommit: SOURCE, artifacts: {}, reports: {}, executionReports: [] };
  for (const target of REQUIRED_NATIVE_TARGETS) {
    const [os, arch] = target.split('-');
    const format = os === 'win32' ? 'zip' : 'tar.gz';
    const filename = `liftoff-v0.13.0-${target}.${format}`;
    manifest.targets[target] = {
      os, arch, archiveFormat: format, archiveUrl: `https://github.com/${REPO}/releases/download/v0.13.0/${filename}`,
      checksumSha256: 'd'.repeat(64), signatureUrl: `https://github.com/${REPO}/releases/download/v0.13.0/${filename}.sig`,
      provenanceUrl: `https://github.com/${REPO}/releases/download/v0.13.0/${filename}.intoto.jsonl`,
      runtime: { nodeVersion: '24.20.0', ...nativeContracts.nativeTargetFloors[os as keyof typeof nativeContracts.nativeTargetFloors] },
      resources: computeResourceInventorySummary(catalog)
    };
    const relative = `artifacts/${filename}`;
    makeArchive(target, path.join(evidenceRoot, relative));
    base.artifacts[target] = signedPointer(relative, nativeSigning.origin);
    manifest.targets[target].checksumSha256 = base.artifacts[target].sha256;
  }
  writeJson('build/release-evidence/manifest/native-release.json', manifest);
  base.manifest = signedPointer('manifest/native-release.json', nativeSigning.origin);
  const identities: Record<string, any> = {};
  for (const target of REQUIRED_NATIVE_TARGETS) {
    const file = inspectFile(evidenceRoot, base.artifacts[target].path, base.artifacts[target].sha256);
    identities[target] = verifyNativeArchiveContents(inspectNativeArchive(file, manifest.targets[target].archiveFormat, target, root), manifest.targets[target], target, context);
  }
  subject = buildReleaseSubject(context, inspectFile(evidenceRoot, base.manifest.path), identities);
  const subjectSha256 = sha256(canonicalJson(subject));
  binding = { product: 'liftoff', version: '0.13.0', repository: REPO, sourceCommit: SOURCE, releaseSubjectSha256: subjectSha256 };
  const reportData: Record<string, any> = {
    build: { targets: identities, checks: checks(['compile', 'runtime-dependencies', 'resource-inventory', 'license-notices']) },
    qualification: { registrySha256: context.registrySha256, cases: checks(context.cases.map((entry: any) => entry.id)),
      checks: checks(['compatibility-readers', 'documentation-inventory', 'source-typecheck', 'cross-platform-boundaries']) },
    dashboard: { definition: context.dashboard, checks: checks(DASHBOARD_CHECKS) }
  };
  const gateway = scope.verification.telemetryGateway;
  reportData['telemetry-gateway'] = {
    registration: gateway, contract: context.telemetry, imageManifest: gatewayImagePointer,
    deployment: { provider: 'azure-resource-manager', method: 'GET', apiVersion: gateway.apiVersion,
      resourceId: gateway.resourceId, revision: gateway.revision, container: gateway.container, image: gateway.image,
      provisioningState: 'Provisioned', healthState: 'Healthy', active: true, traffic: [{ revision: gateway.revision, weight: 100 }],
      allowInsecure: false, observedAt: '2026-09-14T19:28:00.000Z' },
    imageInspection: { image: gateway.image, configDigest: oci.config.digest, os: 'linux', architecture: 'amd64',
      entrypoint: 'packaged-createTelemetryServer', network: 'none', destination: 'loopback', ingestionSink: 'recording-stub' },
    testRequestSha256: sha256(canonicalJson(gatewayImageTestRequest(context))),
    accepted: telemetryAcceptanceCases(context.telemetry).map((entry: any) => ({ ...entry, status: 204, sinkRecordCount: 1, sinkFields: [...telemetryContract.telemetryStorageFields] })),
    rejected: telemetryGatewayRejectionCases.map((id: string) => ({ id, status: id === 'oversized-stream' ? 413 : id === 'wrong-method' ? 405 : id === 'wrong-content-type' ? 415 : 400, sinkRecordCount: 0 })),
    caseIds: context.qualificationRegistry.cases.filter((row: any) => row.purpose === 'telemetryGateway').map((row: any) => row.id)
  };
  for (const target of REQUIRED_NATIVE_TARGETS) for (const minimum of [false, true]) {
    const payload = manifest.targets[target];
    const id = `${minimum ? 'native-minimum' : 'native'}-${target}`;
    const job = apiResponses.get(`repos/${REPO}/actions/runs/${origins[id]!.runId}/attempts/1/jobs?per_page=100&page=1`).jobs[0];
    reportData[id] = {
      target, execution: 'native-installed', host: measuredHost(target, minimum),
      jobId: String(job.id), observedAt: '2026-09-14T19:20:00.000Z',
      installedVersionOutput: 'Liftoff 0.13.0', identity: identities[target],
      signatureIdentity: scope.verification.nativeSigning.identities[target], checks: checks(NATIVE_CHECKS),
      helpers: identities[target].helpers.map((helper: any) => ({
        id: helper.id, sha256: helper.sha256,
        ...(helper.programExport ? { programExport: helper.programExport, programSha256: helper.programSha256 } : {}),
        activeProcesses: 0, checks: checks(HELPER_CHECKS)
      })),
      ...(payload.os === 'win32' ? { windowsRegression: { baselineCommit: scope.baseline.sourceCommit, checks: checks(scope.historicalWindowsFailure.observations.map((entry: any) => entry.id)) } } : {})
    };
  }
  const coverageInventory = getCanonicalProductionInventory(root);
  for (const [id, files] of Object.entries({ 'coverage-cli': coverageInventory.cli, 'coverage-telemetry': coverageInventory.telemetry })) {
    const metrics = (factor: number) => Object.fromEntries(['lines', 'branches', 'functions', 'statements'].map((metric) => [metric, { total: 10 * factor, covered: 9 * factor }]));
    const raw = { total: metrics(files.length), ...Object.fromEntries(files.map((file) => [file, metrics(1)])) };
    const relative = `coverage/${id}.json`;
    writeJson(`build/release-evidence/${relative}`, raw);
    remember(path.join(evidenceRoot, relative));
    reportData[id] = { format: 'istanbul-summary-v1', raw: { path: relative, sha256: sha256(fs.readFileSync(path.join(evidenceRoot, relative))) } };
  }
  const cask = renderHomebrewDefinition(manifest, scope.verification.channels.homebrewCask);
  const winget = renderWinGetDefinitions(manifest, scope.verification.channels.winget);
  const channels: any = {};
  for (const [kind, values] of Object.entries({ homebrewCask: { cask }, winget })) {
    const config = scope.verification.channels[kind];
    channels[kind] = { packageId: config.packageId, version: '0.13.0', state: 'available', catalogCommit: CATALOG, files: {} };
    apiResponses.set(`repos/${config.repository}/git/ref/${config.ref.slice(5)}`, { object: { type: 'commit', sha: CATALOG } });
    for (const [id, content] of Object.entries(values)) {
      const relative = `channels/${kind}-${id}.txt`;
      write(`build/release-evidence/${relative}`, content);
      remember(path.join(evidenceRoot, relative));
      channels[kind].files[id] = { path: relative, sha256: sha256(content) };
      apiResponses.set(`repos/${config.repository}/contents/${config.paths[id]}?ref=${CATALOG}`, { type: 'file', encoding: 'base64', path: config.paths[id], content: Buffer.from(content).toString('base64') });
    }
  }
  channels.linuxDirect = { packageId: 'liftoff', version: '0.13.0', state: 'available', releaseId: '900' };
  reportData.channels = channels;
  apiResponses.set(`repos/${REPO}/releases/900`, { id: 900, tag_name: 'v0.13.0', draft: false, prerelease: true,
    assets: Object.values(manifest.targets).map((payload: any) => ({ state: 'uploaded', browser_download_url: payload.archiveUrl, digest: `sha256:${payload.checksumSha256}` })) });
  apiResponses.set(`repos/${REPO}/git/ref/tags/v0.13.0`, { object: { type: 'commit', sha: SOURCE } });
  for (const purpose of ACTION_PURPOSES) {
    const request = buildActionRequest(context, subject, purpose, { origin: collection.origin, artifactId: '5010', archiveSha256: 'd'.repeat(64) }, NOW);
    reportData[`authority-${purpose}`] = actionApprovalReceipt(request, { id: 1, type: 'User' }, '2026-09-14T18:58:00.000Z', EXPIRY);
  }
  for (const id of REQUIRED_REPORT_IDS.filter((id: string) => id !== 'execution-qualification')) {
    const relative = `reports/${id}.json`;
    writeJson(`build/release-evidence/${relative}`, { schemaVersion: 1, kind: 'liftoff-release-report', type: id, binding, data: reportData[id] });
    base.reports[id] = signedPointer(relative, origins[id] ?? common.origin);
  }
  const measured = context.qualificationRegistry.cases.map((row: any) => {
    const plan = scope.verification.qualificationPlans[row.purpose][0];
    const entry = plan.entries.find((item: any) => item.caseId === row.id);
    return { case: row, planId: plan.id, approvalSha256: base.reports[`authority-${row.purpose}`].sha256,
      execution: { origin: execution.origin, jobId: '3012' }, verificationJobId: '3013',
      startedAt: '2026-09-14T19:05:00.000Z', completedAt: '2026-09-14T19:15:00.000Z', principals: entry.principals,
      effects: entry.expectedEffectIds.map((id: string) => entry.effects.find((effect: any) => effect.id === id)), outcome: row.outcome,
      cost: { minorUnits: 1, currency: 'USD' } };
  });
  writeJson('build/release-evidence/reports/measured-executions.json', { schemaVersion: 1, kind: 'liftoff-qualification-executions', binding, cases: measured });
  base.executionReports.push(signedPointer('reports/measured-executions.json', observation.origin));
  const verified = createGitHubEvidenceVerifier({ projectRoot: root, verification: scope.verification, sourceCommit: SOURCE, now: NOW, commands });
  const authorities: any = {};
  for (const purpose of QUALIFICATION_PURPOSES) {
    const pointer = base.reports[`authority-${purpose}`];
    const file = inspectFile(evidenceRoot, pointer.path, pointer.sha256);
    const verifiedFile = await verified.verifyFile(file, pointer.origin, `authority-${purpose}`);
    await verified.verifyAuthority(reportData[`authority-${purpose}`], pointer.origin, verifiedFile, purpose, reportData[`authority-${purpose}`].request);
    authorities[purpose] = { file, verifiedFile, data: reportData[`authority-${purpose}`] };
  }
  const executionSummary = await verifyQualificationExecutions({ context, subject, evidence: base, evidenceRoot, verifier: verified, authorities, now: NOW });
  writeJson('build/release-evidence/reports/execution-qualification.json', releaseReport('execution-qualification', subject, executionSummary));
  base.reports['execution-qualification'] = signedPointer('reports/execution-qualification.json', common.origin);
  for (const relative of ['assets/qualification/release-scope.json', 'package.json', 'package-lock.json', 'assets/repair/windows-job-controller.ps1', 'infrastructure/opentofu/telemetry/dashboard.json']) remember(path.join(root, relative));
}, 120000);

afterEach(() => {
  fault = undefined;
  for (const [file, content] of saved) {
    fs.writeFileSync(file, content);
    if (signatures.has(file)) signatures.set(file, sign(null, content, key.privateKey));
  }
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('authoritative source registry bindings', () => {
  it.each(['missing-helper', 'empty-program', 'missing-compiled-digest', 'changed-compiled-digest'])(
    'requires complete independently bound embedded-helper source: %s', async (failure) => {
      const nativeHelperPrograms = structuredClone(contracts.nativeHelperPrograms);
      const id = 'linux-readonly-process';
      if (failure === 'missing-helper') delete nativeHelperPrograms[id];
      if (failure === 'empty-program') nativeHelperPrograms[id].program = '';
      if (failure === 'missing-compiled-digest') delete nativeHelperPrograms[id].compiledSha256;
      if (failure === 'changed-compiled-digest') nativeHelperPrograms[id].compiledSha256 = '0'.repeat(64);
      await expect(loadReleaseContext(root, SOURCE, { ...contracts, nativeHelperPrograms })).rejects.toThrow();
    }
  );

  it('never loads executable contracts after reviewed source admission fails', async () => {
    const dependencies = fixture();
    dependencies.verifySource = () => { throw new Error('Controlled unreviewed source'); };
    const loader = vi.fn(async () => contracts);
    dependencies.loadContracts = loader;
    const result = await evaluateReleaseGateFixture(structuredClone(base),
      { projectRoot: root, evidenceRoot: 'build/release-evidence' }, dependencies);
    expect(loader).not.toHaveBeenCalled();
    expect(result.blockers.join(' ')).toContain('Controlled unreviewed source');
    expect(result.productionQualified).toBe(false);
  });

  it('requires an explicit reviewed source before the production contract loader imports dist', async () => {
    await expect(loadReleaseContracts(root)).rejects.toThrow('explicit immutable');
    await expect(loadReleaseContracts(root, SOURCE)).rejects.toThrow('worktree root');
  });

  it('does not let Git environment overrides turn a nested candidate into the reviewed source root', async () => {
    vi.stubEnv('GIT_DIR', path.join(process.cwd(), '.git'));
    vi.stubEnv('GIT_WORK_TREE', root);
    try {
      await expect(loadReleaseContracts(root, SOURCE)).rejects.toThrow('worktree root');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('uses the shared LF-terminated digest over a versioned complete registry binding', () => {
    expect(context.registryBindings).toMatchObject({ schemaVersion: 1, kind: 'liftoff-release-registry-bindings' });
    expect(context.registrySha256).toBe(canonicalSha256(context.registryBindings));
    expect(context.registrySha256).not.toBe(sha256(canonicalJson(context.registryBindings)));
    expect(context.registryBindings.activation.producers).toEqual(contracts.phases);
    expect(context.registryBindings.publicCapabilities.engines).toEqual(contracts.publicCapabilities.engines);
    expect(context.registryBindings.standards).toEqual({
      profilesDigest: context.profiles.digest, resourcesDigest: context.resources.digest
    });
    expect(context.registryBindings.governance.profiles).toEqual(governanceProfiles);
    expect(context.registryBindings.repair.schemas.report).toBe(repairSchemaVersions.report);
    expect(context.registryBindings.repair.contractVersion).toBe(repairContractVersion);
  });

  it.each([
    { field: 'owner', value: 'not-an-engine-owner' },
    { field: 'executor', value: true },
    { field: 'readOnly', value: 'true' },
    { field: 'supportedProfiles', value: [] },
    { field: 'supportedProfiles', value: ['duplicate', 'duplicate'] },
    { field: 'supportedPlatforms', value: [] },
    { field: 'supportedPlatforms', value: ['unregistered-host'] }
  ])('rejects invalid or omitted public capability $field scope', async ({ field, value }) => {
    const publicCapabilities = structuredClone(contracts.publicCapabilities);
    publicCapabilities.capabilities[0][field] = value;
    await expect(loadReleaseContext(root, SOURCE, { ...contracts, publicCapabilities })).rejects.toThrow();
  });

  it('rejects an envelope from another compiled CLI version', async () => {
    await expect(loadReleaseContext(root, SOURCE, {
      ...contracts, publicCapabilities: { ...contracts.publicCapabilities, cliVersion: '0.12.3' }
    })).rejects.toThrow('another compiled CLI version');
  });

  it('does not allow removal of a capability required by a canonical skill', async () => {
    const required = contracts.skillCatalog.skills[0].requiredCapability;
    const publicCapabilities = structuredClone(contracts.publicCapabilities);
    publicCapabilities.capabilities = publicCapabilities.capabilities.filter((entry: { id: string }) => entry.id !== required);
    await expect(loadReleaseContext(root, SOURCE, { ...contracts, publicCapabilities })).rejects.toThrow('requires missing public capability');
  });

  it.each(['not-a-registered-profile', 'single-maintainer-gitflow'])('blocks %s as a substitute for a standards profile', async (profile) => {
    const publicCapabilities = structuredClone(contracts.publicCapabilities);
    publicCapabilities.capabilities[0].supportedProfiles = [profile];
    const changed = await loadReleaseContext(root, SOURCE, { ...contracts, publicCapabilities });
    expect(changed.implementationBlockers.join(' ')).toContain('Unregistered capability profile scope');
  });

  it('requires graph, declared phase IDs, and producer keys to be a bijection', async () => {
    await expect(loadReleaseContext(root, SOURCE, { ...contracts, phaseIds: phaseIds.slice(1) })).rejects.toThrow('Graph declared phase IDs');
    await expect(loadReleaseContext(root, SOURCE, { ...contracts, phaseIds: [...phaseIds, phaseIds[0]] })).rejects.toThrow('duplicate');
    const phases = { ...contracts.phases };
    delete phases[phaseIds[0]];
    await expect(loadReleaseContext(root, SOURCE, { ...contracts, phases })).rejects.toThrow('Graph producer registry');
  });

  it.each([
    { executor: 'injected-only', implementation: 'complete' },
    { executor: 'unavailable', implementation: 'complete' },
    { executor: 'built-in', implementation: 'partial' },
    { executor: 'built-in', implementation: 'missing' }
  ])('keeps $executor/$implementation producers blocked after removing a descriptive blocker', async (descriptor) => {
    const phases = structuredClone(contracts.phases);
    phases['application-foundation'] = { ...descriptor, retry: 'none', qualification: 'unqualified' };
    const changedContracts = { ...contracts, phases };
    const changed = await loadReleaseContext(root, SOURCE, changedContracts);
    expect(changed.implementationBlockers).toContain('Production producer implementation missing: application-foundation');
    expect(changed.registrySha256).not.toBe(context.registrySha256);
    const dependencies = fixture();
    dependencies.loadContracts = async () => changedContracts;
    const result = await evaluateReleaseGateFixture(structuredClone(base),
      { projectRoot: root, evidenceRoot: 'build/release-evidence' }, dependencies);
    expect(result.blockers).toContain('Production producer implementation missing: application-foundation');
    expect(result.productionQualified).toBe(false);
  });

  it('retains every required producer as unqualified independently of its implementation state', () => {
    for (const { id } of scope.requiredProductionExecutors) {
      expect(phaseIds).toContain(id);
      const descriptor = Object.entries(phaseCapabilities).find(([phaseId]) => phaseId === id)?.[1];
      expect(descriptor?.qualification).toBe('unqualified');
    }
  });

  it('rejects stale whole-graph and behavior hashes rather than trusting exported strings', async () => {
    await expect(loadReleaseContext(root, SOURCE, { ...contracts, phaseGraphHash: '0'.repeat(64) })).rejects.toThrow('whole graph hash');
    await expect(loadReleaseContext(root, SOURCE, { ...contracts,
      phaseDigests: { ...contracts.phaseDigests, [phaseIds[0]]: '0'.repeat(64) }
    })).rejects.toThrow('phase behavior digests');
  });

  it('binds full producer declarations even when IDs and graph behavior are unchanged', async () => {
    const changed = await loadReleaseContext(root, SOURCE, { ...contracts, phases: {
      ...contracts.phases, [phaseIds[0]]: { ...contracts.phases[phaseIds[0]], blocker: 'Changed declared producer prerequisite' }
    } });
    expect(changed.contracts.phaseGraphHash).toBe(context.contracts.phaseGraphHash);
    expect(changed.registrySha256).not.toBe(context.registrySha256);
  });

  it('binds actual user/project host projections without inventing recovery for none or n/a', () => {
    for (const capability of context.contracts.capabilities) {
      expect(context.cases).toContainEqual(expect.objectContaining({
        kind: 'capability', idRef: capability.id, descriptorSha256: canonicalSha256(capability)
      }));
    }
    const skillCases = context.cases.filter((entry: any) => entry.kind === 'skill-host');
    for (const skill of context.skills.skills) {
      for (const host of skill.supportedHosts) {
        for (const deliveryScope of ['user', 'project'] as const) {
          const actual = projectSkillForHost(skill, host, deliveryScope);
          expect(skillCases).toContainEqual(expect.objectContaining({
            idRef: skill.id, host, deliveryScope,
            projection: expect.objectContaining({ contentHash: actual.contentHash, canonicalHash: actual.canonicalHash,
              relativeDestination: actual.relativeDestination })
          }));
        }
      }
    }
    expect(context.cases.some((entry: any) =>
      entry.kind === 'capability' && ['none', 'n/a'].includes(entry.recovery) && entry.check === 'recovery')).toBe(false);
  });

  it('rejects missing skills, hosts, and changed canonical content through shared validators', async () => {
    const missing = structuredClone(contracts.skillCatalog);
    missing.skills.pop();
    await expect(loadReleaseContext(root, SOURCE, { ...contracts, skillCatalog: missing })).rejects.toThrow();
    const hosts = structuredClone(contracts.skillCatalog);
    hosts.skills[0].supportedHosts.pop();
    await expect(loadReleaseContext(root, SOURCE, { ...contracts, skillCatalog: hosts })).rejects.toThrow();
    const changed = structuredClone(contracts.skillCatalog);
    changed.skills[0].content += '\nChanged source';
    await expect(loadReleaseContext(root, SOURCE, { ...contracts, skillCatalog: changed })).rejects.toThrow('resource digest');
  });

  it('rejects an independently retagged repair schema or stale repair recipe declaration', async () => {
    await expect(loadReleaseContext(root, SOURCE, { ...contracts,
      repair: { ...contracts.repair, schemas: { ...contracts.repair.schemas, report: 999 } }
    })).rejects.toThrow('Independent repair schemas');
    await expect(loadReleaseContext(root, SOURCE, { ...contracts,
      repair: { ...contracts.repair, recipes: {} }
    })).rejects.toThrow('Repair recipe registry');
  });
});

describe('versioned release admission and local identity', () => {
  it('validates real archive bytes, binary targets, package/lock/resources and Ed25519 signatures with explicit non-production dependencies', async () => {
    const result = await evaluate();
    expect(result.blockers).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.productionQualified).toBe(false);
    expect(result.status).toBe('FIXTURE_VALIDATED_NOT_QUALIFIED');
    expect(result.subject.targets['win32-arm64'].helpers).toHaveLength(2);
    for (const target of REQUIRED_NATIVE_TARGETS) {
      expect(result.subject.targets[target].helpers.map((helper: any) => helper.id).sort())
        .toEqual(nativeHelpersForPlatform(target.split('-')[0]).map((helper) => helper.id).sort());
      for (const helper of result.subject.targets[target].helpers.filter((entry: any) => entry.programExport)) {
        expect(helper).toEqual(context.nativeHelpers[helper.id]);
        expect(helper.sha256).toBe(context.sourceFiles[helper.path]);
        expect(helper.sourceSha256).toBe(context.sourceFiles[helper.sourcePath]);
      }
    }
    expect(context.nativeHelpers['darwin-posix-state-lock'].programSha256)
      .toBe('203c5f253fc9aada9b72f8a363c193d6b783060e330426fea2bcfba7c5569a5c');
    expect(context.nativeHelpers['linux-posix-state-lock'].programSha256)
      .not.toBe(context.nativeHelpers['darwin-posix-state-lock'].programSha256);
    expect(context.nativeHelpers['linux-posix-state-lock'].sha256)
      .toBe(context.nativeHelpers['darwin-posix-state-lock'].sha256);
    expect(formatReleaseGateReport(result)).not.toContain('QUALIFIED_FOR_PUBLICATION');
  });

  it('accepts native Windows CRLF output without invoking historical version exceptions', async () => {
    const evidence = structuredClone(base);
    updateReport(evidence, 'native-win32-arm64', (report) => { report.data.installedVersionOutput = 'Liftoff 0.13.0\r\n'; });
    const result = await evaluate(evidence);
    expect(result.status).toBe('FIXTURE_VALIDATED_NOT_QUALIFIED');
    expect(result.productionQualified).toBe(false);
  });

  it('accepts actual host-adapter measurements without promoting the local fixture to native qualification', async () => {
    const host = observeNativeHost();
    const target = `${host.os}-${host.arch}`;
    const evidence = structuredClone(base);
    updateReport(evidence, `native-${target}`, (report) => { report.data.host = host; });
    const result = await evaluate(evidence);
    expect(result.gateDetails[`native:${target}`].ok).toBe(true);
    expect(result.status).toBe('FIXTURE_VALIDATED_NOT_QUALIFIED');
    expect(result.productionQualified).toBe(false);
  });

  it.each([{ ok: true }, { signed: true, signatureId: 'anything' }, { verified: true, nativeRunId: '123' },
    { publicationApproval: { authorized: true, approvedBy: 'model', approvedAt: END } }])('rejects a local assertion as evidence: %j', async (claim) => {
    expect((await evaluateReleaseGate(claim)).productionQualified).toBe(false);
  });

  it.each(['expectedVersion', 'skip', 'publicationAuthorized', 'cliExpectedFiles'])('rejects the %s caller override', async (key) => {
    const result = await evaluate(structuredClone(base), { [key]: key === 'expectedVersion' ? '0.12.3' : true });
    expect(result.blockers.join(' ')).toContain('unsupported fields');
  });

  it.each(['capabilities', 'issues', 'requiredProductionExecutors', 'requiredNativeTargets'])('rejects duplicate and substituted %s identities rather than checking counts', (field) => {
    const value = structuredClone(scope);
    value[field][0] = value[field][1];
    writeJson('assets/qualification/release-scope.json', value);
    expect(loadReleaseScope(root).valid).toBe(false);
    value[field].pop();
    writeJson('assets/qualification/release-scope.json', value);
    expect(loadReleaseScope(root).valid).toBe(false);
  });

  it('rejects a different known phase substituted into the exact 19 gaps', () => {
    const value = structuredClone(scope);
    value.requiredProductionExecutors[0].id = 'seed-valid';
    writeJson('assets/qualification/release-scope.json', value);
    expect(loadReleaseScope(root).valid).toBe(false);
  });

  it('rejects all consistently wrong source product names and a wrong lock root', async () => {
    for (const relative of ['package.json', 'package-lock.json']) {
      const value = JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
      value.name = 'another-product';
      if (value.packages) value.packages[''].name = 'another-product';
      writeJson(relative, value);
    }
    expect((await evaluate()).blockers.join(' ')).toContain('package.json name');
  });

  it('checks the real lockfile root even if all caller version strings claim agreement', async () => {
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    lock.packages[''].version = '0.12.3';
    writeJson('package-lock.json', lock);
    expect((await evaluate()).blockers.join(' ')).toContain('root package version');
  });

  it('rejects a consistently wrong native product and a changed candidate version', async () => {
    const evidence = structuredClone(base);
    evidence.product = 'another-product';
    expect((await evaluate(evidence)).gateDetails.evidenceAdmission.ok).toBe(false);
    evidence.product = 'liftoff'; evidence.version = '0.14.0';
    expect((await evaluate(evidence)).gateDetails.evidenceAdmission.ok).toBe(false);
  });

  it('does not treat fixture successes or uncommitted source as production qualification', async () => {
    const result = await evaluateReleaseGate(base, { projectRoot: root, evidenceRoot: 'build/release-evidence' });
    expect(result.status).toBe('PUBLICATION_BLOCKED');
    expect(result.productionQualified).toBe(false);
    expect(result.gateDetails.reviewedSource.ok).toBe(false);
  });

  it('reports absent real trust rather than inventing publisher or operator identities', async () => {
    const value = structuredClone(scope);
    value.verification.nativeSigning = null;
    value.verification.authorities = { publication: null, liveQualification: null, dashboard: null };
    value.verification.channels = {};
    writeJson('assets/qualification/release-scope.json', value);
    const result = await evaluate();
    expect(result.blockers.join(' ')).toContain('native signing/provenance workflow');
    expect(result.blockers.join(' ')).toContain('dashboard explicit maintainer/machine action authority');
  });
});

describe('authenticated report binding and adversarial measurements', () => {
  it.each(['build', 'qualification', 'native-win32-arm64', 'native-minimum-win32-arm64', 'coverage-cli'])('requires the authenticated %s report', async (id) => {
    const evidence = structuredClone(base); delete evidence.reports[id];
    const result = await evaluate(evidence);
    expect(result.productionQualified).toBe(false);
    expect(result.blockers.join(' ')).toContain('Missing authenticated');
  });

  it.each(['qualification', 'build', 'native-linux-x64', 'native-minimum-linux-x64'])('rejects %s proof for an earlier capability/executor/build commit', async (id) => {
    const evidence = structuredClone(base);
    updateReport(evidence, id, (report) => { report.binding.sourceCommit = 'e'.repeat(40); });
    expect((await evaluate(evidence)).blockers.join(' ')).toContain('binding does not match');
  });

  it('rejects partial/duplicate capability, recovery, host and profile evidence', async () => {
    const evidence = structuredClone(base);
    updateReport(evidence, 'qualification', (report) => { report.data.cases[0] = report.data.cases[1]; });
    expect((await evaluate(evidence)).blockers.join(' ')).toContain('duplicate identities');
  });

  it.each([true, 'true', 'false', 0, -1])('rejects malformed/truthy native pass counts %j', async (passed) => {
    const evidence = structuredClone(base);
    updateReport(evidence, 'native-linux-x64', (report) => { report.data.checks[0].passed = passed; });
    expect((await evaluate(evidence)).gateDetails['native:linux-x64'].ok).toBe(false);
  });

  it.each(['artifactSha256', 'archiveRoot', 'buildInfoSha256', 'resources', 'runtime', 'documentation'])('rejects changed installed %s identity', async (field) => {
    const evidence = structuredClone(base);
    updateReport(evidence, 'native-darwin-arm64', (report) => { report.data.identity[field] = 'changed'; });
    expect((await evaluate(evidence)).blockers.join(' ')).toContain('Installed final runtime/resources/build/helpers');
  });

  it('rejects native evidence from another target or a higher untested floor', async () => {
    const evidence = structuredClone(base);
    updateReport(evidence, 'native-minimum-linux-x64', (report) => { report.data.host.glibcVersion = '2.35'; });
    updateReport(evidence, 'native-win32-arm64', (report) => { report.data.target = 'win32-x64'; });
    const result = await evaluate(evidence);
    expect(result.gateDetails['nativeMinimum:linux-x64'].ok).toBe(false);
    expect(result.gateDetails['native:win32-arm64'].ok).toBe(false);
  });

  it.each(REQUIRED_NATIVE_TARGETS)('requires separate authenticated minimum-host execution for %s', async (target) => {
    const evidence = structuredClone(base);
    delete evidence.reports[`native-minimum-${target}`];
    const result = await evaluate(evidence);
    expect(result.gateDetails[`native:${target}`].ok).toBe(true);
    expect(result.gateDetails[`nativeMinimum:${target}`].ok).toBe(false);
    expect(result.ok).toBe(false);
  });

  it.each(REQUIRED_NATIVE_TARGETS)('rejects copied policy instead of observed host values for %s', async (target) => {
    const evidence = structuredClone(base);
    for (const prefix of ['native', 'native-minimum']) updateReport(evidence, `${prefix}-${target}`, (report) => {
      const payload = manifest.targets[target];
      report.data.host = { os: payload.os, arch: payload.arch, floor: nativeContracts.nativeTargetFloors[payload.os as keyof typeof nativeContracts.nativeTargetFloors] };
    });
    const result = await evaluate(evidence);
    expect(result.gateDetails[`native:${target}`].ok).toBe(false);
    expect(result.gateDetails[`nativeMinimum:${target}`].ok).toBe(false);
    expect(result.blockers.join(' ')).toContain('policy floors are not measurements');
  });

  it.each(REQUIRED_NATIVE_TARGETS)('does not qualify the minimum on a newer measured %s host', async (target) => {
    const evidence = structuredClone(base);
    updateReport(evidence, `native-minimum-${target}`, (report) => { report.data.host = measuredHost(target); });
    const result = await evaluate(evidence);
    expect(result.gateDetails[`native:${target}`].ok).toBe(true);
    expect(result.gateDetails[`nativeMinimum:${target}`].ok).toBe(false);
    expect(result.blockers.join(' ')).toContain('newer host cannot qualify the floor');
  });

  it.each([
    ['linux-x64', 'kernelRelease', '4.17.0'],
    ['linux-arm64', 'glibcVersion', '2.30'],
    ['darwin-x64', 'hostVersion', '13.4'],
    ['darwin-arm64', 'darwinRelease', '22.5.0'],
    ['win32-x64', 'windowsBuild', 17762],
    ['win32-arm64', 'kernelRelease', '10.0.17762'],
    ['linux-x64', 'glibcVersion', '2.31-unsupported'],
    ['linux-x64', 'kernelRelease', '4.18.0\nforged'],
    ['linux-x64', 'arch', 'arm64'],
    ['darwin-x64', 'os', 'linux']
  ])('rejects invalid, lower, contradictory or foreign %s %s measurement', async (target, field, value) => {
    const evidence = structuredClone(base);
    updateReport(evidence, `native-${target}`, (report) => { report.data.host[field] = value; });
    expect((await evaluate(evidence)).gateDetails[`native:${target}`].ok).toBe(false);
  });

  it.each(['missing-job', 'another-job', 'old-observation', 'future-observation', 'unregistered-workflow', 'old-signed-bytes', 'missing-check', 'skipped-check', 'changed-artifact', 'wrong-signer', 'missing-helper'])('rejects incomplete minimum-host evidence: %s', async (kind) => {
    const evidence = structuredClone(base);
    updateReport(evidence, 'native-minimum-win32-x64', (report) => {
      if (kind === 'missing-job') delete report.data.jobId;
      if (kind === 'another-job') report.data.jobId = '3000';
      if (kind === 'old-observation') report.data.observedAt = '2026-09-14T18:59:59.000Z';
      if (kind === 'future-observation') report.data.observedAt = '2026-09-14T19:32:00.000Z';
      if (kind === 'old-signed-bytes') report.binding.releaseSubjectSha256 = '0'.repeat(64);
      if (kind === 'missing-check') report.data.checks.pop();
      if (kind === 'skipped-check') report.data.checks[0].skipped = 1;
      if (kind === 'changed-artifact') report.data.identity.artifactSha256 = '0'.repeat(64);
      if (kind === 'wrong-signer') report.data.signatureIdentity = 'foreign-signer';
      if (kind === 'missing-helper') report.data.helpers.pop();
    });
    if (kind === 'unregistered-workflow') evidence.reports['native-minimum-win32-x64'].origin = base.reports['native-win32-x64'].origin;
    const result = await evaluate(evidence);
    expect(result.gateDetails['nativeMinimum:win32-x64'].ok).toBe(false);
    expect(result.ok).toBe(false);
  });

  it.each(['missing', 'missing-target', 'unregistered-workflow', 'wrong-kind', 'wrong-target', 'wrong-job', 'missing-labels', 'duplicate-labels'])('requires independent approved minimum-host registration: %s', async (kind) => {
    const file = path.join(root, 'assets/qualification/release-scope.json');
    const changed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const registration = changed.verification.minimumNativeHosts['linux-x64'];
    if (kind === 'missing') delete changed.verification.minimumNativeHosts;
    if (kind === 'missing-target') delete changed.verification.minimumNativeHosts['linux-x64'];
    if (kind === 'unregistered-workflow') registration.workflow = 'unregistered';
    if (kind === 'wrong-kind') changed.verification.workflows[registration.workflow].kinds = ['native-linux-x64'];
    if (kind === 'wrong-target') changed.verification.workflows[registration.workflow].nativeTarget = 'linux-arm64';
    if (kind === 'wrong-job') registration.job = 'unregistered-job';
    if (kind === 'missing-labels') registration.runnerLabels = [];
    if (kind === 'duplicate-labels') registration.runnerLabels.push(registration.runnerLabels[0]);
    fs.writeFileSync(file, JSON.stringify(changed));
    const result = await evaluate();
    expect(result.gateDetails.registeredTrust.ok).toBe(false);
    expect(result.ok).toBe(false);
  });

  it.each(['another-runner', 'missing-runner', 'wrong-job', 'wrong-times'])('binds minimum measurements to the actual authenticated job: %s', async (kind) => {
    fault = (args, value) => {
      if (args.at(-1)?.includes('/actions/runs/1020/attempts/1/jobs')) {
        if (kind === 'another-runner') value.jobs[0].labels = ['macos-15-intel'];
        if (kind === 'missing-runner') value.jobs[0].runner_id = null;
        if (kind === 'wrong-job') value.jobs[0].id = 9900;
        if (kind === 'wrong-times') value.jobs[0].started_at = '2026-09-14T19:25:00.000Z';
      }
      return value;
    };
    const result = await evaluate();
    expect(result.gateDetails['nativeMinimum:darwin-x64'].ok).toBe(false);
  });

  it.each(['helper-missing', 'helper-digest', 'helper-unsettled'])('requires actual helper scope and measured settlement: %s', async (kind) => {
    const evidence = structuredClone(base);
    updateReport(evidence, 'native-win32-x64', (report) => {
      if (kind === 'helper-missing') report.data.helpers.pop();
      if (kind === 'helper-digest') report.data.helpers[1].sha256 = '0'.repeat(64);
      if (kind === 'helper-unsettled') report.data.helpers[1].activeProcesses = 1;
    });
    expect((await evaluate(evidence)).gateDetails['native:win32-x64'].ok).toBe(false);
  });

  it.each(['native', 'native-minimum'])('requires every embedded helper in authenticated %s Linux execution evidence', async (lane) => {
    const evidence = structuredClone(base);
    updateReport(evidence, `${lane}-linux-x64`, (report) => {
      report.data.helpers = report.data.helpers.filter((helper: any) => helper.id !== 'linux-readonly-process');
    });
    const result = await evaluate(evidence);
    expect(result.gateDetails[`${lane === 'native' ? 'native' : 'nativeMinimum'}:linux-x64`].ok).toBe(false);
  });

  it.each(['missing-program-digest', 'wrong-program-digest', 'wrong-export', 'source-only', 'missing-execution-case', 'unsettled'])(
    'rejects embedded helper evidence with %s despite authenticated module bytes', async (failure) => {
      const evidence = structuredClone(base);
      updateReport(evidence, 'native-linux-arm64', (report) => {
        const helper = report.data.helpers.find((entry: any) => entry.id === 'linux-posix-state-lock');
        if (failure === 'missing-program-digest') delete helper.programSha256;
        if (failure === 'wrong-program-digest') helper.programSha256 = context.nativeHelpers['darwin-posix-state-lock'].programSha256;
        if (failure === 'wrong-export') helper.programExport = 'posixStateLockProgram';
        if (failure === 'source-only') report.data.execution = 'source-only-tests';
        if (failure === 'missing-execution-case') helper.checks.pop();
        if (failure === 'unsettled') helper.activeProcesses = 1;
      });
      const result = await evaluate(evidence);
      expect(result.gateDetails['native:linux-arm64'].ok).toBe(false);
      expect(result.productionQualified).toBe(false);
    }
  );

  it('derives dashboard and controller digests from actual source rather than stale constants', async () => {
    fs.appendFileSync(path.join(root, 'infrastructure/opentofu/telemetry/dashboard.json'), '\n');
    fs.appendFileSync(path.join(root, 'assets/repair/windows-job-controller.ps1'), '\n');
    const result = await evaluate();
    expect(result.productionQualified).toBe(false);
    expect(result.blockers.join(' ')).toMatch(/resource|controller|binding/);
  });

  it.each(['missing', 'exactly-eighty', 'fabricated-total', 'omitted-source'])('rejects invalid independently authenticated raw coverage: %s', async (kind) => {
    const evidence = structuredClone(base);
    updateReport(evidence, 'coverage-cli', (report) => {
      if (kind === 'missing') { report.data = { coverageGateResult: { ok: true } }; return; }
      const absolute = path.join(evidenceRoot, report.data.raw.path);
      const raw = JSON.parse(fs.readFileSync(absolute, 'utf8'));
      if (kind === 'exactly-eighty') {
        for (const item of Object.values(raw) as any[]) for (const metric of Object.values(item) as any[]) metric.covered = metric.total * 0.8;
      }
      if (kind === 'fabricated-total') raw.total.lines.covered = raw.total.lines.total + 1;
      if (kind === 'omitted-source') delete raw['src/main.ts'];
      fs.writeFileSync(absolute, JSON.stringify(raw));
      report.data.raw.sha256 = sha256(fs.readFileSync(absolute));
    });
    expect((await evaluate(evidence)).gateDetails.coverage.ok).toBe(false);
  });
});

describe('real local final-byte and archive integrity', () => {
  it.each(EMBEDDED_NATIVE_HELPERS.map((helper) => [helper.id, helper.requiredPlatform === 'posix' ? 'linux' : helper.requiredPlatform, helper.compiledPath]))(
    'rejects final archives omitting the compiled %s helper', async (_id, platform, compiledPath) => {
      const evidence = structuredClone(base);
      const target = `${platform}-x64`;
      updateArchive(evidence, target, (bundle) => fs.unlinkSync(path.join(bundle, compiledPath)));
      const result = await evaluate(evidence);
      expect(result.gateDetails[`artifact:${target}`].ok).toBe(false);
      expect(result.blockers.join(' ')).toContain('Packaged embedded helper bytes differ');
    }
  );

  it('does not execute an authenticated but changed archive module to discover its helper export', async () => {
    const evidence = structuredClone(base);
    const marker = path.join(root, 'untrusted-helper-executed');
    updateArchive(evidence, 'darwin-arm64', (bundle) => {
      fs.appendFileSync(path.join(bundle, 'dist/adapters/state/darwin-system-program.js'),
        `\nimport { writeFileSync as writeUntrustedMarker } from 'node:fs';\nwriteUntrustedMarker(${JSON.stringify(marker)}, 'must never execute');\n`);
    });
    const result = await evaluate(evidence);
    expect(result.gateDetails['artifact:darwin-arm64'].ok).toBe(false);
    expect(result.blockers.join(' ')).toContain('Packaged embedded helper bytes differ');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it.each(['CONTRIBUTING.md', 'SECURITY.md',
    'infrastructure/opentofu/bootstrap/README.md', 'infrastructure/opentofu/telemetry/README.md'
  ])('rejects a re-signed archive missing linked public document %s', async (name) => {
    const evidence = structuredClone(base);
    updateArchive(evidence, 'linux-x64', (bundle) => fs.unlinkSync(path.join(bundle, name)));
    const result = await evaluate(evidence);
    expect(result.blockers.join(' ')).toContain('Packaged public documentation');
    expect(result.productionQualified).toBe(false);
  });

  it('binds complete actual documentation closure rather than checkout link success', () => {
    for (const target of REQUIRED_NATIVE_TARGETS) {
      expect(subject.targets[target].documentation.documents).toContain('CONTRIBUTING.md');
      expect(subject.targets[target].documentation.documents).toContain('SECURITY.md');
      expect(subject.targets[target].documentation.documents).toContain('infrastructure/opentofu/telemetry/README.md');
      expect(subject.targets[target].documentation.documents).toContain('infrastructure/opentofu/bootstrap/README.md');
      expect(subject.targets[target].documentation.linksSha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('binds observed archive roots to the exact nested PE and Homebrew paths', () => {
    for (const target of REQUIRED_NATIVE_TARGETS) {
      expect(subject.targets[target].archiveRoot).toBe(`liftoff-v0.13.0-${target}`);
    }
    const definitions = renderWinGetDefinitions(manifest, scope.verification.channels.winget);
    const installers = parseYaml(definitions.installer).Installers;
    for (const arch of ['x64', 'arm64']) {
      const identity = subject.targets[`win32-${arch}`];
      const launcher = identity.helpers.find((helper: { id: string }) => helper.id === 'windows-launcher');
      expect(installers.find((entry: { Architecture: string }) => entry.Architecture === arch).NestedInstallerFiles).toEqual([{
        RelativeFilePath: `${identity.archiveRoot}\\${launcher.path.replaceAll('/', '\\')}`,
        PortableCommandAlias: 'liftoff'
      }]);
    }
    expect(renderHomebrewDefinition(manifest, scope.verification.channels.homebrewCask))
      .toContain('binary "liftoff-v#{version}-darwin-#{arch}/bin/liftoff"');
  });

  it.each([
    { target: 'win32-x64', archiveRoot: '' },
    { target: 'win32-arm64', archiveRoot: 'other-bundle' },
    { target: 'darwin-arm64', archiveRoot: 'outer/liftoff-v0.13.0-darwin-arm64' },
    { target: 'darwin-x64', archiveRoot: 'liftoff-v0.12.3-darwin-x64' },
    { target: 'linux-x64', archiveRoot: 'liftoff-v0.13.0-linux-arm64' }
  ])('rejects a re-signed $target archive with incompatible observed root "$archiveRoot"', async ({ target, archiveRoot }) => {
    const evidence = structuredClone(base);
    updateArchive(evidence, target, () => {}, archiveRoot);
    const result = await evaluate(evidence);
    expect(result.blockers.join(' ')).toContain('Observed native archive root');
    expect(result.productionQualified).toBe(false);
  });

  it.each(['foreign/', 'liftoff-v0.13.0-win32-x64'])('rejects foreign/root-colliding entry "%s" rather than dropping it from root observation', (member) => {
    const relative = 'artifacts/foreign-directory.zip';
    const destination = path.join(evidenceRoot, relative);
    makeArchive('win32-x64', destination);
    execFileSync(python, ['-c', 'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"a") as z: z.writestr(sys.argv[2],b"")',
      destination, member], { timeout: 30000 });
    expect(() => inspectNativeArchive(inspectFile(evidenceRoot, relative), 'zip', 'win32-x64', root))
      .toThrow('outside its unique bundle root');
  });

  it('verifies cryptographic signatures rather than trusting an updated local digest', async () => {
    const evidence = structuredClone(base);
    const pointer = evidence.manifest;
    const absolute = path.join(evidenceRoot, pointer.path);
    fs.appendFileSync(absolute, '\n');
    pointer.sha256 = sha256(fs.readFileSync(absolute));
    expect((await evaluate(evidence)).blockers.join(' ')).toContain('cryptographic signature verification failed');
  });

  it('rejects final artifact bytes changed after signing, even with a new caller checksum', async () => {
    const evidence = structuredClone(base);
    const pointer = evidence.artifacts['linux-x64'];
    fs.appendFileSync(path.join(evidenceRoot, pointer.path), 'changed after signing');
    expect((await evaluate(evidence)).blockers.join(' ')).toContain('Final-byte checksum mismatch');
    pointer.sha256 = sha256(fs.readFileSync(path.join(evidenceRoot, pointer.path)));
    expect((await evaluate(evidence)).productionQualified).toBe(false);
  });

  it('rejects a validly re-signed archive containing the wrong runtime machine', async () => {
    const evidence = structuredClone(base);
    updateArchive(evidence, 'linux-arm64', (bundle) => fs.writeFileSync(path.join(bundle, 'runtime/node'), 'not an ARM64 ELF binary'));
    expect((await evaluate(evidence)).blockers.join(' ')).toContain('runtime binary does not have the selected native OS/architecture');
  });

  it('rejects a validly re-signed archive with substituted packaged metadata/resources', async () => {
    const evidence = structuredClone(base);
    updateArchive(evidence, 'linux-x64', (bundle) => fs.appendFileSync(path.join(bundle, 'assets/profiles/catalog.json'), '\n'));
    expect((await evaluate(evidence)).blockers.join(' ')).toMatch(/Packaged (resource|source definition)/);
  });

  it('requires packaged build metadata, not just a signed archive and passing native report', async () => {
    const evidence = structuredClone(base);
    updateArchive(evidence, 'linux-x64', (bundle) => fs.unlinkSync(path.join(bundle, 'build-info.json')));
    expect((await evaluate(evidence)).blockers.join(' ')).toContain('exactly one root build-info.json');
  });

  it('uses canonical native build-info admission rather than accepting development metadata with release-shaped claims', async () => {
    const evidence = structuredClone(base);
    updateArchive(evidence, 'linux-x64', (bundle) => {
      const file = path.join(bundle, 'build-info.json');
      const info = JSON.parse(fs.readFileSync(file, 'utf8'));
      info.kind = 'development';
      fs.writeFileSync(file, JSON.stringify(info));
    });
    expect((await evaluate(evidence)).blockers.join(' ')).toContain('Native build-info kind is unsupported');
  });

  it.each(['resourcesDigest', 'profilesDigest'])('rejects a re-signed archive with a substituted semantic %s binding', async (field) => {
    const evidence = structuredClone(base);
    updateArchive(evidence, 'linux-x64', (bundle) => {
      const file = path.join(bundle, 'build-info.json');
      const info = JSON.parse(fs.readFileSync(file, 'utf8'));
      info[field] = field === 'resourcesDigest'
        ? `sha256:${manifest.targets['linux-x64'].resources.inventoryHash}` : `sha256:${'0'.repeat(64)}`;
      fs.writeFileSync(file, JSON.stringify(info));
    });
    expect((await evaluate(evidence)).blockers.join(' ')).toContain('Packaged runtime/catalog identity mismatch');
  });

  it('requires the independent profiles digest even when every resource inventory byte matches', async () => {
    const evidence = structuredClone(base);
    updateArchive(evidence, 'linux-x64', (bundle) => {
      const file = path.join(bundle, 'build-info.json');
      const info = JSON.parse(fs.readFileSync(file, 'utf8'));
      delete info.profilesDigest;
      fs.writeFileSync(file, JSON.stringify(info));
    });
    expect((await evaluate(evidence)).blockers.join(' ')).toContain('profilesDigest');
  });

  it('rejects absolute and escaping artifact paths before network verification', async () => {
    const evidence = structuredClone(base);
    evidence.manifest.path = '../private.json';
    expect((await evaluate(evidence)).blockers.join(' ')).toContain('Unsafe evidence path');
  });

  it('collects confined public ZIP entries without executing or silently merging evidence', () => {
    const directory = path.join(root, `collection-${randomUUID()}`);
    fs.mkdirSync(directory);
    const archive = path.join(root, `collection-${randomUUID()}.zip`);
    execFileSync(python, ['-c', 'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w") as z:\n z.writestr("release-evidence.json", "{}")\n z.writestr("reports/report.json", "{\\"measured\\":1}")', archive]);
    const args = [path.join(root, 'scripts/release-evidence-archive.py'), '--extract-evidence', archive, directory];
    execFileSync(python, args, { stdio: 'pipe', timeout: 30000 });
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'reports/report.json'), 'utf8'))).toEqual({ measured: 1 });
    expect(() => execFileSync(python, args, { stdio: 'pipe', timeout: 30000 })).toThrow();
  });

  it.each(['../escape.json', 'private/credentials.json', 'reports/../escape.json'])('rejects unregistered/escaping collection entry %s before extraction', (entry) => {
    const directory = path.join(root, `collection-${randomUUID()}`);
    fs.mkdirSync(directory);
    const archive = path.join(root, `collection-${randomUUID()}.zip`);
    execFileSync(python, ['-c', 'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w") as z:\n z.writestr("release-evidence.json", "{}")\n z.writestr(sys.argv[2], "not evidence")', archive, entry]);
    expect(() => execFileSync(python, [path.join(root, 'scripts/release-evidence-archive.py'), '--extract-evidence', archive, directory], { stdio: 'pipe', timeout: 30000 })).toThrow();
    expect(fs.readdirSync(directory)).toEqual([]);
  });
});

describe('GitHub signature, provenance, run, catalog and approval admission', () => {
  it('admits action-specific maintainer dispatch without any environment or human reviewer gate', async () => {
    const endpoints: string[] = [];
    fault = (args, value) => { if (args[0] === 'api') endpoints.push(args.at(-1)!); return value; };
    const result = await evaluate();
    expect(result.status).toBe('FIXTURE_VALIDATED_NOT_QUALIFIED');
    expect(result.gateDetails['authority:publication'].details.actor).toEqual({ id: 1, type: 'User' });
    expect(endpoints.some((endpoint) => endpoint.includes('/environments/') || endpoint.endsWith('/approvals'))).toBe(false);
  });

  it.each(['certificate-source', 'certificate-run', 'certificate-signer', 'old-witness', 'foreign-subject', 'plain-verified'])('rejects untrusted attestation output: %s', async (kind) => {
    const pointer = base.manifest;
    const file = inspectFile(evidenceRoot, pointer.path);
    const result = attestation(file.absolutePath);
    const data = result[0]!.verificationResult;
    if (kind === 'certificate-source') data.signature.certificate.sourceRepositoryURI = 'https://github.com/foreign/repo';
    if (kind === 'certificate-run') data.signature.certificate.runInvocationURI += '0';
    if (kind === 'certificate-signer') data.signature.certificate.buildSignerDigest = SOURCE;
    if (kind === 'old-witness') data.verifiedTimestamps[0]!.timestamp = '2025-01-01T00:00:00.000Z';
    if (kind === 'foreign-subject') data.statement.subject[0]!.digest.sha256 = 'e'.repeat(64);
    expect(() => validateAttestationResults(kind === 'plain-verified' ? [{ verified: true }] : result, file, pointer.origin,
      scope.verification.workflows[pointer.origin.workflow], SOURCE, NOW)).toThrow();
  });

  it.each(['old', 'foreign', 'failed', 'incomplete-jobs', 'expired-artifact', 'truthy-expired', 'old-attempt'])('rejects nonqualifying actual API responses: %s', async (kind) => {
    const origin = base.manifest.origin;
    const endpoint = `repos/${REPO}/actions/runs/${origin.runId}`;
    const run = structuredClone(apiResponses.get(endpoint));
    const jobs = structuredClone(apiResponses.get(`${endpoint}/attempts/1/jobs?per_page=100&page=1`));
    const artifacts = structuredClone(apiResponses.get(`${endpoint}/artifacts?per_page=100&page=1`));
    if (kind === 'old') run.run_started_at = '2025-01-01T00:00:00.000Z';
    if (kind === 'foreign') run.head_repository.full_name = 'foreign/liftoff';
    if (kind === 'failed') run.conclusion = 'failure';
    if (kind === 'incomplete-jobs') jobs.total_count = 101;
    if (kind === 'expired-artifact') artifacts.artifacts[0].expired = true;
    if (kind === 'truthy-expired') artifacts.artifacts[0].expired = 'false';
    if (kind === 'old-attempt') run.run_attempt = 2;
    expect(() => validateWorkflowRun(run, jobs, artifacts, origin, scope.verification.workflows[origin.workflow], SOURCE, NOW)).toThrow();
  });

  it('requires target-native runner observations, not a successful Ubuntu job', async () => {
    fault = (args, value) => {
      if (args.at(-1)?.includes('/attempts/1/jobs')) value.jobs[0].labels = ['ubuntu-latest'];
      return value;
    };
    const result = await evaluate();
    expect(result.gateDetails['native:darwin-x64'].ok).toBe(false);
    expect(result.gateDetails['native:win32-arm64'].ok).toBe(false);
  });

  it.each(['old-authority', 'wrong-effects', 'caller-name', 'legacy-environment'])('rejects invalid or overbroad authority: %s', async (kind) => {
    const evidence = structuredClone(base);
    updateReport(evidence, 'authority-publication', (report) => {
      if (kind === 'old-authority') report.data.expiresAt = START;
      if (kind === 'wrong-effects') report.data.request.effects.push({ operation: 'npm-publish' });
      if (kind === 'caller-name') report.data.approvedBy = 'maintainer';
      if (kind === 'legacy-environment') report.data.environmentId = 123;
    });
    expect((await evaluate(evidence)).gateDetails['authority:publication'].ok).toBe(false);
  });

  it.each(['not-dispatched', 'untrusted-actor', 'disabled-mechanism', 'permission-revoked'])('checks explicit action authority through GitHub: %s', async (kind) => {
    fault = (args, value) => {
      const endpoint = args.at(-1) ?? '';
      if (endpoint.includes('/actions/runs/1011') && !endpoint.includes('/jobs') && !endpoint.includes('/artifacts')) {
        if (kind === 'not-dispatched') value.event = 'push';
        if (kind === 'untrusted-actor') value.actor.id = value.triggering_actor.id = 123456;
      }
      if (endpoint.endsWith('/actions/workflows/111') && kind === 'disabled-mechanism') value.state = 'disabled_manually';
      if (endpoint.endsWith('/permission') && kind === 'permission-revoked') { value.permission = 'read'; value.role_name = 'read'; }
      return value;
    };
    expect((await evaluate()).gateDetails['authority:publication'].ok).toBe(false);
  });

  it.each(['wrong-package', 'pending-catalog', 'old-catalog', 'changed-catalog-bytes', 'missing-native-asset'])('rejects misleading owner-channel readiness: %s', async (kind) => {
    const evidence = structuredClone(base);
    if (kind === 'wrong-package' || kind === 'pending-catalog') updateReport(evidence, 'channels', (report) => {
      if (kind === 'wrong-package') report.data.winget.packageId = 'Other.Liftoff';
      else report.data.winget.state = 'submitted';
    });
    fault = (args, value) => {
      const endpoint = args.at(-1) ?? '';
      if (kind === 'old-catalog' && endpoint.includes('/git/ref/heads/')) value.object.sha = SOURCE;
      if (kind === 'changed-catalog-bytes' && endpoint.includes('/contents/')) value.content = Buffer.from('changed').toString('base64');
      if (kind === 'missing-native-asset' && endpoint.endsWith('/releases/900')) value.assets.pop();
      return value;
    };
    expect((await evaluate(evidence)).gateDetails.channels.ok).toBe(false);
  });

  it('requires a pinned role-specific signer policy and bounded collector inputs', () => {
    expect(() => validateWorkflowPolicy({ signed: true }, 'native-artifact')).toThrow();
    expect(() => parseCollectionArgs(['collect', '--source-commit', SOURCE, '--run-id', 'latest', '--run-attempt', '1', '--artifact-id', '123', '--output', 'build/release-evidence'])).toThrow();
    expect(() => parseCollectionArgs(['capture-source', '--source-commit', 'main', '--output', 'build/source-validation/report.json'])).toThrow();
    expect(() => parseCollectionArgs(['capture-source', '--source-commit', SOURCE, '--output', '../private.json'])).toThrow();
    expect(() => parseCollectionArgs(['collect', '--source-commit', SOURCE])).toThrow();
    expect(parseCollectionArgs(['collect', '--source-commit', SOURCE, '--run-id', '1000', '--run-attempt', '1', '--artifact-id', '5000', '--output', 'build/release-evidence']).command).toBe('collect');
    const sourceBound = { ...scope.verification.workflows['fixture-common'], signerCommit: undefined, signerSource: 'reviewed-source-commit' };
    expect(validateWorkflowPolicy(sourceBound, 'build', SOURCE).signerCommit).toBe(SOURCE);
    expect(() => validateWorkflowPolicy(sourceBound, 'build')).toThrow();
    expect(() => validateWorkflowPolicy({ ...sourceBound, signerCommit: SIGNER }, 'build', SOURCE)).toThrow();
  });

  describe('explicit qualification registry, typed effects and approved executions', () => {
    function registryContext(mutate: (value: any) => void) {
      const candidate = { ...context, scope: structuredClone(scope) };
      mutate(candidate.scope.verification.qualificationRegistry);
      return candidate;
    }

    it.each(['missing-producer', 'missing-case', 'duplicate-case', 'wrong-provider', 'wrong-profile', 'missing-code', 'mutating-verifier'])('rejects incomplete or unregistered canonical cases: %s', (kind) => {
      const candidate = registryContext((registry) => {
        const producer = registry.producers['seed-valid'];
        if (kind === 'missing-producer') delete registry.producers['credential-ready'];
        if (kind === 'missing-case') producer.cases.splice(1, 1);
        if (kind === 'duplicate-case') producer.cases[0] = producer.cases[1];
        if (kind === 'wrong-provider') producer.cases[0].provider = 'azure';
        if (kind === 'wrong-profile') producer.cases[0].profile = 'unregistered-profile';
        if (kind === 'missing-code') registry.recipes[producer.cases[0].recipe].source.path = 'src/not-implemented.ts';
        if (kind === 'mutating-verifier') registry.recipes[producer.cases[0].recipe].verificationOperations = ['github-write'];
      });
      expect(() => loadQualificationRegistry(candidate)).toThrow();
    });

      describe('deployed telemetry gateway compatibility', () => {
        it('binds actual image manifest bytes, separate image build source, deployed revision and both exact client allowlists', async () => {
          const result = await evaluate();
          expect(result.status).toBe('FIXTURE_VALIDATED_NOT_QUALIFIED');
          expect(result.productionQualified).toBe(false);
          expect(result.gateDetails.telemetryGateway.details).toMatchObject({
            revision: scope.verification.telemetryGateway.revision,
            image: scope.verification.telemetryGateway.image,
            sourceCommit: GATEWAY_SOURCE,
            candidateCommands: telemetryContract.telemetryCommands.length,
            baselineCommands: 33,
            baselineVersion: '0.12.3'
          });
          expect(context.telemetry.baseline.sourceCommit).toBe(scope.baseline.sourceCommit);
          for (const sample of telemetryAcceptanceCases(context.telemetry)) {
            expect(Object.keys(sample.input).sort()).toEqual([...telemetryContract.telemetryClientFields].sort());
          }
        });

        it('blocks explicitly when deployed gateway registration is absent despite passing source/service evidence', async () => {
          const value = structuredClone(scope);
          value.verification.telemetryGateway = null;
          writeJson('assets/qualification/release-scope.json', value);
          const result = await evaluate();
          expect(result.status).toBe('PUBLICATION_BLOCKED');
          expect(result.blockers.join(' ')).toContain('telemetryGateway exact deployed image/revision/source');
        });

        it('does not substitute coverage-telemetry or dashboard evidence for a missing deployed gateway report', async () => {
          const evidence = structuredClone(base);
          delete evidence.reports['telemetry-gateway'];
          const result = await evaluate(evidence);
          expect(result.gateDetails.coverage.ok).toBe(true);
          expect(result.gateDetails.dashboard.ok).toBe(true);
          expect(result.gateDetails.telemetryGateway.ok).toBe(false);
          expect(result.productionQualified).toBe(false);
        });

        it.each(['ready-boolean', 'old-revision', 'wrong-image', 'old-observation', 'inactive', 'insecure', 'split-traffic',
          'source-only-tests', 'production-target', 'real-ingestion', 'candidate-command-missing', 'legacy-command-missing',
          'extra-input-field', 'extra-stored-field', 'accepting-extra-fields', 'duplicate-case', 'wrong-contract'])(
          'rejects signed but nonqualifying deployed gateway evidence: %s', async (kind) => {
            const evidence = structuredClone(base);
            updateReport(evidence, 'telemetry-gateway', (report) => {
              const data = report.data;
              if (kind === 'ready-boolean') { report.data = { ready: true }; return; }
              if (kind === 'old-revision') data.deployment.revision = 'fixture-gateway--old';
              if (kind === 'wrong-image') data.deployment.image = 'fixture.azurecr.io/telemetry-ingest@sha256:' + '0'.repeat(64);
              if (kind === 'old-observation') data.deployment.observedAt = '2026-09-14T18:30:00.000Z';
              if (kind === 'inactive') data.deployment.active = false;
              if (kind === 'insecure') data.deployment.allowInsecure = true;
              if (kind === 'split-traffic') data.deployment.traffic = [{ revision: data.registration.revision, weight: 90 }, { revision: 'unqualified', weight: 10 }];
              if (kind === 'source-only-tests') data.imageInspection.entrypoint = 'checkout-handler';
              if (kind === 'production-target') data.imageInspection.destination = 'production';
              if (kind === 'real-ingestion') data.imageInspection.ingestionSink = 'azure-monitor';
              if (kind === 'candidate-command-missing') data.accepted = data.accepted.filter((entry: any) => !(entry.generation === 'candidate' && entry.input.command === 'skills:install'));
              if (kind === 'legacy-command-missing') data.accepted = data.accepted.filter((entry: any) => !(entry.generation === 'baseline' && entry.input.command === 'repair'));
              if (kind === 'extra-input-field') data.accepted[0].input.owner = 'synthetic';
              if (kind === 'extra-stored-field') data.accepted[0].sinkFields.push('Owner');
              if (kind === 'accepting-extra-fields') { data.rejected[0].status = 204; data.rejected[0].sinkRecordCount = 1; }
              if (kind === 'duplicate-case') data.accepted[0] = data.accepted[1];
              if (kind === 'wrong-contract') data.contract.candidate.commands.pop();
            });
            const result = await evaluate(evidence);
            expect(result.gateDetails.telemetryGateway.ok).toBe(false);
            expect(result.productionQualified).toBe(false);
          }
        );

        it('rejects a deployed image built from an older gateway contract even when source client/service tests pass', async () => {
          fault = (args, value) => {
            if (args.at(-1) === `repos/${REPO}/contents/${TELEMETRY_CONTRACT_PATH}?ref=${GATEWAY_SOURCE}`) {
              value.content = Buffer.from('old gateway allowlist').toString('base64');
            }
            return value;
          };
          const result = await evaluate();
          expect(result.gateDetails.coverage.ok).toBe(true);
          expect(result.gateDetails.telemetryGateway.error).toContain('different shared telemetry contract/allowlist');
        });

        it('verifies actual OCI manifest bytes instead of trusting the recorded image digest', async () => {
          const file = path.join(evidenceRoot, 'manifest/gateway-image.json');
          fs.appendFileSync(file, '\n');
          const result = await evaluate();
          expect(result.gateDetails.telemetryGateway.error).toContain('Final-byte checksum mismatch');
        });

        it('rejects an image attestation from another build source', async () => {
          fault = (args, value) => {
            if (args[0] === 'attestation' && args[2]?.endsWith('gateway-image.json')) value[0].verificationResult.signature.certificate.sourceRepositoryDigest = SOURCE;
            return value;
          };
          expect((await evaluate()).gateDetails.telemetryGateway.ok).toBe(false);
        });

        it('requires a digest-pinned image and fresh public operator identities, not a tag or ready flag', () => {
          expect(() => validateGatewayRegistration({ ready: true })).toThrow();
          expect(() => validateGatewayRegistration({ ...scope.verification.telemetryGateway, image: 'fixture.azurecr.io/telemetry-ingest:latest' })).toThrow('immutable');
          expect(() => validateGatewayRegistration({ ...scope.verification.telemetryGateway, maxAgeSeconds: 86400 })).toThrow('one hour');
        });

        it('does not let compatibility approval authorize gateway deployment or different image tests', () => {
          const candidate = { ...context, scope: structuredClone(scope) };
          const entry = candidate.scope.verification.qualificationPlans.telemetryGateway[0].entries[0];
          entry.effects[0].requestSha256 = '0'.repeat(64);
          expect(() => qualificationPlans(candidate, context.qualificationRegistry, 'telemetryGateway', NOW)).toThrow('exact isolated image');
          entry.effects[0].requestSha256 = sha256(canonicalJson(gatewayImageTestRequest(context)));
          entry.effects[1].operation = 'azure-resource-provision';
          expect(() => qualificationPlans(candidate, context.qualificationRegistry, 'telemetryGateway', NOW)).toThrow();
        });
      });
    it('names missing source registrations separately from missing operational workflow identities', () => {
      const missing = { ...context, scope: structuredClone(scope) };
      missing.scope.verification.qualificationRegistry = null;
      expect(() => loadQualificationRegistry(missing)).toThrow('credential-ready');
      const configured = { ...context, scope: structuredClone(scope) };
      delete configured.scope.verification.workflows['fixture-execution'];
      const registry = loadQualificationRegistry(configured);
      expect(registry.cases).toHaveLength(context.qualificationRegistry.cases.length);
      expect(registry.operationalBlockers.join(' ')).toContain('Host executor');
    });

    it.each(['legacy-plan', 'partial-coverage', 'duplicate-coverage', 'string-effect', 'untyped-operation', 'unapproved-readback', 'missing-principal', 'fractional-budget', 'zero-time'])('rejects incomplete or untyped action plans: %s', (kind) => {
      const candidate = { ...context, scope: structuredClone(scope) };
      const plan = candidate.scope.verification.qualificationPlans.liveQualification[0];
      if (kind === 'legacy-plan') plan.schemaVersion = 1;
      if (kind === 'partial-coverage') plan.entries.pop();
      if (kind === 'duplicate-coverage') plan.entries[0] = plan.entries[1];
      if (kind === 'string-effect') plan.entries[0].effects = ['read'];
      if (kind === 'untyped-operation') plan.entries[0].effects[0].operation = 'anything-approved';
      if (kind === 'unapproved-readback') plan.entries[0].expectedEffectIds = ['execute'];
      if (kind === 'missing-principal') delete plan.entries[0].principals.verification;
      if (kind === 'fractional-budget') plan.maxCost.minorUnits = 80.5;
      if (kind === 'zero-time') plan.maxDurationSeconds = 0;
      expect(() => qualificationPlans(candidate, context.qualificationRegistry, 'liveQualification', NOW)).toThrow();
    });

    it('does not treat release repository or wildcard Azure targets as disposable effect authority', () => {
      const githubRow = context.qualificationRegistry.cases.find((row: any) => row.provider === 'github');
      const azureRow = context.qualificationRegistry.cases.find((row: any) => row.provider === 'azure');
      expect(() => validateEffect({ id: 'bad', stage: 'verification', type: 'github', operation: 'github-read',
        target: { repository: REPO, kind: 'repository', id: 'release-source' }, requestSha256: 'a'.repeat(64) }, githubRow, context.qualificationRegistry)).toThrow('disposable');
      expect(() => validateEffect({ id: 'bad', stage: 'verification', type: 'azure', operation: 'azure-read',
        target: { resourceId: '/subscriptions/*/resourceGroups/*' }, requestSha256: 'a'.repeat(64) }, azureRow, context.qualificationRegistry)).toThrow('exact ARM');
    });

    it.each(['missing', 'duplicate', 'wrong-plan', 'wrong-approval', 'wrong-profile', 'wrong-recipe', 'wrong-host', 'wrong-principal', 'extra-effect', 'unmeasured-effects', 'wrong-outcome', 'invalid-cost', 'over-budget'])('rejects signed but nonqualifying execution measurements: %s', async (kind) => {
      const evidence = structuredClone(base);
      updateExecutions(evidence, (report) => {
        const row = report.cases[0];
        if (kind === 'missing') report.cases.pop();
        if (kind === 'duplicate') report.cases[0] = report.cases[1];
        if (kind === 'wrong-plan') row.planId = 'unapproved-plan';
        if (kind === 'wrong-approval') row.approvalSha256 = '0'.repeat(64);
        if (kind === 'wrong-profile') row.case.profile = 'different-profile';
        if (kind === 'wrong-recipe') row.case.recipe = 'different-recipe';
        if (kind === 'wrong-host') row.case.executionHost = 'different-host';
        if (kind === 'wrong-principal') row.principals.verification = 'another-azure-principal';
        if (kind === 'extra-effect') row.effects.push({ ...row.effects[0], id: 'unapproved-write' });
        if (kind === 'unmeasured-effects') row.effects = [];
        if (kind === 'wrong-outcome') row.outcome = 'skipped';
        if (kind === 'invalid-cost') row.cost.minorUnits = '0';
        if (kind === 'over-budget') row.cost.minorUnits = 100001;
      });
      const result = await evaluate(evidence);
      expect(result.gateDetails.executionQualification.ok).toBe(false);
      expect(result.productionQualified).toBe(false);
    });

    it('requires approval workflow completion before the actual execution job starts', async () => {
      const evidence = structuredClone(base);
      updateExecutions(evidence, (report) => { for (const row of report.cases) row.startedAt = '2026-09-14T18:59:00.000Z'; });
      fault = (args, value) => {
        const endpoint = args.at(-1) ?? '';
        if (endpoint.includes('/actions/runs/1012')) {
          if (endpoint.includes('/jobs')) value.jobs[0].started_at = '2026-09-14T18:59:00.000Z';
          else if (!endpoint.includes('/artifacts')) value.run_started_at = '2026-09-14T18:55:00.000Z';
        }
        return value;
      };
      const result = await evaluate(evidence);
      expect(result.gateDetails.executionQualification.error).toContain('before its exact action approval');
    });

    it('does not accept caller timestamps instead of authenticated job times', async () => {
      const evidence = structuredClone(base);
      updateExecutions(evidence, (report) => { report.cases[0].startedAt = '2026-09-14T19:10:00.000Z'; });
      expect((await evaluate(evidence)).gateDetails.executionQualification.error).toContain('actual execution start mismatch');
    });

    it('includes independent verification in the actual time budget', async () => {
      const evidence = structuredClone(base);
      fault = (args, value) => {
        const endpoint = args.at(-1) ?? '';
        if (endpoint.includes('/actions/runs/1013')) {
          if (endpoint.includes('/jobs')) value.jobs[0].completed_at = '2026-09-14T20:06:00.000Z';
          else if (!endpoint.includes('/artifacts')) value.updated_at = '2026-09-14T20:06:00.000Z';
        }
        return value;
      };
      const dependencies = fixture();
      dependencies.now = NOW + 30 * 60 * 1000;
      const result = await evaluateReleaseGateFixture(evidence, { projectRoot: root, evidenceRoot: 'build/release-evidence' }, dependencies);
      expect(result.gateDetails.executionQualification.error).toContain('exceeded its actual execution and verification time bound');
    });

    it('refuses a same-job self-verification substitute', async () => {
      const evidence = structuredClone(base);
      updateExecutions(evidence, (report) => { report.cases[0].verificationJobId = '3012'; });
      expect((await evaluate(evidence)).gateDetails.executionQualification.error).toContain('registered execution host/job');
    });

    it('cannot substitute an aggregate passing claim for the complete measured case inventory', async () => {
      const evidence = structuredClone(base);
      evidence.executionReports = [];
      updateReport(evidence, 'execution-qualification', (report) => { report.data = { ok: true }; });
      expect((await evaluate(evidence)).gateDetails.executionQualification.error).toContain('Missing bounded authenticated execution report batches');
    });

    it('requires explicit producer modes and purpose rather than a generic approval flag', () => {
      const common = ['--source-commit', SOURCE, '--evidence', 'build/release-evidence/release-evidence.json', '--run-id', '1010', '--run-attempt', '1', '--artifact-id', '5010'];
      expect(parseProducerArgs(['approve-action', ...common, '--purpose', 'liveQualification']).command).toBe('approve-action');
      expect(() => parseProducerArgs(['approve-action', ...common, '--purpose', 'none'])).toThrow();
      expect(() => parseProducerArgs(['approve-action', ...common, '--approved', 'true'])).toThrow();
    });

    it('does not issue action authority from local environment claims or completed old dispatches', async () => {
      const verifier = createGitHubEvidenceVerifier({ projectRoot: root, verification: scope.verification, sourceCommit: SOURCE, now: NOW, commands });
      await expect(verifier.admitApprovalDispatch('publication', {})).rejects.toThrow();
      await expect(verifier.admitApprovalDispatch('publication', { GITHUB_ACTIONS: 'true', LIFTOFF_RELEASE_MODE: 'approve-action',
        LIFTOFF_APPROVAL_PURPOSE: 'publication', GITHUB_RUN_ID: '1011', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: SOURCE, GITHUB_REPOSITORY: REPO })).rejects.toThrow('currently executing');
    });

    it('derives an issuing actor from the authenticated explicit dispatch, never a reviewer list or supplied name', async () => {
      fault = (args, value) => {
        if (args.at(-1) === `repos/${REPO}/actions/runs/1011`) { value.status = 'in_progress'; value.conclusion = null; }
        return value;
      };
      const verifier = createGitHubEvidenceVerifier({ projectRoot: root, verification: scope.verification, sourceCommit: SOURCE, now: NOW, commands });
      const dispatch = await verifier.admitApprovalDispatch('liveQualification', { GITHUB_ACTIONS: 'true',
        LIFTOFF_RELEASE_MODE: 'approve-action', LIFTOFF_APPROVAL_PURPOSE: 'liveQualification',
        GITHUB_RUN_ID: '1011', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: SOURCE, GITHUB_REPOSITORY: REPO });
      expect(dispatch.actor).toEqual({ id: 1, type: 'User' });
    });
  });

  it('does not accept arbitrary verified dependency results instead of the documented gh schema', async () => {
    const verifier = createGitHubEvidenceVerifier({ projectRoot: root, verification: scope.verification, sourceCommit: SOURCE, now: NOW,
      commands: async () => ({ verified: true, ok: true }) });
    await expect(verifier.verifyFile(inspectFile(evidenceRoot, base.manifest.path), base.manifest.origin, 'native-manifest')).rejects.toThrow();
  });

  it('rechecks evidence expiry at completion, not only at verification start', async () => {
    const verifier = createGitHubEvidenceVerifier({ projectRoot: root, verification: scope.verification, sourceCommit: SOURCE, now: NOW, commands });
    await verifier.verifyFile(inspectFile(evidenceRoot, base.manifest.path), base.manifest.origin, 'native-manifest');
    expect(verifier.assertFresh(NOW).validUntil).toBe(EXPIRY);
    expect(() => verifier.assertFresh(Date.parse(EXPIRY))).toThrow('expired during verification');
  });
});
