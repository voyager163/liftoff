import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('read-only coordinated release evidence workflow', () => {
  it('keeps all packaged text-resource families LF-stable under Windows checkout defaults', () => {
    const resources = [
      'assets/templates/components/common/dockerignore.txt', 'assets/templates/catalog.json',
      'assets/skills/catalog.json', 'assets/profiles/catalog.json', 'assets/distribution/native-trust.json',
      'assets/governance/single-maintainer-gitflow/policy.md', 'assets/repair/windows-job-controller.ps1'
    ];
    const fields = execFileSync('git', ['-c', 'core.autocrlf=true', 'check-attr', '-z', 'eol', '--', ...resources], {
      cwd: process.cwd(), encoding: 'utf8'
    }).split('\0').filter(Boolean);
    expect(fields).toEqual(resources.flatMap((file) => [file, 'eol', 'lf']));
  });

  it('fetches immutable release history for source tests without leaving checkout credentials in Git', async () => {
    const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
    for (const id of ['test', 'coverage-qualification']) {
      const checkout = workflow.jobs[id].steps.find((step: { uses?: string }) => step.uses?.startsWith('actions/checkout@'));
      expect(checkout?.with).toMatchObject({ 'fetch-depth': 0, 'persist-credentials': false });
    }
  });

  it('measures native launcher source fixtures separately on each source host without claiming PE qualification', async () => {
    const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
    const job = workflow.jobs.test;
    expect(job.strategy.matrix.os).toEqual(['ubuntu-latest', 'macos-latest', 'windows-latest']);
    const measurement = job.steps.findIndex((step: any) =>
      step.name === 'Measure Windows launcher source fixtures (not native qualification)');
    expect(measurement).toBeGreaterThanOrEqual(0);
    const step = job.steps[measurement];
    expect(job.steps.slice(0, measurement).some((entry: any) => entry.uses?.startsWith('actions/setup-go@'))).toBe(true);
    expect(step.shell).toBe('bash');
    expect(step.run).toBe('go test -count=1 -coverprofile="$RUNNER_TEMP/liftoff-windows-launcher-source.coverprofile" scripts/distribution/windows-launcher.go scripts/distribution/windows-launcher_test.go');
    expect(step['continue-on-error']).toBeUndefined();
    const retained = job.steps[measurement + 1];
    expect(retained.if).toBe('always()');
    expect(retained.uses).toMatch(/^actions\/upload-artifact@[a-f0-9]{40}$/);
    expect(retained.with.name).toBe('windows-launcher-source-coverage-${{ matrix.os }}');
    expect(retained.with.path).toBe('${{ runner.temp }}/liftoff-windows-launcher-source.coverprofile');
    expect(retained.with['if-no-files-found']).toBe('error');
  });

  it('measures both complete packages before the strict independent coverage gate', async () => {
    const workflow = parse(await readFile('.github/workflows/ci.yml', 'utf8'));
    const job = workflow.jobs['coverage-qualification'];
    const steps = job.steps;
    const cli = steps.findIndex((step: any) => step.run === 'npm run test:coverage -- --maxWorkers=2');
    const service = steps.findIndex((step: any) => step.run === 'npm run test:coverage --prefix services/telemetry-ingest -- --maxWorkers=2');
    const gate = steps.findIndex((step: any) => step.run === 'npm run gate:coverage');
    expect(cli).toBeGreaterThanOrEqual(0);
    expect(service).toBeGreaterThanOrEqual(0);
    expect(gate).toBeGreaterThan(cli);
    expect(gate).toBeGreaterThan(service);
    for (const action of ['actions/setup-python@', 'actions/setup-go@', 'opentofu/setup-opentofu@']) {
      expect(steps.slice(0, cli).some((step: any) => step.uses?.startsWith(action))).toBe(true);
    }
    expect(steps.slice(0, cli).some((step: any) => step.run === 'python -m pip install uv==0.12.7 checkov==3.2.495')).toBe(true);
    expect(workflow.jobs.test.steps.some((step: any) => step.run?.includes('checkov==3.2.495'))).toBe(true);
    expect(steps[cli]['continue-on-error']).toBeUndefined();
    expect(steps[gate]['continue-on-error']).toBeUndefined();
    expect(steps.at(-1).with.path).toContain('coverage/coverage-final.json');
    expect(steps.at(-1).with.path).toContain('services/telemetry-ingest/coverage/coverage-final.json');
  });

  it('separates three-OS source validation from actual six-target native/evidence admission', async () => {
    const text = await readFile(path.join(process.cwd(), '.github/workflows/release.yml'), 'utf8');
    const workflow = parse(text);
    expect(workflow.on.push).toBeUndefined();
    expect(workflow.on.workflow_dispatch.inputs.mode.options).toEqual(['source-validation', 'evidence-validation', 'prepare-action', 'approve-action', 'qualify-records']);
    expect(workflow.on.workflow_dispatch.inputs.source_commit.required).toBe(true);
    for (const input of ['evidence_run_id', 'evidence_run_attempt', 'evidence_artifact_id']) {
      expect(workflow.on.workflow_dispatch.inputs[input].type).toBe('string');
    }
    expect(workflow.jobs.source.strategy.matrix.os).toEqual(['ubuntu-latest', 'macos-latest', 'windows-latest']);
    expect(workflow.jobs.source.name).toContain('not native qualification');
    expect(workflow.jobs.evidence.needs).toBe('source');
    expect(workflow.jobs.evidence.if).toBe("inputs.mode == 'evidence-validation'");
    expect(text).toContain('"$SOURCE_COMMIT" != "$GITHUB_SHA"');
    expect(text).toContain('persist-credentials: false');
    expect(text).toContain('capture-source --source-commit "$SOURCE_COMMIT" --output build/source-validation/report.json');
    expect(workflow.jobs.source.steps.at(-1).with['if-no-files-found']).toBe('error');
    expect(workflow.jobs.source.steps.some((step: any) => step.run?.includes('release-gate.mjs --evidence'))).toBe(false);
  });

  it('collects exact authenticated public evidence before invoking the real final gate without publication authority', async () => {
    const text = await readFile('.github/workflows/release.yml', 'utf8');
    const workflow = parse(text);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs.evidence.permissions).toEqual({ contents: 'read', actions: 'read', attestations: 'read' });
    const steps = workflow.jobs.evidence.steps;
    const collect = steps.findIndex((step: any) => step.name === 'Collect authenticated previously authorized evidence');
    const gate = steps.findIndex((step: any) => step.name === 'Validate coordinated publication release gate');
    expect(collect).toBeGreaterThanOrEqual(0);
    expect(gate).toBeGreaterThan(collect);
    expect(steps[collect].run).toContain('--source-commit "$SOURCE_COMMIT"');
    expect(steps[collect].run).toContain('--run-id "$EVIDENCE_RUN_ID"');
    expect(steps[collect].run).toContain('--run-attempt "$EVIDENCE_RUN_ATTEMPT"');
    expect(steps[collect].run).toContain('--artifact-id "$EVIDENCE_ARTIFACT_ID"');
    expect(steps[gate].run).toBe('node scripts/release-gate.mjs --evidence build/release-evidence/release-evidence.json');
    for (const forbidden of ['npm publish', 'dist-tag', 'dry_run', 'npm pack', 'registry-url:', 'verified: true', 'publicationApproval', 'contents: write', 'continue-on-error', 'gh release create', 'environment:']) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).toContain('Missing prerequisite: exact completed trusted evidence run');
    expect(text).not.toContain('verify:published');
  });

  it('separates explicit Liftoff action dispatch from environment reviewer gates and provider execution', async () => {
    const workflow = parse(await readFile('.github/workflows/release.yml', 'utf8'));
    expect(workflow.on.workflow_dispatch.inputs.approval_purpose.options).toEqual(['none', 'publication', 'liveQualification', 'dashboard', 'telemetryGateway']);
    expect(workflow.on.workflow_dispatch.inputs.approval_purpose.default).toBe('none');
    const producer = workflow.jobs.produce;
    expect(producer.needs).toBe('source');
    expect(producer.permissions).toEqual({ contents: 'read', actions: 'read', attestations: 'write', 'id-token': 'write' });
    expect(producer.environment).toBeUndefined();
    const production = producer.steps.findIndex((step: any) => step.name === 'Produce exact request, action receipt, or verified execution aggregate');
    const attestation = producer.steps.findIndex((step: any) => step.name === 'Attest only the successfully verified report bytes');
    expect(production).toBeLessThan(attestation);
    expect(producer.steps[production].env.LIFTOFF_RELEASE_MODE).toBe('${{ inputs.mode }}');
    expect(producer.steps[production].run).toContain('scripts/produce-release-evidence.mjs');
    expect(producer.steps[attestation].uses).toMatch(/^actions\/attest-build-provenance@[a-f0-9]{40}$/);
    expect(producer.steps[attestation].with['subject-path']).toBe('${{ env.REPORT_PATH }}');
    expect(producer.steps.at(-1).with.path).toBe('${{ env.REPORT_PATH }}');
    expect(producer.env.REPORT_PATH).not.toContain('*');
    expect(producer.steps.some((step: any) => step.run?.includes('gh workflow run') || step.run?.includes('az deployment'))).toBe(false);
  });

  it('preserves independently selected historical npm verification tooling', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
    const historical = await readFile('scripts/verify-published-package.mjs', 'utf8');
    expect(packageJson.scripts['verify:published']).toContain('scripts/verify-published-package.mjs');
    expect(historical).toMatch(/version|args/);
    const source = await readFile('scripts/collect-release-evidence.mjs', 'utf8');
    expect(source).toContain('SOURCE_ONLY_NOT_QUALIFIED');
    expect(source).not.toContain('QUALIFIED_FOR_PUBLICATION');
  });
});
