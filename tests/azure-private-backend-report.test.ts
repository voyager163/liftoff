import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { backendHttpFixture, backendSource } from './helpers/private-backend-http-fixture.js';
import { fixtureTime } from './helpers/private-activation-fixture.js';
import { privateBackendProbeScript, renderPrivateBackendWorkflow, validatePrivateBackendSource } from '../src/application/azure-activation/private-backend-workflow.js';
import { readPrivateBackendReport, validatePrivateBackendReport } from '../src/application/azure-activation/private-backend-report.js';
import { stateDigest } from '../src/domain/repair/stateful-invariants.js';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';

async function fixture() {
  const f = backendHttpFixture();
  await f.executeProbe();
  const operation = {
    provider: 'github' as const, actionId: 'github.runner.backend-proof', operationId: String(f.runId),
    resourceId: `/repos/owner/repo/actions/runs/${f.runId}`, startedAt: fixtureTime.toISOString(),
    observedAt: fixtureTime.toISOString(), status: 'completed' as const, planDigest: canonicalSha256('fixture exact dispatch')
  };
  const expected = { source: f.source, operation, challenge: f.challenge(), correlationId: f.correlation(),
    configurationDigest: f.configurationDigest(), runnerGroupId: 55 };
  return { ...f, operation, expected };
}

