#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateCoverageMeasurements } from './coverage-gate.mjs';
import {
  buildReleaseSubject, canonicalJson, CANONICAL_NATIVE_PRODUCT, CANONICAL_PRODUCT_NAME, CANONICAL_REPOSITORY, confinedDirectory,
  DASHBOARD_CHECKS, EVIDENCE_KIND, EVIDENCE_SCHEMA, exactIds, HELPER_CHECKS, inspectFile,
  loadReleaseContext, loadReleaseContracts, loadReleaseScope, NATIVE_CHECKS, readJsonFile, REQUIRED_NATIVE_TARGETS,
  same, sha256, verifyChecks, verifyNativeArtifactFile, verifyNativeManifestFile, verifySourceWorktree, readVerifiedReleaseReport
} from './release-evidence.mjs';
import {
  createGitHubEvidenceVerifier, exactKeys, object, positiveId, requireValue
} from './release-evidence-github.mjs';
import { ACTION_PURPOSES, buildActionRequest, loadQualificationRegistry, verifyQualificationExecutions } from './release-qualification.mjs';
import { validateGatewayRegistration, verifyTelemetryGateway } from './release-telemetry-gateway.mjs';
import { renderHomebrewDefinition, renderWinGetDefinitions } from './distribution/channel-definitions.mjs';
import { validateMinimumNativeHosts, verifyNativeHostObservation } from './release-native-host.mjs';

export { CANONICAL_PRODUCT_NAME, loadReleaseScope, REQUIRED_NATIVE_TARGETS };
export const FORBIDDEN_DISTRIBUTION_CHANNELS = ['npm-publish', 'npm-bridge'];
export const REQUIRED_REPORT_IDS = ['build', 'coverage-cli', 'coverage-telemetry', 'qualification', 'execution-qualification', 'dashboard', 'telemetry-gateway', 'channels',
  ...ACTION_PURPOSES.map((purpose) => `authority-${purpose}`),
  ...REQUIRED_NATIVE_TARGETS.flatMap((target) => [`native-${target}`, `native-minimum-${target}`])];

