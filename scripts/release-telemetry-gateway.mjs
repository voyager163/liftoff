import { execFileSync } from 'node:child_process';
import {
  canonicalJson, CANONICAL_REPOSITORY, exactIds, inspectFile, readJsonFile, same, sha256
} from './release-evidence.mjs';
import { exactKeys, instant, object, requireValue } from './release-evidence-github.mjs';

export const TELEMETRY_CONTRACT_PATH = 'src/telemetry/contract.ts';
export const TELEMETRY_BASELINE_FIXTURE = 'services/telemetry-ingest/tests/fixtures/released-client-v0.12.3.json';
export const TELEMETRY_PROFILE_ID = 'liftoff-command-event-v1';
const SERVICE_SOURCES = ['services/telemetry-ingest/src/handler.ts', 'services/telemetry-ingest/src/server.ts', 'services/telemetry-ingest/src/index.ts'];
const FIELDS = ['schemaVersion', 'event', 'command', 'cliVersion', 'outcome'];
const STORAGE_FIELDS = ['TimeGenerated', 'EventName', 'SchemaVersion', 'Command', 'CliVersion', 'Outcome'];
const REJECTIONS = ['extra-property', 'missing-property', 'unknown-command', 'command-prefix', 'invalid-version',
  'invalid-outcome', 'wrong-schema', 'wrong-event', 'array-body', 'malformed-json', 'oversized-stream', 'wrong-method', 'wrong-content-type'];

function historicalLiteralArray(source, name) {
  const declarations = [...source.matchAll(new RegExp(`^export const ${name} = \\[([\\s\\S]*?)\\] as const;`, 'gm'))];
  requireValue(declarations.length === 1, `Immutable baseline lacks the registered literal ${name} declaration`);
  const body = declarations[0][1];
  const values = [...body.matchAll(/'([A-Za-z0-9:_-]+)'/g)].map((match) => match[1]);
  requireValue(values.length > 0 && body.replace(/'[A-Za-z0-9:_-]+'/g, '').replace(/[\s,]/g, '') === '', 'Historical telemetry declaration is not an exact literal inventory');
  exactIds(values, values, `Historical ${name}`);
  return values;
}

export function loadTelemetryReleaseContract(projectRoot, scope, telemetry) {
  requireValue(telemetry?.telemetrySchemaVersion === 1 && telemetry.telemetryEventName === 'command_executed', 'Unsupported candidate telemetry event contract');
  exactIds([...telemetry.telemetryClientFields], FIELDS, 'Exact five-field telemetry payload');
  exactIds([...telemetry.telemetryStorageFields], STORAGE_FIELDS, 'Exact telemetry storage fields');
  exactIds([...telemetry.telemetryCommands], [...telemetry.telemetryCommands], 'Candidate telemetryCommands');
  requireValue(telemetry.telemetryCommands.length > 0, 'Candidate telemetry command inventory is empty');
  let historical;
  try {
    historical = execFileSync('git', ['--no-pager', 'show', `${scope.baseline.sourceCommit}:${TELEMETRY_CONTRACT_PATH}`], {
      cwd: projectRoot, encoding: 'utf8', timeout: 15_000, maxBuffer: 256 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
    });
  } catch {
    throw new Error('Missing immutable v0.12.3 telemetry contract Git bytes; historical source cannot be fabricated or executed as a fallback');
  }
  requireValue(/^export const telemetrySchemaVersion = 1 as const;$/m.test(historical) &&
    /^export const telemetryEventName = 'command_executed' as const;$/m.test(historical), 'Released telemetry schema/event identity mismatch');
  const baselineFields = historicalLiteralArray(historical, 'telemetryClientFields');
  const baselineCommands = historicalLiteralArray(historical, 'telemetryCommands');
  exactIds(baselineFields, FIELDS, 'Released five-field telemetry payload');
  requireValue(baselineCommands.every((command) => telemetry.telemetryCommands.includes(command)), 'Candidate shared gateway contract no longer admits a released v0.12.3 command');
  const fixture = readJsonFile(projectRoot, TELEMETRY_BASELINE_FIXTURE);
  same(fixture.value, { sourceCommit: scope.baseline.sourceCommit, cliVersion: scope.baseline.version, schemaVersion: 1,
    event: 'command_executed', commands: baselineCommands }, 'Released client fixture versus immutable v0.12.3 source');
  const contract = {
    id: TELEMETRY_PROFILE_ID, schemaVersion: 1, event: 'command_executed', fields: [...telemetry.telemetryClientFields],
    storageFields: [...telemetry.telemetryStorageFields], maximumBodyBytes: 1024,
    candidate: { cliVersion: scope.candidate.version, commands: [...telemetry.telemetryCommands],
      sourceSha256: inspectFile(projectRoot, TELEMETRY_CONTRACT_PATH).sha256 },
    baseline: { sourceCommit: scope.baseline.sourceCommit, cliVersion: scope.baseline.version, commands: baselineCommands,
      sourceSha256: sha256(historical), fixtureSha256: fixture.file.sha256 },
    serviceSources: Object.fromEntries(SERVICE_SOURCES.map((file) => [file, inspectFile(projectRoot, file).sha256]))
  };
  return { ...contract, sha256: sha256(canonicalJson(contract)) };
}