describe('private backend source/report/audit contracts (no live effects)', () => {
  it('retains the exact backend recipe bytes across canonical private record serialization', () => {
    const source = backendSource();
    const persisted = JSON.parse(canonicalJson(source));
    expect(renderPrivateBackendWorkflow(persisted.recipe)).toBe(renderPrivateBackendWorkflow(source.recipe));
    expect(validatePrivateBackendSource(persisted)).toEqual(source);
  });

  it('renders a dispatch-only exact lease protocol whose JavaScript parses, without state content commands or public lease IDs', () => {
    const source = backendSource();
    const rendered = renderPrivateBackendWorkflow(source.recipe);
    const workflow = parse(rendered);
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.permissions).toEqual({ actions: 'read', 'id-token': 'write' });
    expect(workflow['run-name']).toBe('liftoff-${{ inputs.liftoff_operation_id }}');
    expect(workflow.jobs.private_backend.steps[0].env.LIFTOFF_LEASE_CHALLENGE).toBe('${{ inputs.lease_challenge }}');
    expect(workflow.jobs.private_backend.steps[0].env.LIFTOFF_BACKEND_BLOB_URL)
      .toBe('https://liftofffixture.blob.core.windows.net/tfstate/network.tfstate');
    expect(workflow.jobs.private_backend.steps[0].env.LIFTOFF_BACKEND_LEASE_URL)
      .toBe('https://liftofffixture.blob.core.windows.net/tfstate/network.tfstate?comp=lease');
    expect(rendered).not.toMatch(/actions\/checkout|state push|force-unlock|x-ms-lease-action.:.break/);
    const parsed = spawnSync(process.execPath, ['--check', '--input-type=module'], {
      input: privateBackendProbeScript(), encoding: 'utf8', timeout: 30_000
    });
    expect(parsed.status, parsed.stderr).toBe(0);
  });

  it('publishes canonical nested blob and lease URLs as fixed source values, not caller dispatch inputs', () => {
    const source = backendSource();
    source.recipe.target.backend.key = 'environments/dev/network-v1.tfstate';
    const document = parse(renderPrivateBackendWorkflow(source.recipe));
    expect(document.jobs.private_backend.steps[0].env.LIFTOFF_BACKEND_BLOB_URL)
      .toBe('https://liftofffixture.blob.core.windows.net/tfstate/environments/dev/network-v1.tfstate');
    expect(document.jobs.private_backend.steps[0].env.LIFTOFF_BACKEND_LEASE_URL)
      .toBe('https://liftofffixture.blob.core.windows.net/tfstate/environments/dev/network-v1.tfstate?comp=lease');
    expect(Object.keys(document.on.workflow_dispatch.inputs)).toEqual([
      'liftoff_operation_id', 'configuration_digest', 'lease_challenge', 'runner_group_id'
    ]);
    expect(document.jobs.private_backend.steps[0].run).not.toContain(".map(encodeURIComponent)");
  });

  it('reads the source/run/job/check-bound artifact and independently corroborates actual Azure effects', async () => {
    const f = await fixture();
    const read = await readPrivateBackendReport(f.client, f.expected, fixtureTime);
    expect(read.report.probe?.outcome).toBe('verified');
    expect(read.jobId).toBe(7891);
    const audit = await f.audit(async () => undefined).verify(read.report, f.challenge(), f.source.recipe.azureClientId);
    expect(audit.records.map((record) => [record.step, record.status])).toEqual([
      ['acquire', 201], ['contend', 409], ['renew', 200], ['release', 200]
    ]);
    expect(audit.requestIds.length).toBeGreaterThan(1);
    expect(f.queries).toHaveLength(1);
    expect(f.queries[0]).not.toMatch(/AuthenticationHash|RequestMd5|ResponseMd5|RequestIdHeader/);
    expect(JSON.stringify(f.tokenCalls)).not.toContain(f.token);
    expect(JSON.stringify(audit)).not.toContain(f.token);
    expect(JSON.stringify(read)).not.toContain(stateDigest(f.blob.bytes!));
    expect(f.blob.leaseId).toBeNull();
  });

  it('does not assume a log correlation ID is the Azure response request ID', async () => {
    const f = await fixture();
    f.logRows[0]![16] = randomUUID();
    const result = await f.audit(async () => undefined).verify(f.report()!, f.challenge(), f.source.recipe.azureClientId);
    expect(result.records[0]!.correlationId).toBe(f.logRows[0]![16]);
    expect(result.records[0]!.correlationId).not.toBe(f.report()!.probe!.effects[0]!.requestId);
  });

  it('uses the documented storage-log TLS spelling and case-insensitive exact ARM resource identity', async () => {
    const f = await fixture();
    for (const row of f.logRows) {
      row[4] = String(row[4]).toLowerCase();
      row[11] = 'TLS 1.2';
    }
    const result = await f.audit(async () => undefined).verify(f.report()!, f.challenge(), f.source.recipe.azureClientId);
    expect(result.records).toHaveLength(4);
    expect(f.queries[0]).toContain('_ResourceId in~');
    f.logRows[0]![11] = 'TLS 1.0';
    await expect(f.audit(async () => undefined).verify(f.report()!, f.challenge(), f.source.recipe.azureClientId)).rejects.toThrow();
  });

  it('rejects a different storage resource even when its client request ID matches', async () => {
    const f = await fixture();
    f.logRows[0]![4] = String(f.logRows[0]![4]).replace('/liftofffixture/', '/foreignfixture/');
    await expect(f.audit(async () => undefined).verify(f.report()!, f.challenge(), f.source.recipe.azureClientId)).rejects.toThrow();
  });

  it('rejects reused provider request IDs rather than calling client correlations or duplicate IDs independent effects', async () => {
    const f = await fixture();
    const report = structuredClone(f.report()!);
    report.probe = { ...report.probe!, effects: report.probe!.effects.map((effect, index, effects) =>
      index === 1 ? { ...effect, requestId: effects[0]!.requestId } : effect) };
    expect(() => validatePrivateBackendReport(report, f.expected, f.job(), fixtureTime)).toThrow();
  });

  it.each(['missingAudit', 'wrongAuditActor'] as const)('rejects %s even if the workflow report claims verified', async (fault) => {
    const f = await fixture();
    f.states[fault] = true;
    await expect(f.audit(async () => undefined).verify(f.report()!, f.challenge(), f.source.recipe.azureClientId))
      .rejects.toMatchObject({ code: 'verification-incomplete' });
  });

  it.each(['wrongRunner', 'tamperReport'] as const)('rejects %s without changing the report into proof', async (fault) => {
    const f = await fixture();
    f.states[fault] = true;
    await expect(readPrivateBackendReport(f.client, f.expected, fixtureTime)).rejects.toThrow();
  });

  it('rejects synthetic success if the acquired lease, contention or release was not actually reported', async () => {
    const f = await fixture();
    const report = structuredClone(f.report()!);
    report.probe = { ...report.probe!, effects: report.probe!.effects.map((effect) => effect.step === 'contend'
      ? { ...effect, status: 201, errorCode: null } : effect) };
    expect(() => validatePrivateBackendReport(report, f.expected, f.job(), fixtureTime)).toThrow();
  });

  it('preserves real absent-backend failure and does not turn it into locking proof', async () => {
    const f = backendHttpFixture();
    f.blob.bytes = null;
    await f.executeProbe();
    const operation = { provider: 'github' as const, actionId: 'github.runner.backend-proof', operationId: String(f.runId),
      resourceId: `/repos/owner/repo/actions/runs/${f.runId}`, startedAt: fixtureTime.toISOString(),
      observedAt: fixtureTime.toISOString(), status: 'completed' as const };
    const parsed = validatePrivateBackendReport(f.report(), {
      source: f.source, operation, challenge: f.challenge(), correlationId: f.correlation(),
      configurationDigest: f.configurationDigest(), runnerGroupId: 55
    }, f.job(), fixtureTime);
    expect(parsed.probe).toMatchObject({ outcome: 'blocked', reason: 'backend-absent' });
    expect(parsed.probe!.effects.every((effect) => effect.outcome === 'not-attempted')).toBe(true);
    expect(f.blob.calls.filter((call) => call.method !== 'HEAD')).toEqual([]);
  });

  it('rejects future, stale or reordered observations instead of extending authority', async () => {
    const f = await fixture();
    const report = structuredClone(f.report()!);
    report.observedAt = '2026-09-15T00:16:00.000Z';
    expect(() => validatePrivateBackendReport(report, f.expected, f.job(), fixtureTime)).toThrow();
    const past = new Date(fixtureTime.getTime() + 16 * 60_000);
    expect(() => validatePrivateBackendReport(f.report(), f.expected, f.job(), past)).toThrow();
  });

  it.each(['startedAt', 'observedAt'] as const)('rejects non-string effect %s without coercion or a default observation', async (field) => {
    const f = await fixture();
    const report = structuredClone(f.report()!);
    Object.assign(report.probe!.effects[0]!, { [field]: fixtureTime.getTime() });
    expect(() => validatePrivateBackendReport(report, f.expected, f.job(), fixtureTime)).toThrow();
  });
});