async function verifyChannels(data, context, manifest, evidenceRoot, verifier, trackedFiles) {
  exactKeys(data, ['homebrewCask', 'winget', 'linuxDirect'], 'Owner-channel readiness');
  const configs = object(context.scope.verification?.channels, 'Missing trusted owner-channel registry');
  const version = context.scope.candidate.version;
  const catalogFiles = async (kind, record, expectedFiles) => {
    exactKeys(record, ['packageId', 'version', 'state', 'catalogCommit', 'files'], `${kind} readiness record`);
    const config = object(configs[kind], `Missing approved ${kind} package/catalog identity`);
    requireValue(typeof config.repository === 'string' && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(config.repository) && typeof config.ref === 'string' && /^refs\/heads\/[A-Za-z0-9._/-]+$/.test(config.ref), `Missing exact ${kind} catalog repository/ref`);
    requireValue(record.packageId === config.packageId && record.version === version && record.state === 'available', `${kind} package identity/version is wrong or its catalog is lagging`);
    requireValue(/^[a-f0-9]{40}$/.test(record.catalogCommit), `${kind} catalog requires immutable current commit`);
    const ref = await verifier.api(`repos/${config.repository}/git/ref/${config.ref.slice(5)}`);
    requireValue(ref.object?.type === 'commit' && ref.object.sha === record.catalogCommit, `${kind} catalog is no longer at the qualified current commit`);
    exactIds(Object.keys(record.files ?? {}), Object.keys(expectedFiles), `${kind} catalog metadata`);
    exactIds(Object.keys(config.paths ?? {}), Object.keys(expectedFiles), `${kind} registered metadata paths`);
    for (const [id, expected] of Object.entries(expectedFiles)) {
      const pointer = record.files[id];
      exactKeys(pointer, ['path', 'sha256'], `${kind} metadata pointer`);
      const file = inspectFile(evidenceRoot, pointer.path, pointer.sha256, 1024 * 1024);
      trackedFiles.push(file);
      const bytes = fs.readFileSync(file.absolutePath);
      requireValue(sha256(bytes) === file.sha256 && bytes.toString('utf8') === expected, `${kind} metadata does not deliver the exact canonical final artifacts`);
      const repositoryPath = config.paths[id];
      requireValue(typeof repositoryPath === 'string' && /^[A-Za-z0-9._/-]+$/.test(repositoryPath) && !repositoryPath.split('/').includes('..') && !repositoryPath.startsWith('/'), `Invalid registered ${kind} metadata path`);
      const remote = await verifier.api(`repos/${config.repository}/contents/${repositoryPath}?ref=${record.catalogCommit}`);
      requireValue(remote.type === 'file' && remote.encoding === 'base64' && remote.path === repositoryPath && typeof remote.content === 'string' && sha256(Buffer.from(remote.content, 'base64')) === file.sha256, `${kind} catalog has not delivered the qualified metadata bytes`);
    }
  };
  const cask = object(configs.homebrewCask, 'Missing approved Homebrew tap/cask identity');
  requireValue(cask.packageId === context.contracts.native.canonicalHomebrewCask, 'Homebrew registration is not the canonical full tap/cask identity');
  await catalogFiles('homebrewCask', object(data.homebrewCask, 'Homebrew readiness'), { cask: renderHomebrewDefinition(manifest, cask) });
  const winget = object(configs.winget, 'Missing approved WinGet publisher/package identity');
  requireValue(winget.packageId === context.contracts.native.canonicalWinGetId && typeof winget.publisher === 'string' && winget.publisher.length > 0, 'WinGet registration is not the canonical exact publisher/package identity');
  await catalogFiles('winget', object(data.winget, 'WinGet readiness'), renderWinGetDefinitions(manifest, winget));
  const direct = object(configs.linuxDirect, 'Missing approved Linux direct owner identity');
  const ready = object(data.linuxDirect, 'Linux direct readiness');
  exactKeys(ready, ['packageId', 'version', 'state', 'releaseId'], 'Linux direct readiness record');
  requireValue(direct.repository === CANONICAL_REPOSITORY && direct.packageId === CANONICAL_NATIVE_PRODUCT && ready.packageId === direct.packageId && ready.version === version && ready.state === 'available', 'Linux direct owner/version is not ready');
  positiveId(ready.releaseId, 'Staged native release ID');
  const release = await verifier.api(`repos/${CANONICAL_REPOSITORY}/releases/${ready.releaseId}`);
  requireValue(release.id === Number(ready.releaseId) && release.tag_name === `v${version}` && release.draft === false, 'Native release assets are not publicly staged under the exact candidate tag');
  requireValue(Array.isArray(release.assets) && release.assets.length <= 100, 'Native release asset inventory is incomplete or unbounded');
  for (const [target, payload] of Object.entries(manifest.targets)) {
    const matches = release.assets.filter((asset) => asset.browser_download_url === payload.archiveUrl);
    requireValue(matches.length === 1 && matches[0].state === 'uploaded' && matches[0].digest === `sha256:${payload.checksumSha256}`, `Staged final artifact is missing, changed, or lacks a verified digest: ${target}`);
  }
  let tag = await verifier.api(`repos/${CANONICAL_REPOSITORY}/git/ref/tags/v${version}`);
  for (let depth = 0; tag.object?.type === 'tag' && depth < 3; depth++) {
    requireValue(/^[a-f0-9]{40}$/.test(tag.object.sha), 'Malformed annotated release tag');
    tag = await verifier.api(`repos/${CANONICAL_REPOSITORY}/git/tags/${tag.object.sha}`);
  }
  requireValue(tag.object?.type === 'commit' && tag.object.sha === context.sourceCommit, 'Release tag is not bound to the reviewed immutable source');
  return { homebrewCask: cask.packageId, winget: winget.packageId, linuxDirect: direct.packageId };
}