export function telemetryAcceptanceCases(contract) {
  return ['candidate', 'baseline'].flatMap((generation) => contract[generation].commands.flatMap((command) =>
    ['success', 'failure'].map((outcome) => ({ generation, input: { schemaVersion: 1, event: 'command_executed',
      command, cliVersion: contract[generation].cliVersion, outcome } }))));
}

export function gatewayImageTestRequest(context) {
  const gateway = validateGatewayRegistration(context.scope.verification?.telemetryGateway);
  return {
    schemaVersion: 1, operation: 'qualify-packaged-gateway-image', image: gateway.image,
    sourceCommit: gateway.sourceCommit, telemetryContractSha256: context.telemetry.sha256,
    entrypoint: 'packaged-createTelemetryServer', network: 'none', destination: 'loopback',
    ingestionSink: 'recording-stub', accepted: telemetryAcceptanceCases(context.telemetry), rejected: REJECTIONS
  };
}

export function validateGatewayRegistration(gateway) {
  object(gateway, 'Missing telemetryGateway registration: exact deployed Container App/revision/container, immutable image/source and operator/image verification workflows are required');
  exactKeys(gateway, ['schemaVersion', 'resourceId', 'revision', 'container', 'image', 'sourceCommit', 'workflow', 'imageWorkflow', 'apiVersion', 'maxAgeSeconds'], 'Deployed gateway registration');
  requireValue(gateway.schemaVersion === 1, 'Unsupported deployed gateway registration');
  requireValue(typeof gateway.resourceId === 'string' && /^\/subscriptions\/[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}\/resourceGroups\/[A-Za-z0-9_.()-]+\/providers\/Microsoft\.App\/containerApps\/[a-z0-9-]+$/.test(gateway.resourceId), 'Gateway requires its exact Container App resource ID');
  requireValue(typeof gateway.revision === 'string' && /^[a-z0-9][a-z0-9-]{1,126}$/.test(gateway.revision) &&
    gateway.revision.startsWith(`${gateway.resourceId.split('/').at(-1)}--`), 'Gateway revision must identify the exact registered Container App revision');
  requireValue(typeof gateway.container === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(gateway.container), 'Missing exact gateway container identity');
  requireValue(typeof gateway.image === 'string' && /^[a-z0-9.-]+\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/.test(gateway.image) && !gateway.image.includes('..'), 'Gateway image must use an immutable OCI SHA-256 digest, never a tag');
  requireValue(/^[a-f0-9]{40}$/.test(gateway.sourceCommit), 'Gateway image requires its explicit immutable build source commit');
  requireValue(typeof gateway.workflow === 'string' && gateway.workflow.length > 0 && typeof gateway.imageWorkflow === 'string' && gateway.imageWorkflow.length > 0, 'Missing trusted gateway operator/image verification workflows');
  requireValue(/^\d{4}-\d\d-\d\d$/.test(gateway.apiVersion), 'Gateway management observation requires an explicit stable API version');
  requireValue(Number.isSafeInteger(gateway.maxAgeSeconds) && gateway.maxAgeSeconds > 0 && gateway.maxAgeSeconds <= 3600, 'Deployed gateway observations must be fresh within at most one hour');
  return gateway;
}