async function evaluate(evidence, options, fixture) {
  const blockers = [];
  const gateDetails = {};
  const trackedFiles = [];
  const now = fixture?.now ?? Date.now();
  const projectRoot = options?.projectRoot ?? process.cwd();
  const evidenceRoot = path.resolve(projectRoot, options?.evidenceRoot ?? 'build/release-evidence');
  let subject;
  let subjectSha256;
  const check = async (name, action) => {
    try {
      const details = await action();
      gateDetails[name] = { ok: true, ...(details === undefined ? {} : { details }) };
      return details;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      blockers.push(`${name}: ${message}`);
      gateDetails[name] = { ok: false, error: message };
      return undefined;
    }
  };
  const admission = await check('evidenceAdmission', () => {
    exactKeys(options ?? {}, ['projectRoot', 'evidenceRoot'], 'Release gate options (no candidate override, skip, or caller scope)');
    exactKeys(evidence, ['schemaVersion', 'kind', 'product', 'version', 'sourceCommit', 'manifest', 'artifacts', 'reports', 'executionReports'], 'Release evidence');
    requireValue(evidence.schemaVersion === EVIDENCE_SCHEMA && evidence.kind === EVIDENCE_KIND, 'Unsupported versioned release evidence; ok/signed/verified claims are not evidence');
    requireValue(evidence.product === CANONICAL_NATIVE_PRODUCT && evidence.version === '0.13.0' && /^[a-f0-9]{40}$/.test(evidence.sourceCommit), 'Wrong canonical product/candidate or missing explicit immutable source');
    requireValue(path.relative(projectRoot, evidenceRoot) !== '' && !path.relative(projectRoot, evidenceRoot).startsWith('..') && !path.isAbsolute(path.relative(projectRoot, evidenceRoot)), 'Evidence root must be a project descendant');
    confinedDirectory(projectRoot, path.relative(projectRoot, evidenceRoot).split(path.sep).join('/'));
    return true;
  });
  let context;
  let verifier;
  if (admission) {
    await check('reviewedSource', () => (fixture?.verifySource ?? verifySourceWorktree)(projectRoot, evidence.sourceCommit));
    if (gateDetails.reviewedSource?.ok === true) {
      context = await check('canonicalScope', async () => loadReleaseContext(projectRoot, evidence.sourceCommit,
        await (fixture?.loadContracts ?? loadReleaseContracts)(projectRoot, evidence.sourceCommit)));
    }
  }
  if (context) {
    context.qualificationRegistry = await check('qualificationRegistry', () => loadQualificationRegistry(context));
    for (const reason of context.qualificationRegistry?.operationalBlockers ?? []) blockers.push(`Operational qualification registration: ${reason}`);
    for (const reason of context.implementationBlockers) blockers.push(reason);
    const verification = context.scope.verification;
    await check('registeredTrust', () => {
      requireValue(verification?.schemaVersion === 1, 'Missing registered release verification policy in assets/qualification/release-scope.json');
      object(verification.workflows, 'Missing trusted CI workflow registry');
      const missing = [];
      if (!verification.nativeSigning?.workflow) missing.push('native signing/provenance workflow');
      for (const target of REQUIRED_NATIVE_TARGETS) if (typeof verification.nativeSigning?.identities?.[target] !== 'string' || !verification.nativeSigning.identities[target]) missing.push(`${target} trusted native signer identity`);
      for (const purpose of ACTION_PURPOSES) if (!verification.authorities?.[purpose]) missing.push(`${purpose} explicit maintainer/machine action authority`);
      for (const channel of ['homebrewCask', 'winget', 'linuxDirect']) if (!verification.channels?.[channel]) missing.push(`${channel} approved package/catalog identity`);
      if (!verification.telemetryGateway) missing.push('telemetryGateway exact deployed image/revision/source and operator evidence registration (source tests are insufficient)');
      if (!verification.minimumNativeHosts) missing.push('separately registered six-target minimum-host execution matrix');
      requireValue(missing.length === 0, `Missing prerequisites: ${missing.join('; ')}`);
      validateGatewayRegistration(verification.telemetryGateway);
      validateMinimumNativeHosts(context);
    });
    verifier = createGitHubEvidenceVerifier({ projectRoot, verification, sourceCommit: evidence.sourceCommit, now, ...(fixture?.commands ? { commands: fixture.commands } : {}) });
    if (gateDetails.registeredTrust?.ok && gateDetails.reviewedSource?.ok) await check('publicSource', async () => {
      const commit = await verifier.api(`repos/${CANONICAL_REPOSITORY}/commits/${evidence.sourceCommit}`);
      requireValue(commit.sha === evidence.sourceCommit && commit.html_url === `https://github.com/${CANONICAL_REPOSITORY}/commit/${evidence.sourceCommit}`, 'Reviewed source commit is not available from the canonical public repository');
    });
    const manifestFile = await check('nativeManifest', async () => {
      requireValue(gateDetails.registeredTrust?.ok === true && gateDetails.reviewedSource?.ok === true, 'Production verification requires the clean reviewed source and complete registered trust inputs before any GitHub admission');
      return verifyNativeManifestFile(context, evidence.manifest, evidenceRoot, verifier, trackedFiles);
    });
    if (manifestFile) {
      const { file, manifest } = manifestFile;
      const targets = {};
      const targetInventory = await check('artifactInventory', () => {
        exactIds(Object.keys(object(evidence.artifacts, 'Final artifacts')), REQUIRED_NATIVE_TARGETS, 'Final signed artifact evidence');
        return true;
      });
      if (targetInventory) {
        for (const target of REQUIRED_NATIVE_TARGETS) {
          const identity = await check(`artifact:${target}`, () => verifyNativeArtifactFile(context, manifest, target, evidence.artifacts[target], evidenceRoot, verifier, trackedFiles));
          if (identity) targets[target] = identity;
        }
      }
      if (Object.keys(targets).length === REQUIRED_NATIVE_TARGETS.length) {
        subject = buildReleaseSubject(context, file, targets);
        subjectSha256 = sha256(canonicalJson(subject));
        await check('reportInventory', () => exactIds(Object.keys(object(evidence.reports, 'Evidence reports')), REQUIRED_REPORT_IDS, 'Complete coordinated report'));
        const verifiedReports = {};
        for (const id of REQUIRED_REPORT_IDS) {
          const verified = await check(`report:${id}`, () => readVerifiedReleaseReport(evidence.reports?.[id], id, subject, evidenceRoot, verifier, trackedFiles));
          if (verified) verifiedReports[id] = verified;
        }
        const data = (id) => {
          requireValue(verifiedReports[id], `Missing authenticated ${id} evidence; local assertions are not a substitute`);
          return verifiedReports[id].data;
        };
        await check('build', () => {
          const build = data('build');
          exactKeys(build, ['targets', 'checks'], 'Build measurements');
          same(build.targets, targets, 'Built final artifact identities');
          verifyChecks(build.checks, ['compile', 'runtime-dependencies', 'resource-inventory', 'license-notices'], 'Build');
        });
        await check('coverage', () => {
          const readRaw = (id) => {
            const coverage = data(id);
            exactKeys(coverage, ['format', 'raw'], `${id} measurement`);
            requireValue(coverage.format === 'istanbul-summary-v1', `${id} requires independently measured raw counts, not a precomputed coverageGateResult`);
            exactKeys(coverage.raw, ['path', 'sha256'], `${id} raw report pointer`);
            const raw = readJsonFile(evidenceRoot, coverage.raw.path, coverage.raw.sha256);
            trackedFiles.push(raw.file);
            object(raw.value, `${id} raw counts`);
            object(raw.value.total, `${id} raw total counts`);
            return raw.value;
          };
          const result = evaluateCoverageMeasurements({ projectRoot, cliSummary: readRaw('coverage-cli'), telemetrySummary: readRaw('coverage-telemetry') });
          // Helper admission is the authenticated installed-native lane below, not this V8 measurement.
          requireValue(result.ok === true, `Independent raw package coverage failed: ${result.issues.join('; ')}`);
          return { cli: result.cli, telemetry: result.telemetry, inventory: result.inventory, nativeHelpers: 'separately verified per final native artifact' };
        });
        for (const target of REQUIRED_NATIVE_TARGETS) for (const minimum of [false, true]) await check(`${minimum ? 'nativeMinimum' : 'native'}:${target}`, () => {
          const id = `${minimum ? 'native-minimum' : 'native'}-${target}`;
          const native = data(id);
          exactKeys(native, ['target', 'execution', 'host', 'jobId', 'observedAt', 'installedVersionOutput', 'identity', 'signatureIdentity', 'checks', 'helpers', 'windowsRegression'], `Native ${target} observations`);
          const versionLine = `Liftoff ${context.scope.candidate.version}`;
          requireValue(native.target === target && native.execution === 'native-installed' && [versionLine, `${versionLine}\n`, `${versionLine}\r\n`].includes(native.installedVersionOutput), `Wrong native target, fixture execution, or installed CLI identity: ${target}`);
          same(native.identity, targets[target], `Installed final runtime/resources/build/helpers ${target}`);
          const payload = manifest.targets[target];
          verifyNativeHostObservation(context, verifiedReports[id], target, payload.runtime, minimum);
          requireValue(typeof verification.nativeSigning.identities[target] === 'string' && native.signatureIdentity === verification.nativeSigning.identities[target], `Native platform signature does not have the registered signer identity: ${target}`);
          verifyChecks(native.checks, NATIVE_CHECKS, `Native ${target}`);
          exactIds(native.helpers?.map((helper) => helper.id), targets[target].helpers.map((helper) => helper.id), `Installed ${target} helper evidence`);
          for (const helper of native.helpers) {
            const expected = targets[target].helpers.find((entry) => entry.id === helper.id);
            exactKeys(helper, ['id', 'sha256', 'activeProcesses', 'checks',
              ...(expected.programExport ? ['programExport', 'programSha256'] : [])], `Native ${target} helper`);
            requireValue(helper.sha256 === expected.sha256 && helper.activeProcesses === 0, `Missing helper byte/settlement evidence: ${target}/${helper.id}`);
            if (expected.programExport) requireValue(helper.programExport === expected.programExport &&
              helper.programSha256 === expected.programSha256, `Missing installed embedded-program identity: ${target}/${helper.id}`);
            verifyChecks(helper.checks, HELPER_CHECKS, `Helper ${target}/${helper.id}`);
          }
          if (payload.os === 'win32') {
            exactKeys(native.windowsRegression, ['baselineCommit', 'checks'], 'Windows native regression evidence');
            requireValue(native.windowsRegression?.baselineCommit === context.scope.baseline.sourceCommit, 'Missing actual cited Windows baseline/regression identity');
            verifyChecks(native.windowsRegression.checks, context.scope.historicalWindowsFailure.observations.map((entry) => entry.id), 'Windows baseline/corrected regression');
          } else requireValue(native.windowsRegression === undefined, 'Foreign Windows regression cannot qualify another native host');
        });
        await check('capabilitiesAndRecovery', () => {
          const qualified = data('qualification');
          exactKeys(qualified, ['registrySha256', 'cases', 'checks'], 'Capability/executor/host/profile/recovery measurements');
          requireValue(qualified.registrySha256 === context.registrySha256, 'Qualification uses a different canonical graph/registry');
          verifyChecks(qualified.cases, context.cases.map((entry) => entry.id), 'Exact capability/producer/recovery/host/profile scope');
          verifyChecks(qualified.checks, ['compatibility-readers', 'documentation-inventory', 'source-typecheck', 'cross-platform-boundaries'], 'Coordinated source qualification');
        });
        await check('dashboard', () => {
          const dashboard = data('dashboard');
          exactKeys(dashboard, ['definition', 'checks'], 'Dashboard measurement');
          same(dashboard.definition, context.dashboard, 'Committed Azure Monitor dashboard definition');
          verifyChecks(dashboard.checks, DASHBOARD_CHECKS, 'Operator dashboard');
        });
        await check('channels', () => verifyChannels(data('channels'), context, manifest, evidenceRoot, verifier, trackedFiles));
        const authorities = {};
        for (const purpose of ACTION_PURPOSES) await check(`authority:${purpose}`, async () => {
          const report = verifiedReports[`authority-${purpose}`];
          requireValue(report, `Missing authenticated independent ${purpose} authorization receipt`);
          requireValue(context.qualificationRegistry, 'Missing canonical qualification case registration; no plan approval can substitute for implementation scope');
          const request = buildActionRequest(context, subject, purpose, report.data.request?.sourceEvidence, now);
          const approved = await verifier.verifyAuthority(report.data, report.origin, report.verifiedFile, purpose, request);
          authorities[purpose] = report;
          return approved;
        });
        const executions = await check('executionQualification', async () => {
          const verified = await verifyQualificationExecutions({ context, subject, evidence, evidenceRoot, verifier, authorities, trackedFiles, now });
          same(data('execution-qualification'), verified, 'Trusted execution-qualification aggregate');
          return verified;
        });
        await check('telemetryGateway', async () => {
          requireValue(executions, 'Deployed gateway compatibility requires its approved independently measured operator execution cases');
          const gateway = validateGatewayRegistration(verification.telemetryGateway);
          const imageVerifier = createGitHubEvidenceVerifier({ projectRoot, verification, sourceCommit: gateway.sourceCommit, now,
            ...(fixture?.commands ? { commands: fixture.commands } : {}) });
          return verifyTelemetryGateway({ context, report: verifiedReports['telemetry-gateway'], executionSummary: executions,
            evidenceRoot, imageVerifier, trackedFiles, now });
        });
      }
    }
  }
  await check('finalByteRecheck', () => {
    for (const file of trackedFiles) inspectFile(evidenceRoot, file.path, file.sha256);
  });
  if (admission) await check('finalSourceRecheck', () => (fixture?.verifySource ?? verifySourceWorktree)(projectRoot, evidence.sourceCommit));
  if (subject) await check('currentValidity', () => {
    const current = fixture ? now : Date.now();
    if (gateDetails.telemetryGateway?.ok) requireValue(current < Date.parse(gateDetails.telemetryGateway.details.validUntil), 'Deployed gateway observation expired during release verification');
    return verifier.assertFresh(current);
  });
  const ok = blockers.length === 0;
  return {
    schemaVersion: 1, ok, productionQualified: ok && !fixture,
    status: ok ? (fixture ? 'FIXTURE_VALIDATED_NOT_QUALIFIED' : 'QUALIFIED_FOR_PUBLICATION') : 'PUBLICATION_BLOCKED',
    ...(fixture ? { fixture: fixture.name } : {}),
    ...(subject ? { subject, releaseSubjectSha256: subjectSha256 } : {}),
    blockers, gateDetails
  };
}