export async function verifyTelemetryGateway({ context, report, executionSummary, evidenceRoot, imageVerifier, trackedFiles, now }) {
  const gateway = validateGatewayRegistration(context.scope.verification?.telemetryGateway);
  requireValue(report && report.origin.workflow === gateway.workflow, 'Missing authenticated operator telemetry-gateway report; source client/service tests are not deployed-revision qualification');
  const data = report.data;
  exactKeys(data, ['registration', 'contract', 'imageManifest', 'deployment', 'imageInspection', 'testRequestSha256', 'accepted', 'rejected', 'caseIds'], 'Deployed gateway evidence');
  same(data.registration, gateway, 'Qualified deployed gateway image/revision/source registration');
  same(data.contract, context.telemetry, 'Candidate and released telemetry contract/allowlist binding');
  const cases = context.qualificationRegistry.cases.filter((row) => row.purpose === 'telemetryGateway');
  exactIds(data.caseIds, cases.map((row) => row.id), 'Operator gateway qualification cases');
  const measured = executionSummary.cases.filter((row) => data.caseIds.includes(row.caseId));
  requireValue(measured.length === cases.length && measured.length > 0 && measured.every((row) => row.verificationRunId === report.origin.runId), 'Gateway observations are not from the approved independently verified gateway case runs');
  for (const row of cases) {
    const host = context.qualificationRegistry.hosts[context.qualificationRegistry.recipes[row.recipe].verificationHost];
    requireValue(host.workflow === gateway.workflow, 'Gateway case uses another operator verification workflow');
  }
  const image = data.imageManifest;
  exactKeys(image, ['path', 'sha256', 'origin'], 'Immutable gateway image manifest proof');
  requireValue(image.origin?.workflow === gateway.imageWorkflow, 'Gateway image provenance is not from its registered build workflow');
  const manifest = readJsonFile(evidenceRoot, image.path, image.sha256);
  trackedFiles.push(manifest.file);
  const [imageName, imageDigest] = gateway.image.split('@sha256:');
  requireValue(manifest.file.sha256 === imageDigest && manifest.value.schemaVersion === 2 &&
    ['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'].includes(manifest.value.mediaType) &&
    /^sha256:[a-f0-9]{64}$/.test(manifest.value.config?.digest) && Number.isSafeInteger(manifest.value.config.size) && manifest.value.config.size > 0 &&
    Array.isArray(manifest.value.layers) && manifest.value.layers.length > 0 && manifest.value.layers.length <= 256 &&
    manifest.value.layers.every((layer) => /^sha256:[a-f0-9]{64}$/.test(layer.digest) && Number.isSafeInteger(layer.size) && layer.size > 0),
  'Gateway OCI manifest bytes/config/layers do not identify the exact deployed image');
  await imageVerifier.verifyFile({ ...manifest.file, name: imageName }, image.origin, 'telemetry-gateway-image');
  for (const [sourcePath, digest] of Object.entries({ [TELEMETRY_CONTRACT_PATH]: context.telemetry.candidate.sourceSha256, ...context.telemetry.serviceSources })) {
    const source = await imageVerifier.api(`repos/${CANONICAL_REPOSITORY}/contents/${sourcePath}?ref=${gateway.sourceCommit}`);
    requireValue(source.type === 'file' && source.path === sourcePath && source.encoding === 'base64' &&
      typeof source.content === 'string' && sha256(Buffer.from(source.content, 'base64')) === digest,
    'Deployed gateway image build source has a different shared telemetry contract/allowlist or gateway implementation than the candidate');
  }
  exactKeys(data.imageInspection, ['image', 'configDigest', 'os', 'architecture', 'entrypoint', 'network', 'destination', 'ingestionSink'], 'Qualified packaged gateway inspection');
  same(data.imageInspection, { image: gateway.image, configDigest: manifest.value.config.digest, os: 'linux', architecture: 'amd64',
    entrypoint: 'packaged-createTelemetryServer', network: 'none', destination: 'loopback', ingestionSink: 'recording-stub' },
  'Gateway qualification must execute the exact packaged image with loopback/stub ingestion, never source-only tests or synthetic production events');
  const deployed = data.deployment;
  exactKeys(deployed, ['provider', 'method', 'apiVersion', 'resourceId', 'revision', 'container', 'image', 'provisioningState', 'healthState', 'active', 'traffic', 'allowInsecure', 'observedAt'], 'Sanitized deployed gateway readback');
  requireValue(deployed.provider === 'azure-resource-manager' && deployed.method === 'GET' && deployed.apiVersion === gateway.apiVersion &&
    deployed.resourceId === gateway.resourceId && deployed.revision === gateway.revision && deployed.container === gateway.container && deployed.image === gateway.image,
  'Gateway readback does not observe the exact deployed resource/revision/container/image');
  requireValue(deployed.provisioningState === 'Provisioned' && deployed.healthState === 'Healthy' && deployed.active === true && deployed.allowInsecure === false,
    'Qualified gateway revision is not active, healthy, provisioned and HTTPS-only');
  same(deployed.traffic, [{ revision: gateway.revision, weight: 100 }], 'All active gateway traffic must use the qualified revision');
  const observedAt = instant(deployed.observedAt, 'Gateway observation');
  requireValue(observedAt <= now && now - observedAt <= gateway.maxAgeSeconds * 1000 && observedAt <= report.verifiedFile.witnessedAt &&
    measured.every((row) => {
      const job = report.verifiedFile.jobs.find((candidate) => candidate.id === Number(row.verificationJobId));
      return job && observedAt >= instant(job.started_at, 'Gateway verification start') &&
        observedAt >= instant(row.completedAt, 'Gateway execution completion') && observedAt <= instant(job.completed_at, 'Gateway verification completion');
    }),
  'Gateway deployment observation is old or outside the approved independent verification window');
  requireValue(data.testRequestSha256 === sha256(canonicalJson(gatewayImageTestRequest(context))), 'Gateway image tests do not bind the exact approved image and candidate/baseline event cases');
  requireValue(Array.isArray(data.accepted), 'Missing measured packaged-gateway acceptance observations');
  const expected = telemetryAcceptanceCases(context.telemetry);
  exactIds(data.accepted.map((entry) => canonicalJson({ generation: entry.generation, input: entry.input })), expected.map(canonicalJson), 'Every candidate and released command/outcome must be accepted by the deployed image');
  for (const entry of data.accepted) {
    exactKeys(entry, ['generation', 'input', 'status', 'sinkRecordCount', 'sinkFields'], 'Gateway acceptance observation');
    exactKeys(entry.input, FIELDS, 'Exactly five-field gateway event');
    requireValue(entry.status === 204 && entry.sinkRecordCount === 1, 'Gateway rejected a candidate/released event or did not produce exactly one stub record');
    exactIds(entry.sinkFields, STORAGE_FIELDS, 'Gateway stored field privacy');
  }
  requireValue(Array.isArray(data.rejected), 'Missing packaged-gateway exact-contract rejection observations');
  exactIds(data.rejected.map((entry) => entry.id), REJECTIONS, 'Gateway invalid event coverage');
  for (const entry of data.rejected) {
    exactKeys(entry, ['id', 'status', 'sinkRecordCount'], 'Gateway rejection observation');
    const status = entry.id === 'oversized-stream' ? 413 : entry.id === 'wrong-method' ? 405 : entry.id === 'wrong-content-type' ? 415 : 400;
    requireValue(entry.status === status && entry.sinkRecordCount === 0, 'Gateway admitted an extra/invalid field, unknown command or unsupported request');
  }
  const imageValidity = imageVerifier.assertFresh(now);
  return { revision: gateway.revision, image: gateway.image, sourceCommit: gateway.sourceCommit,
    telemetryContractSha256: context.telemetry.sha256, baselineVersion: context.telemetry.baseline.cliVersion,
    candidateCommands: context.telemetry.candidate.commands.length, baselineCommands: context.telemetry.baseline.commands.length,
    validUntil: new Date(Math.min(observedAt + gateway.maxAgeSeconds * 1000, Date.parse(imageValidity.validUntil))).toISOString() };
}

export const telemetryGatewayRejectionCases = REJECTIONS;