export async function evaluateReleaseGate(evidence = {}, options = {}) {
  return evaluate(evidence, options);
}

// Fixture seams replace external observations, never the local byte/identity or GitHub response validators.
// This API cannot return productionQualified or QUALIFIED_FOR_PUBLICATION, and is not exposed by the CLI.
export async function evaluateReleaseGateFixture(evidence, options, fixture) {
  requireValue(typeof fixture?.name === 'string' && fixture.name.length > 0 && typeof fixture.commands === 'function' && typeof fixture.verifySource === 'function' && typeof fixture.loadContracts === 'function', 'Explicit named fixture verification dependencies are required');
  return evaluate(evidence, options, fixture);
}

export function formatReleaseGateReport(result) {
  return [
    `Liftoff coordinated release: ${result.status}`,
    `Production qualification: ${result.productionQualified ? 'verified for the exact recorded subject; publication is a separate authorized action' : 'NOT established'}`,
    ...(result.fixture ? [`Fixture: ${result.fixture}; controlled verification dependencies are not release authority`] : []),
    ...(result.releaseSubjectSha256 ? [`Release subject SHA-256: ${result.releaseSubjectSha256}`] : []),
    ...result.blockers.map((blocker) => `[BLOCKER] ${blocker}`)
  ].join('\n');
}

const direct = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (direct) {
  try {
    const args = process.argv.slice(2);
    requireValue(args.length === 2 && args[0] === '--evidence', 'Usage: node scripts/release-gate.mjs --evidence build/release-evidence/release-evidence.json (no source-only, skip, fixture, or version override)');
    const relative = path.relative(process.cwd(), path.resolve(args[1])).split(path.sep).join('/');
    const { value: evidence } = readJsonFile(process.cwd(), relative);
    const result = await evaluateReleaseGate(evidence, { evidenceRoot: path.dirname(relative) });
    process.stdout.write(`${formatReleaseGateReport(result)}\n`);
    if (!result.productionQualified) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`PUBLICATION_BLOCKED: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
