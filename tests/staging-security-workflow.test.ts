import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { readFile, writeFile, chmod, rm, lstat, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { crc32 } from 'node:zlib';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import {
  stagingSecurityWorkflowRecipe,
  stagingSecurityWorkflowRecipeId,
  stagingSecurityWorkflowJob,
  stagingSecurityWorkflowReportFile,
  stagingSecurityWorkflowIntegration,
  stagingSecurityWorkflowRuntimePrerequisites,
  stagingSecurityWorkflowLimitations,
  renderStagingSecurityWorkflow,
  stagingSecurityWorkflowSource,
  stagingSecurityWorkflowDispatchInputs,
  stagingSecuritySourceRecipe,
  assertStagingSecurityWorkflowSource,
  parseTrivyScanOutput,
  parseZapScanOutput,
  readStagingSecurityArchive,
  parseStagingSecurityReport,
  validateStagingSecurityReport,
  assertStagingSecurityReportPassed,
  type StagingSecurityWorkflowRecipe
  , type PublishedStagingSecurityWorkflowRecipe
} from '../src/application/azure-activation/staging-security-workflow.js';
import { stagingSecurityWorkflowProgram } from '../src/application/azure-activation/staging-security-workflow-program.js';
import { extractPrivateReportArchive } from '../src/application/azure-activation/private-report-archive.js';

const validSourceSha = '1234567890abcdef1234567890abcdef12345678';
const uploadSha = 'abcdefabcdef12345678901234567890abcdef12';

function sampleRecipe(): PublishedStagingSecurityWorkflowRecipe {
  return {
    schemaVersion: 1,
    recipe: stagingSecurityWorkflowRecipeId,
    workflowPath: '.github/workflows/liftoff-staging-security.yml',
    repository: 'voyager163/liftoff',
    repositoryId: 42,
    actorId: 99,
    workflowId: 101,
    ref: 'release/0.14.0',
    sourceSha: validSourceSha,
    azure: {
      subscriptionId: '11111111-2222-4333-8444-555555555555',
      tenantId: '66666666-7777-4888-8999-000000000001',
      clientId: '12345678-1111-4222-8333-555555555555',
      principalId: '88888888-9999-4aaa-8bbb-cccccccccccc'
    },
    environment: 'staging',
    target: {
      resourceId: '/subscriptions/11111111-2222-4333-8444-555555555555/resourceGroups/rg-staging/providers/Microsoft.App/containerApps/staging-app',
      fqdn: 'staging-app.nicecliff-1234.eastus.azurecontainerapps.io',
      appName: 'staging-app',
      healthPath: '/health',
      schemaPath: '/openapi.json'
      , privateIp: null
    },
    image: {
      loginServer: 'crliftoff.azurecr.io',
      repository: 'liftoff/app',
      digest: 'sha256:' + 'a'.repeat(64)
    },
    database: { cacheDirectory: '/srv/liftoff/trivy', databaseSha256: 'd'.repeat(64), metadataSha256: 'e'.repeat(64), maxAgeHours: 24 },
    runner: {
      group: 'staging-runners',
      label: 'staging-vnet-linux',
      runnerId: 501,
      runnerGroupId: 12
    },
    tools: {
      containerScanner: {
        name: 'trivy',
        executable: '/usr/bin/trivy',
        version: '0.59.1', expectedSha256: `sha256:${'b'.repeat(64)}`
      },
      dastScanner: {
        name: 'zap-baseline',
        executable: '/opt/zap/zap-baseline.py',
        version: '2.14.0', expectedSha256: `sha256:${'c'.repeat(64)}`
      },
      azureCli: { name: 'az', executable: '/usr/bin/az', version: '2.74.0', expectedSha256: `sha256:${'e'.repeat(64)}` },
      azureLoginActionSha: 'e'.repeat(40),
      uploadArtifactActionSha: uploadSha
    },
    authority: {
      allowedNetworkTargets: [
        'staging-app.nicecliff-1234.eastus.azurecontainerapps.io',
        'api.github.com', 'crliftoff.azurecr.io'
      ],
      budget: {
        currency: 'USD',
        fixedMonthlyCents: 0,
        usageMonthlyCents: 500
      },
      limits: {
        maxRunMinutes: 15,
        commandTimeoutSeconds: 60,
        scanTimeoutSeconds: 300,
        httpTimeoutSeconds: 15
      }
    },
    policy: {
      failOnSeverities: ['CRITICAL', 'HIGH'],
      failOnDastRisk: ['HIGH', 'MEDIUM']
    }
  };
}

function makeZip(filename: string, content: Buffer): Buffer {
  const name = Buffer.from(filename);
  const local = Buffer.alloc(30), central = Buffer.alloc(46), footer = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc32(content), 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);

  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc32(content), 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);

  footer.writeUInt32LE(0x06054b50, 0);
  footer.writeUInt16LE(1, 8);
  footer.writeUInt16LE(1, 10);
  footer.writeUInt32LE(central.length + name.length, 12);
  footer.writeUInt32LE(local.length + name.length + content.length, 16);

  return Buffer.concat([local, name, content, central, name, footer]);
}

const cleanupDirs: string[] = [];
const cleanupServers: Server[] = [];

afterEach(async () => {
  for (const s of cleanupServers.splice(0)) {
    s.close();
  }
  for (const d of cleanupDirs.splice(0)) {
    await rm(d, { recursive: true, force: true });
  }
});

describe('Staging Security Workflow Recipe & Source Generation', () => {
  it('validates a complete, authentic staging security recipe', () => {
    const recipe = stagingSecurityWorkflowRecipe(sampleRecipe());
    expect(recipe.recipe).toBe(stagingSecurityWorkflowRecipeId);
    expect(recipe.environment).toBe('staging');
    expect(recipe.authority.allowedNetworkTargets).toContain(recipe.target.fqdn);
    expect(recipe.tools.containerScanner.name).toBe('trivy');
    expect(recipe.tools.dastScanner.name).toBe('zap-baseline');
  });

  it('rejects recipes targeting dev or prod environments', () => {
    const devRecipe = { ...sampleRecipe(), environment: 'dev' };
    expect(() => stagingSecurityWorkflowRecipe(devRecipe)).toThrow(/staging environment/i);

    const prodRecipe = { ...sampleRecipe(), environment: 'prod' };
    expect(() => stagingSecurityWorkflowRecipe(prodRecipe)).toThrow(/staging environment/i);
  });

  it('rejects recipes with missing or disallowed network targets', () => {
    const invalidRecipe = sampleRecipe();
    invalidRecipe.authority.allowedNetworkTargets = ['api.github.com'];
    expect(() => stagingSecurityWorkflowRecipe(invalidRecipe)).toThrow(/Allowed network targets must be exactly/i);
  });

  it('renders a valid GitHub Actions workflow YAML matching the dedicated runner and read permissions', () => {
    const recipe = sampleRecipe();
    const yamlStr = renderStagingSecurityWorkflow(recipe);
    const parsed = parse(yamlStr);

    expect(parsed.name).toBe(stagingSecurityWorkflowJob);
    expect(parsed.permissions).toEqual({ actions: 'read', contents: 'read' });
    expect(parsed.jobs.security_dast['runs-on']).toEqual({
      group: 'staging-runners',
      labels: 'staging-vnet-linux'
    });
    expect(parsed.jobs.security_dast['timeout-minutes']).toBe(15);
    expect(parsed.jobs.security_dast.steps).toHaveLength(4);
    expect(parsed.jobs.security_dast.steps[3].uses).toBe(`actions/upload-artifact@${uploadSha}`);
    expect(parsed.jobs.security_dast.permissions['id-token']).toBe('write');
    expect(Object.keys(parsed.on.workflow_dispatch.inputs).sort()).toEqual([...stagingSecurityWorkflowIntegration.dispatchInputs].sort());
    const execution = parsed.jobs.security_dast.steps[2];
    expect(JSON.parse(execution.env.LIFTOFF_STAGING_SECURITY_RECIPE).runner).toEqual({
      group: recipe.runner.group, label: recipe.runner.label
    });
    expect(execution.env.LIFTOFF_RUNNER_GROUP_ID).toBe('${{ inputs.runner_group_id }}');
    expect(execution.env.LIFTOFF_RUNNER_ID).toBe('${{ inputs.runner_id }}');
  });

  it('produces workflow source definitions and validates source equality', () => {
    const recipe = sampleRecipe();
    const source = stagingSecurityWorkflowSource(recipe);
    expect(source.recipe).toBe(stagingSecurityWorkflowRecipeId);
    expect(source.files).toHaveLength(1);
    expect(source.workflow.expectedJobs).toEqual([stagingSecurityWorkflowJob]);

    assertStagingSecurityWorkflowSource(source.files[0].content, recipe);
    expect(() => assertStagingSecurityWorkflowSource('corrupted: yaml', recipe)).toThrow();
  });

  it('generates exact dispatch bindings and leaves correlation issuance to the private dispatcher', () => {
    const recipe = sampleRecipe();
    const correlationId = randomUUID();
    const inputs = stagingSecurityWorkflowDispatchInputs(recipe);
    expect(inputs.liftoff_operation_id).toBeUndefined();
    expect(inputs.source_sha).toBe(validSourceSha);
    expect(inputs.workflow_id).toBe('101');
    expect(inputs.runner_group_id).toBe('12');
    expect(inputs.runner_id).toBe('501');
    expect(inputs.qualification_digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('publishes source without circular future commit or workflow ID dependencies', () => {
    const recipe = sampleRecipe();
    const unpublished = { ...recipe, workflowId: null, sourceSha: null };
    expect(renderStagingSecurityWorkflow(unpublished)).toBe(renderStagingSecurityWorkflow(recipe));
    expect(() => stagingSecurityWorkflowDispatchInputs(unpublished)).toThrow(/actual published workflow/);
    expect(stagingSecuritySourceRecipe(unpublished)).not.toHaveProperty('sourceSha');
    const noFutureClaims: StagingSecurityWorkflowRecipe = { ...unpublished,
      target: { ...recipe.target, fqdn: null }, image: { ...recipe.image, digest: null },
      database: { ...recipe.database, databaseSha256: null, metadataSha256: null },
      runner: { group: recipe.runner.group, label: recipe.runner.label },
      authority: { ...recipe.authority, allowedNetworkTargets: null }
    };
    expect(stagingSecurityWorkflowRecipe(noFutureClaims).runner).toEqual(noFutureClaims.runner);
    expect(renderStagingSecurityWorkflow(noFutureClaims)).toBe(renderStagingSecurityWorkflow(recipe));
    const rebound = structuredClone(recipe);
    rebound.image.digest = `sha256:${'9'.repeat(64)}`;
    rebound.target.fqdn = 'other.fixture.azurecontainerapps.io';
    rebound.authority.allowedNetworkTargets = [rebound.target.fqdn, 'api.github.com', rebound.image.loginServer];
    rebound.database.databaseSha256 = '8'.repeat(64);
    rebound.runner.runnerId = 1900;
    rebound.runner.runnerGroupId = 55;
    expect(renderStagingSecurityWorkflow(rebound)).toBe(renderStagingSecurityWorkflow(recipe));
    expect(stagingSecurityWorkflowDispatchInputs(rebound)).not.toEqual(stagingSecurityWorkflowDispatchInputs(recipe));
  });

  it('does not require an invented future instance ID for a dedicated hosted runner group', () => {
    const recipe = sampleRecipe();
    recipe.runner.runnerId = null;
    const normalized = stagingSecurityWorkflowRecipe(recipe);
    expect(normalized.runner.runnerId).toBeNull();
    expect(stagingSecuritySourceRecipe(normalized).runner).toEqual({ group: recipe.runner.group, label: recipe.runner.label });
    expect(stagingSecurityWorkflowDispatchInputs(normalized).runner_id).toBe('none');
    expect(stagingSecurityWorkflowDispatchInputs(normalized).qualification_digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    { runnerId: null, runnerGroupId: null },
    { runnerId: null, runnerGroupId: 12 },
    { runnerId: 501, runnerGroupId: 12 }
  ])('strips explicitly supplied unpublished runner identities %j from source', (identity) => {
    const recipe = sampleRecipe();
    const unpublished = { ...recipe, workflowId: null, sourceSha: null, runner: { ...recipe.runner, ...identity } };
    expect(stagingSecurityWorkflowRecipe(unpublished).runner).toEqual(unpublished.runner);
    expect(stagingSecuritySourceRecipe(unpublished).runner).toEqual({ group: recipe.runner.group, label: recipe.runner.label });
    expect(renderStagingSecurityWorkflow(unpublished)).toBe(renderStagingSecurityWorkflow(recipe));
  });

  it.each([
    { runnerId: 501 }, { runnerGroupId: 12 }, { runnerId: undefined, runnerGroupId: 12 },
    { runnerId: '501', runnerGroupId: 12 }, { runnerId: 0, runnerGroupId: 12 },
    { runnerId: null, runnerGroupId: undefined }, { runnerId: null, runnerGroupId: '12' },
    { runnerId: null, runnerGroupId: 0 }, { runnerId: null, runnerGroupId: Number.MAX_SAFE_INTEGER + 1 },
    { runnerId: 501.5, runnerGroupId: 12 }
  ])('rejects malformed or unpaired explicit source runner identities %j', (identity) => {
    const recipe = sampleRecipe();
    const unpublished = { ...recipe, workflowId: null, sourceSha: null,
      runner: { group: recipe.runner.group, label: recipe.runner.label, ...identity } };
    expect(() => stagingSecurityWorkflowRecipe(unpublished)).toThrow();
    expect(() => renderStagingSecurityWorkflow(unpublished as StagingSecurityWorkflowRecipe)).toThrow();
  });

  it('requires an assigned group and an explicit optional pin for published dispatch', () => {
    const recipe = sampleRecipe();
    for (const runner of [
      { group: recipe.runner.group, label: recipe.runner.label },
      { ...recipe.runner, runnerId: null, runnerGroupId: null }
    ]) {
      expect(() => stagingSecurityWorkflowDispatchInputs({ ...recipe, runner })).toThrow();
    }
    expect(stagingSecurityWorkflowDispatchInputs({
      ...recipe, authority: { ...recipe.authority, allowedNetworkTargets: [...recipe.authority.allowedNetworkTargets].reverse() }
    })).toEqual(stagingSecurityWorkflowDispatchInputs(recipe));
  });

  it('exposes integration constants, runtime prerequisites, and documented limitations', () => {
    expect(stagingSecurityWorkflowIntegration.qualificationPhase).toBe('staging-qualified');
    expect(stagingSecurityWorkflowRuntimePrerequisites.length).toBeGreaterThan(5);
    expect(stagingSecurityWorkflowLimitations.length).toBeGreaterThan(5);
    expect(stagingSecurityWorkflowLimitations.some(l => l.includes('ZAP'))).toBe(true);
    expect(stagingSecurityWorkflowLimitations.some(l => l.includes('Trivy'))).toBe(true);
  });
});

describe('Scanner Real JSON Parsers', () => {
  it('parses real Trivy JSON with zero vulnerabilities as passed', () => {
    const cleanTrivy = JSON.stringify({
      SchemaVersion: 2,
      ArtifactName: 'crliftoff.azurecr.io/liftoff/app@sha256:' + 'a'.repeat(64),
      ArtifactType: 'container_image',
      Results: [
        {
          Target: 'alpine (3.19.1)',
          Class: 'os-pkgs',
          Type: 'alpine',
          Vulnerabilities: []
        }
      ]
    });

    const parsed = parseTrivyScanOutput(cleanTrivy, ['CRITICAL', 'HIGH']);
    expect(parsed.status).toBe('passed');
    expect(parsed.findings).toHaveLength(0);
    expect(parsed.findingsCount.critical).toBe(0);
    expect(parsed.findingsCount.high).toBe(0);
  });

  it('parses real Trivy JSON with High/Critical findings as policy_violation', () => {
    const vulnTrivy = JSON.stringify({
      SchemaVersion: 2,
      ArtifactName: 'crliftoff.azurecr.io/liftoff/app@sha256:' + 'a'.repeat(64),
      ArtifactType: 'container_image',
      Results: [
        {
          Target: 'alpine (3.19.1)',
          Class: 'os-pkgs',
          Type: 'alpine',
          Vulnerabilities: [
            {
              VulnerabilityID: 'CVE-2024-1234',
              PkgName: 'libssl3',
              InstalledVersion: '3.1.4-r0',
              FixedVersion: '3.1.5-r0',
              Severity: 'HIGH',
              Title: 'OpenSSL buffer overflow',
              PrimaryURL: 'https://avd.aquasec.com/nvd/cve-2024-1234'
            },
            {
              VulnerabilityID: 'CVE-2024-5678',
              PkgName: 'curl',
              InstalledVersion: '8.5.0-r0',
              Severity: 'LOW'
            }
          ]
        }
      ]
    });

    const parsed = parseTrivyScanOutput(vulnTrivy, ['CRITICAL', 'HIGH']);
    expect(parsed.status).toBe('policy_violation');
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.findingsCount.high).toBe(1);
    expect(parsed.findingsCount.low).toBe(1);
    expect(parsed.findings[0].vulnerabilityId).toBe('CVE-2024-1234');
    expect(parsed.findings[0].fixedVersion).toBe('3.1.5-r0');
  });

  it('rejects malformed Trivy JSON and missing SchemaVersion fail-closed', () => {
    expect(() => parseTrivyScanOutput('not-json')).toThrow(/not valid JSON/);
    expect(() => parseTrivyScanOutput(JSON.stringify({ Results: [] }))).toThrow(/SchemaVersion/);
    expect(() => parseTrivyScanOutput(JSON.stringify({ SchemaVersion: 2, ArtifactType: 'container_image', ArtifactName: 'image' }))).toThrow(/Results array/);
  });

  it('parses real OWASP ZAP baseline JSON with zero alerts as passed', () => {
    const fqdn = 'staging-app.nicecliff-1234.eastus.azurecontainerapps.io';
    const cleanZap = JSON.stringify({
      '@programName': 'ZAP',
      '@version': '2.14.0',
      site: [
        {
          '@name': `https://${fqdn}`,
          '@host': fqdn,
          '@port': '443', '@ssl': 'true',
          alerts: []
        }
      ]
    });

    const parsed = parseZapScanOutput(cleanZap, fqdn, ['HIGH', 'MEDIUM']);
    expect(parsed.status).toBe('passed');
    expect(parsed.alerts).toHaveLength(0);
  });

  it('parses real OWASP ZAP baseline JSON with Medium/High alerts as policy_violation', () => {
    const fqdn = 'staging-app.nicecliff-1234.eastus.azurecontainerapps.io';
    const vulnZap = JSON.stringify({
      '@programName': 'ZAP',
      '@version': '2.14.0',
      site: [
        {
          '@name': `https://${fqdn}`,
          '@host': fqdn,
          '@port': '443', '@ssl': 'true',
          alerts: [
            {
              pluginid: '10038',
              alert: 'Content Security Policy (CSP) Header Not Set',
              riskcode: '2',
              riskdesc: 'Medium (High)',
              instances: [
                { uri: `https://${fqdn}/health`, method: 'GET' }
              ]
            }
          ]
        }
      ]
    });

    const parsed = parseZapScanOutput(vulnZap, fqdn, ['HIGH', 'MEDIUM']);
    expect(parsed.status).toBe('policy_violation');
    expect(parsed.alerts).toHaveLength(1);
    expect(parsed.alertsCount.medium).toBe(1);
    expect(parsed.alerts[0].pluginId).toBe('10038');
    expect(parsed.alerts[0].risk).toBe('MEDIUM');
  });

  it('rejects ZAP report if site host does not match the approved staging target', () => {
    const fqdn = 'staging-app.nicecliff-1234.eastus.azurecontainerapps.io';
    const foreignZap = JSON.stringify({
      '@programName': 'ZAP',
      '@version': '2.14.0',
      site: [
        {
          '@name': 'https://evil.example.com',
          '@host': 'evil.example.com',
          alerts: []
        }
      ]
    });

    expect(() => parseZapScanOutput(foreignZap, fqdn)).toThrow(/host mismatch/);
  });
});

describe('Archive Reading & Report Admission Verification', () => {
  it('reads bounded staging security report from single-file ZIP archive', () => {
    const reportData = {
      schemaVersion: 1,
      kind: 'liftoff-staging-security',
      observed: true
    };
    const zip = makeZip(stagingSecurityWorkflowReportFile, Buffer.from(JSON.stringify(reportData) + '\n'));
    const extracted = readStagingSecurityArchive(zip);
    expect(JSON.parse(extracted.toString('utf8'))).toEqual(reportData);

    const sharedExtracted = extractPrivateReportArchive(zip, stagingSecurityWorkflowReportFile);
    expect(sharedExtracted.equals(extracted)).toBe(true);
  });

  it('validates a complete, authentic report against reviewed workflow, runner and observation bindings', () => {
    const recipe = sampleRecipe();
    const correlationId = randomUUID();
    const now = new Date('2026-09-16T05:00:00.000Z');
    const startedAt = '2026-09-16T04:55:00.000Z';
    const observedAt = '2026-09-16T04:58:00.000Z';
    const completedAt = '2026-09-16T04:59:00.000Z';

    const dispatchInputs = stagingSecurityWorkflowDispatchInputs(recipe);

    const report = {
      schemaVersion: 1,
      kind: 'liftoff-staging-security',
      correlationId,
      configurationDigest: dispatchInputs.qualification_digest,
      recipeDigest: canonicalSha256(stagingSecuritySourceRecipe(recipe)),
      source: {
        repository: recipe.repository,
        repositoryId: recipe.repositoryId,
        commitSha: recipe.sourceSha,
        ref: recipe.ref
      },
      producer: {
        workflowId: recipe.workflowId,
        workflowPath: recipe.workflowPath,
        workflowDigest: canonicalSha256(renderStagingSecurityWorkflow(recipe)),
        runId: 9001,
        runAttempt: 1,
        actorId: recipe.actorId,
        jobId: 888,
        runnerId: recipe.runner.runnerId,
        runnerGroupId: recipe.runner.runnerGroupId
      },
      target: {
        environment: 'staging',
        resourceId: recipe.target.resourceId,
        fqdn: recipe.target.fqdn,
        imageDigest: recipe.image.digest
      },
      prerequisites: {
        health: {
          path: recipe.target.healthPath,
          status: 200,
          mediaType: 'application/json',
          bodyDigest: 'c'.repeat(64),
          statusValue: 'ok'
        },
        schema: {
          path: recipe.target.schemaPath,
          status: 200,
          mediaType: 'application/json',
          bodyDigest: 'd'.repeat(64),
          openapi: '3.1.0',
          paths: ['/health', '/openapi.json', '/api/v1/quote']
        },
        reachabilityVerified: true
        , privateAccess: null
      },
      scans: {
        supplyChain: {
          tool: {
            name: recipe.tools.containerScanner.name,
            version: recipe.tools.containerScanner.version, binarySha256: recipe.tools.containerScanner.expectedSha256
          },
          target: `${recipe.image.loginServer}/${recipe.image.repository}@${recipe.image.digest}`,
          status: 'passed',
          exitCode: 0,
          reportDigest: 'e'.repeat(64),
          findingsCount: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
          findings: []
        },
        dast: {
          tool: {
            name: recipe.tools.dastScanner.name,
            version: recipe.tools.dastScanner.version, binarySha256: recipe.tools.dastScanner.expectedSha256
          },
          target: `https://${recipe.target.fqdn}`,
          status: 'passed',
          exitCode: 0,
          reportDigest: 'f'.repeat(64),
          alertsCount: { high: 0, medium: 0, low: 0, info: 0 },
          alerts: []
        }
      },
      overallStatus: 'passed',
      observedAt
    };

    const reportBytes = Buffer.from(JSON.stringify(report) + '\n', 'utf8');

    const workflowBinding = {
      repository: recipe.repository,
      repositoryId: recipe.repositoryId,
      workflowPath: recipe.workflowPath,
      workflowId: 101,
      workflowDigest: canonicalSha256(renderStagingSecurityWorkflow(recipe)),
      sourceSha: validSourceSha,
      ref: recipe.ref,
      actorId: recipe.actorId,
      event: 'workflow_dispatch' as const,
      expectedJobs: [stagingSecurityWorkflowJob],
      runAttempt: 1
    };

    const steps = ['Prepare private scanner authentication', 'Authenticate exact read-only scanner identity',
      'Execute staging security and DAST observation', 'Retain bounded staging security and DAST report']
      .map((name, index) => ({ name, number: index + 1, status: 'completed', conclusion: 'success' }));
    const observation = {
      runId: 9001,
      correlationId,
      configurationDigest: dispatchInputs.qualification_digest,
      job: {
        id: 888,
        name: stagingSecurityWorkflowJob,
        conclusion: 'success',
        steps
      },
      providerJob: {
        id: 888,
        name: stagingSecurityWorkflowJob,
        status: 'completed',
        conclusion: 'success',
        runner_id: recipe.runner.runnerId,
        runner_group_id: recipe.runner.runnerGroupId,
        labels: [recipe.runner.label],
        started_at: startedAt,
        completed_at: completedAt
        , steps
      },
      now
    };

    const verified = validateStagingSecurityReport(reportBytes, recipe, workflowBinding, observation);
    expect(verified.policyPassed).toBe(true);
    expect(verified.report.overallStatus).toBe('passed');
    assertStagingSecurityReportPassed(verified);
  });

  it('rejects reports when policy findings violate threshold or prerequisites failed', () => {
    const verifiedFailed = {
      report: { overallStatus: 'policy_violation' } as any,
      reportDigest: 'sha256:' + '0'.repeat(64),
      policyPassed: false
    };
    expect(() => assertStagingSecurityReportPassed(verifiedFailed)).toThrow(/policy thresholds/);

    const verifiedPrereq = {
      report: { overallStatus: 'prerequisite_failed' } as any,
      reportDigest: 'sha256:' + '0'.repeat(64),
      policyPassed: false
    };
    expect(() => assertStagingSecurityReportPassed(verifiedPrereq)).toThrow(/prerequisite reachability/);
  });
});

describe('Real Program Execution with Supervised Mock Tool Fixtures', () => {
  async function setupFixtureHarness(options: {
    trivyMode?: 'clean' | 'vuln' | 'malformed' | 'crash';
    zapMode?: 'clean' | 'alert' | 'wrong-host' | 'crash';
    healthStatus?: 'ok' | 'fail';
    schemaValid?: boolean;
    runnerPin?: number | null;
    observedRunnerId?: number;
    observedRunnerGroupId?: number;
  } = {}) {
    const directory = join(process.cwd(), 'tests', `.staging-security-${randomUUID()}`);
    await mkdir(directory, { mode: 0o700 });
    const temp = await realpath(directory);
    cleanupDirs.push(temp);

    const recipe = sampleRecipe();
    if (options.runnerPin !== undefined) recipe.runner.runnerId = options.runnerPin;
    const correlationId = randomUUID();

    // Create executable mock tool fixtures in temp directory
    const mockTrivy = join(temp, 'mock-trivy.mjs');
    const mockZap = join(temp, 'mock-zap.mjs');
    const mockAz = join(temp, 'mock-az.mjs');

    const trivyScript = `#!${process.execPath}
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('Version: ${recipe.tools.containerScanner.version}\\n');
  process.exit(0);
}

const mode = '${options.trivyMode || 'clean'}';
if (mode === 'crash') process.exit(9);
if (mode === 'malformed') {
  const outIdx = args.indexOf('--output');
  if (outIdx >= 0) writeFileSync(args[outIdx + 1], '{"malformed":');
  else process.stdout.write('{"malformed":');
  process.exit(0);
}

const payload = mode === 'vuln' ? {
  SchemaVersion: 2,
  ArtifactName: '${recipe.image.loginServer}/${recipe.image.repository}@${recipe.image.digest}',
  ArtifactType: 'container_image',
  Results: [{
    Target: 'alpine (3.19.1)',
    Vulnerabilities: [{
      VulnerabilityID: 'CVE-2024-9999',
      PkgName: 'openssl',
      InstalledVersion: '3.1.4',
      Severity: 'HIGH',
      Title: 'Critical memory flaw'
    }]
  }]
} : {
  SchemaVersion: 2,
  ArtifactName: '${recipe.image.loginServer}/${recipe.image.repository}@${recipe.image.digest}',
  ArtifactType: 'container_image',
  Results: [{ Target: 'alpine (3.19.1)', Vulnerabilities: [] }]
};

const outIdx = args.indexOf('--output');
if (outIdx >= 0) writeFileSync(args[outIdx + 1], JSON.stringify(payload));
else process.stdout.write(JSON.stringify(payload));
process.exit(0);
`;

    const zapScript = `#!${process.execPath}
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('zap ${recipe.tools.dastScanner.version}\\n');
  process.exit(0);
}

const mode = '${options.zapMode || 'clean'}';
if (mode === 'crash') process.exit(8);

const host = mode === 'wrong-host' ? 'unapproved.example.com' : '${recipe.target.fqdn}';
const payload = mode === 'alert' ? {
  '@programName': 'ZAP',
  '@version': '${recipe.tools.dastScanner.version}',
  site: [{
    '@name': 'https://' + host,
    '@host': host,
    '@port': '443', '@ssl': 'true',
    alerts: [{
      pluginid: '10040',
      alert: 'Insecure Direct Object Reference',
      riskcode: '3',
      riskdesc: 'High',
      instances: [{ uri: 'https://' + host + '/api/v1/quote' }]
    }]
  }]
} : {
  '@programName': 'ZAP',
  '@version': '${recipe.tools.dastScanner.version}',
  site: [{
    '@name': 'https://' + host,
    '@host': host,
    '@port': '443', '@ssl': 'true',
    alerts: []
  }]
};

const jIdx = args.indexOf('-J');
if (jIdx >= 0) writeFileSync(args[jIdx + 1], JSON.stringify(payload));
else process.stdout.write(JSON.stringify(payload));
process.exit(0);
`;

    await writeFile(mockTrivy, trivyScript);
    await chmod(mockTrivy, 0o755);
    await writeFile(mockZap, zapScript);
    await chmod(mockZap, 0o755);

    recipe.tools.containerScanner.executable = mockTrivy;
    recipe.tools.dastScanner.executable = mockZap;
    recipe.tools.containerScanner.expectedSha256 = 'sha256:' + createHash('sha256').update(trivyScript).digest('hex');
    recipe.tools.dastScanner.expectedSha256 = 'sha256:' + createHash('sha256').update(zapScript).digest('hex');
    const token = `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + 3600, tid: recipe.azure.tenantId, oid: recipe.azure.principalId,
      appid: recipe.azure.clientId, aud: 'https://management.azure.com/'
    })).toString('base64url')}.SYNTHETIC`;
    const azScript = `#!${process.execPath}\nconst value=process.argv[2]==='version'?{'azure-cli':'${recipe.tools.azureCli.version}'}:${JSON.stringify({
      subscription: recipe.azure.subscriptionId, tenant: recipe.azure.tenantId, accessToken: token
    })};process.stdout.write(JSON.stringify(value));\n`;
    await writeFile(mockAz, azScript, { mode: 0o700 });
    recipe.tools.azureCli.executable = mockAz;
    recipe.tools.azureCli.expectedSha256 = 'sha256:' + createHash('sha256').update(azScript).digest('hex');
    const databaseDirectory = join(temp, 'preloaded-db');
    await mkdir(join(databaseDirectory, 'db'), { recursive: true, mode: 0o700 });
    const database = Buffer.from('ISOLATED_DATABASE_FIXTURE_NOT_LIVE_QUALIFICATION');
    const metadata = Buffer.from(JSON.stringify({ Version: 2, UpdatedAt: new Date(Date.now() - 3600000).toISOString(),
      NextUpdate: new Date(Date.now() + 3600000).toISOString() }));
    await writeFile(join(databaseDirectory, 'db', 'trivy.db'), database);
    await writeFile(join(databaseDirectory, 'db', 'metadata.json'), metadata);
    recipe.database = { cacheDirectory: databaseDirectory, databaseSha256: createHash('sha256').update(database).digest('hex'),
      metadataSha256: createHash('sha256').update(metadata).digest('hex'), maxAgeHours: 24 };
    const dispatchInputs = stagingSecurityWorkflowDispatchInputs(recipe);
    await mkdir(join(temp, `liftoff-staging-azure-${correlationId}`), { mode: 0o700 });

    // Local HTTP server serving GitHub REST and Container App HTTPS endpoints
    const requests: string[] = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      res.setHeader('Content-Type', 'application/json');

      const targetHost = req.headers['x-liftoff-test-host'];
      requests.push(`${targetHost}${req.url}`);
      if (targetHost === 'api.github.com') {
        if (url.pathname.endsWith('/jobs')) {
          res.end(JSON.stringify({
            total_count: 1,
            jobs: [{
              id: 777,
              name: stagingSecurityWorkflowJob,
              run_id: 12345, head_sha: recipe.sourceSha,
              runner_id: options.observedRunnerId ?? 501,
              runner_group_id: options.observedRunnerGroupId ?? recipe.runner.runnerGroupId,
              labels: [recipe.runner.label]
            }]
          }));
        } else if (url.pathname.includes('/contents/')) {
          const content = renderStagingSecurityWorkflow(recipe);
          res.end(JSON.stringify({
            type: 'file', path: recipe.workflowPath, encoding: 'base64', content: Buffer.from(content).toString('base64'),
            size: Buffer.byteLength(content), sha: createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0${content}`).digest('hex')
          }));
        } else {
          res.end(JSON.stringify({
            id: 12345,
            workflow_id: recipe.workflowId,
            path: recipe.workflowPath,
            actor: { id: recipe.actorId }, triggering_actor: { id: recipe.actorId },
            run_attempt: 1, head_sha: recipe.sourceSha, head_branch: recipe.ref, event: 'workflow_dispatch',
            repository: { id: recipe.repositoryId, full_name: recipe.repository }, display_title: `liftoff-${correlationId}`
          }));
        }
        return;
      }
      if (targetHost === recipe.image.loginServer && req.method === 'POST') {
        res.end(JSON.stringify(url.pathname === '/oauth2/exchange'
          ? { refresh_token: 'SYNTHETIC_READ_REFRESH' } : { access_token: 'SYNTHETIC_SCOPED_PULL' }));
        return;
      }

      if (targetHost === recipe.target.fqdn) {
        if (url.pathname === recipe.target.healthPath) {
          if (options.healthStatus === 'fail') {
            res.statusCode = 500;
            res.end('{"status": "error"}');
          } else {
            res.end('{"status": "ok"}');
          }
          return;
        }

        if (url.pathname === recipe.target.schemaPath) {
          if (options.schemaValid === false) {
            res.end('{"openapi": "invalid"}');
          } else {
            res.end(JSON.stringify({
              openapi: '3.1.0',
              info: { title: 'Staging API', version: '1.0.0' },
              paths: { '/api/v1/quote': { get: { responses: { '200': { description: 'ok' } } } } }
            }));
          }
          return;
        }
      }

      res.statusCode = 404;
      res.end('{}');
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    cleanupServers.push(server);

    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server address failed');
    const port = address.port;

    const environment = () => ({
      PATH: process.env.PATH, RUNNER_TEMP: temp,
      AZURE_CONFIG_DIR: join(temp, `liftoff-staging-azure-${correlationId}`),
      LIFTOFF_STAGING_SECURITY_RECIPE: JSON.stringify(stagingSecuritySourceRecipe(recipe)),
      LIFTOFF_CORRELATION_ID: correlationId, LIFTOFF_CONFIGURATION_DIGEST: stagingSecurityWorkflowDispatchInputs(recipe).qualification_digest,
      LIFTOFF_RECIPE_DIGEST: canonicalSha256(stagingSecuritySourceRecipe(recipe)),
      LIFTOFF_EXECUTION_SOURCE_SHA: validSourceSha, LIFTOFF_WORKFLOW_ID: '101',
      LIFTOFF_IMAGE_DIGEST: recipe.image.digest, LIFTOFF_TARGET_FQDN: recipe.target.fqdn,
      LIFTOFF_TARGET_PRIVATE_IP: recipe.target.privateIp ?? 'none',
      LIFTOFF_DATABASE_DIGEST: recipe.database.databaseSha256, LIFTOFF_DATABASE_METADATA_DIGEST: recipe.database.metadataSha256,
      LIFTOFF_RUNNER_GROUP_ID: String(recipe.runner.runnerGroupId),
      LIFTOFF_RUNNER_ID: recipe.runner.runnerId === null ? 'none' : String(recipe.runner.runnerId),
      GH_TOKEN: 'ghp_secret_private_token', GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '1',
      GITHUB_REPOSITORY: recipe.repository, GITHUB_REPOSITORY_ID: String(recipe.repositoryId),
      GITHUB_SHA: validSourceSha, GITHUB_WORKFLOW_SHA: validSourceSha, GITHUB_REF: `refs/heads/${recipe.ref}`,
      GITHUB_ACTOR_ID: String(recipe.actorId), GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_WORKFLOW_REF: `${recipe.repository}/${recipe.workflowPath}@refs/heads/${recipe.ref}`
    });
    return { temp, recipe, correlationId, dispatchInputs, port, environment, requests };
  }

  async function runFixtureProgram(
    fixture: Awaited<ReturnType<typeof setupFixtureHarness>>, overrides: NodeJS.ProcessEnv = {}
  ) {
    const preload = `
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input), headers = new Headers(init?.headers);
  headers.set('x-liftoff-test-host', url.hostname);
  return originalFetch('http://127.0.0.1:${fixture.port}' + url.pathname + url.search, { ...init, headers });
};`;
    const child = spawn(process.execPath, ['--input-type=module'], {
      cwd: fixture.temp, env: { ...fixture.environment(), ...overrides }, stdio: ['pipe', 'pipe', 'pipe']
    });
    child.stdout.resume();
    let stderr = '';
    child.stderr.on('data', (bytes) => { stderr += bytes.toString(); });
    child.stdin.end(preload + '\n' + stagingSecurityWorkflowProgram);
    const [code] = await once(child, 'close');
    return { code, stderr };
  }

  it.each([
    { runnerPin: null, observedRunnerId: 1900, observedRunnerGroupId: 12, passes: true },
    { runnerPin: 501, observedRunnerId: 1900, observedRunnerGroupId: 12, passes: false },
    { runnerPin: null, observedRunnerId: 1900, observedRunnerGroupId: 13, passes: false },
    { runnerPin: null, observedRunnerId: 0, observedRunnerGroupId: 12, passes: false }
  ])('binds the approved runner pin/group to the actual provider job: %j', async ({ passes, ...options }) => {
    const fixture = await setupFixtureHarness(options);
    const result = await runFixtureProgram(fixture);
    if (passes) {
      expect(result.code, result.stderr).toBe(0);
      const report = parseStagingSecurityReport(await readFile(join(fixture.temp, stagingSecurityWorkflowReportFile)));
      expect(report.producer).toMatchObject({ runnerId: 1900, runnerGroupId: 12 });
    } else {
      expect(result.code).not.toBe(0);
      expect(fixture.requests.some((request) => request.startsWith(fixture.recipe.target.fqdn))).toBe(false);
      await expect(readFile(join(fixture.temp, stagingSecurityWorkflowReportFile))).rejects.toThrow();
    }
  });

  it.each([
    ['LIFTOFF_RUNNER_GROUP_ID', undefined], ['LIFTOFF_RUNNER_GROUP_ID', 'none'],
    ['LIFTOFF_RUNNER_GROUP_ID', '0'], ['LIFTOFF_RUNNER_GROUP_ID', '012'],
    ['LIFTOFF_RUNNER_GROUP_ID', '9007199254740992'], ['LIFTOFF_RUNNER_GROUP_ID', '13'],
    ['LIFTOFF_RUNNER_ID', undefined], ['LIFTOFF_RUNNER_ID', 'null'],
    ['LIFTOFF_RUNNER_ID', '0'], ['LIFTOFF_RUNNER_ID', '1.5'], ['LIFTOFF_RUNNER_ID', 'none'],
    ['LIFTOFF_CONFIGURATION_DIGEST', 'a'.repeat(64)], ['LIFTOFF_RECIPE_DIGEST', 'a'.repeat(64)]
  ])('rejects missing, malformed or unapproved %s=%s before provider work', async (name, value) => {
    const fixture = await setupFixtureHarness();
    const result = await runFixtureProgram(fixture, { [name!]: value });
    expect(result.code).not.toBe(0);
    expect(fixture.requests).toEqual([]);
    await expect(readFile(join(fixture.temp, stagingSecurityWorkflowReportFile))).rejects.toThrow();
  });

  it('does not accept embedded runtime runner identities even with a matching claimed source digest', async () => {
    const fixture = await setupFixtureHarness();
    const source = { ...stagingSecuritySourceRecipe(fixture.recipe), runner: fixture.recipe.runner };
    const result = await runFixtureProgram(fixture, {
      LIFTOFF_STAGING_SECURITY_RECIPE: JSON.stringify(source), LIFTOFF_RECIPE_DIGEST: canonicalSha256(source)
    });
    expect(result.code).not.toBe(0);
    expect(fixture.requests).toEqual([]);
  });

  it('executes actual program end-to-end and produces verified passed report', async () => {
    const { temp, recipe, correlationId, dispatchInputs, port, environment } = await setupFixtureHarness({
      trivyMode: 'clean',
      zapMode: 'clean'
    });

    const preload = `
const origFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input);
  const rewritten = new URL('http://127.0.0.1:${port}' + url.pathname + url.search);
  const headers = new Headers(init?.headers);
  headers.set('x-liftoff-test-host', url.hostname);
  return origFetch(rewritten, { ...init, headers });
};
`;

    const fullScript = preload + '\n' + stagingSecurityWorkflowProgram;

    const child = spawn(process.execPath, ['--input-type=module'], {
      cwd: temp,
      env: {
        ...process.env,
        LIFTOFF_STAGING_SECURITY_RECIPE: JSON.stringify(recipe),
        LIFTOFF_CORRELATION_ID: correlationId,
        LIFTOFF_CONFIGURATION_DIGEST: dispatchInputs.qualification_digest,
        LIFTOFF_RECIPE_DIGEST: canonicalSha256(recipe),
        LIFTOFF_TIMEOUT_MINUTES: '5',
        GH_TOKEN: 'ghp_secret_private_token',
        GITHUB_RUN_ID: '12345',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_REPOSITORY: recipe.repository,
        GITHUB_REPOSITORY_ID: String(recipe.repositoryId),
        GITHUB_SHA: recipe.sourceSha,
        GITHUB_REF: recipe.ref,
        ...environment()
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let errOutput = '';
    child.stderr.on('data', chunk => { errOutput += chunk.toString(); });

    child.stdin.write(fullScript);
    child.stdin.end();

    const [code] = await once(child, 'close');
    expect(code).toBe(0);

    const reportFile = join(temp, stagingSecurityWorkflowReportFile);
    const reportStat = await lstat(reportFile);
    expect(reportStat.isFile()).toBe(true);
    expect(reportStat.mode & 0o777).toBe(0o600);

    const reportBytes = await readFile(reportFile);
    const report = parseStagingSecurityReport(reportBytes);
    expect(report.overallStatus).toBe('passed');
    expect(report.scans.supplyChain.status).toBe('passed');
    expect(report.scans.dast.status).toBe('passed');
  });

  it('executes actual program and correctly records policy_violation when tool finds vulnerabilities', async () => {
    const { temp, recipe, correlationId, dispatchInputs, port, environment } = await setupFixtureHarness({
      trivyMode: 'vuln',
      zapMode: 'clean'
    });

    const preload = `
const origFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input);
  const rewritten = new URL('http://127.0.0.1:${port}' + url.pathname + url.search);
  const headers = new Headers(init?.headers);
  headers.set('x-liftoff-test-host', url.hostname);
  return origFetch(rewritten, { ...init, headers });
};
`;

    const fullScript = preload + '\n' + stagingSecurityWorkflowProgram;

    const child = spawn(process.execPath, ['--input-type=module'], {
      cwd: temp,
      env: {
        ...process.env,
        LIFTOFF_STAGING_SECURITY_RECIPE: JSON.stringify(recipe),
        LIFTOFF_CORRELATION_ID: correlationId,
        LIFTOFF_CONFIGURATION_DIGEST: dispatchInputs.qualification_digest,
        LIFTOFF_RECIPE_DIGEST: canonicalSha256(recipe),
        LIFTOFF_TIMEOUT_MINUTES: '5',
        GH_TOKEN: 'ghp_secret_private_token',
        GITHUB_RUN_ID: '12345',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_REPOSITORY: recipe.repository,
        GITHUB_REPOSITORY_ID: String(recipe.repositoryId),
        GITHUB_SHA: recipe.sourceSha,
        GITHUB_REF: recipe.ref,
        ...environment()
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    child.stdin.write(fullScript);
    child.stdin.end();

    const [code] = await once(child, 'close');
    expect(code).toBe(2);

    const reportFile = join(temp, stagingSecurityWorkflowReportFile);
    const reportBytes = await readFile(reportFile);
    const report = parseStagingSecurityReport(reportBytes);
    expect(report.overallStatus).toBe('policy_violation');
    expect(report.scans.supplyChain.status).toBe('policy_violation');
    expect(report.scans.supplyChain.findings[0].vulnerabilityId).toBe('CVE-2024-9999');
  });

  it('fails closed and produces no report when health check fails', async () => {
    const { temp, recipe, correlationId, dispatchInputs, port, environment } = await setupFixtureHarness({
      healthStatus: 'fail'
    });

    const preload = `
const origFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input);
  const rewritten = new URL('http://127.0.0.1:${port}' + url.pathname + url.search);
  const headers = new Headers(init?.headers);
  headers.set('x-liftoff-test-host', url.hostname);
  return origFetch(rewritten, { ...init, headers });
};
`;

    const fullScript = preload + '\n' + stagingSecurityWorkflowProgram;

    const child = spawn(process.execPath, ['--input-type=module'], {
      cwd: temp,
      env: {
        ...process.env,
        LIFTOFF_STAGING_SECURITY_RECIPE: JSON.stringify(recipe),
        LIFTOFF_CORRELATION_ID: correlationId,
        LIFTOFF_CONFIGURATION_DIGEST: dispatchInputs.qualification_digest,
        LIFTOFF_RECIPE_DIGEST: canonicalSha256(recipe),
        LIFTOFF_TIMEOUT_MINUTES: '5',
        GH_TOKEN: 'ghp_secret_private_token',
        GITHUB_RUN_ID: '12345',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_REPOSITORY: recipe.repository,
        GITHUB_REPOSITORY_ID: String(recipe.repositoryId),
        GITHUB_SHA: recipe.sourceSha,
        GITHUB_REF: recipe.ref,
        ...environment()
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    child.stdin.write(fullScript);
    child.stdin.end();

    const [code] = await once(child, 'close');
    expect(code).not.toBe(0);

    // Verify report was NOT produced
    await expect(readFile(join(temp, stagingSecurityWorkflowReportFile))).rejects.toThrow();
  });

  it('fails closed when scanner tool returns malformed JSON output', async () => {
    const { temp, recipe, correlationId, dispatchInputs, port, environment } = await setupFixtureHarness({
      trivyMode: 'malformed'
    });

    const preload = `
const origFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input);
  const rewritten = new URL('http://127.0.0.1:${port}' + url.pathname + url.search);
  const headers = new Headers(init?.headers);
  headers.set('x-liftoff-test-host', url.hostname);
  return origFetch(rewritten, { ...init, headers });
};
`;

    const fullScript = preload + '\n' + stagingSecurityWorkflowProgram;

    const child = spawn(process.execPath, ['--input-type=module'], {
      cwd: temp,
      env: {
        ...process.env,
        LIFTOFF_STAGING_SECURITY_RECIPE: JSON.stringify(recipe),
        LIFTOFF_CORRELATION_ID: correlationId,
        LIFTOFF_CONFIGURATION_DIGEST: dispatchInputs.qualification_digest,
        LIFTOFF_RECIPE_DIGEST: canonicalSha256(recipe),
        LIFTOFF_TIMEOUT_MINUTES: '5',
        GH_TOKEN: 'ghp_secret_private_token',
        GITHUB_RUN_ID: '12345',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_REPOSITORY: recipe.repository,
        GITHUB_REPOSITORY_ID: String(recipe.repositoryId),
        GITHUB_SHA: recipe.sourceSha,
        GITHUB_REF: recipe.ref,
        ...environment()
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    child.stdin.write(fullScript);
    child.stdin.end();

    const [code] = await once(child, 'close');
    expect(code).not.toBe(0);
    await expect(readFile(join(temp, stagingSecurityWorkflowReportFile))).rejects.toThrow();
  });

  it('fails closed when DAST scanner reports on an unapproved foreign target', async () => {
    const { temp, recipe, correlationId, dispatchInputs, port, environment } = await setupFixtureHarness({
      zapMode: 'wrong-host'
    });

    const preload = `
const origFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input);
  const rewritten = new URL('http://127.0.0.1:${port}' + url.pathname + url.search);
  const headers = new Headers(init?.headers);
  headers.set('x-liftoff-test-host', url.hostname);
  return origFetch(rewritten, { ...init, headers });
};
`;

    const fullScript = preload + '\n' + stagingSecurityWorkflowProgram;

    const child = spawn(process.execPath, ['--input-type=module'], {
      cwd: temp,
      env: {
        ...process.env,
        LIFTOFF_STAGING_SECURITY_RECIPE: JSON.stringify(recipe),
        LIFTOFF_CORRELATION_ID: correlationId,
        LIFTOFF_CONFIGURATION_DIGEST: dispatchInputs.qualification_digest,
        LIFTOFF_RECIPE_DIGEST: canonicalSha256(recipe),
        LIFTOFF_TIMEOUT_MINUTES: '5',
        GH_TOKEN: 'ghp_secret_private_token',
        GITHUB_RUN_ID: '12345',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_REPOSITORY: recipe.repository,
        GITHUB_REPOSITORY_ID: String(recipe.repositoryId),
        GITHUB_SHA: recipe.sourceSha,
        GITHUB_REF: recipe.ref,
        ...environment()
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    child.stdin.write(fullScript);
    child.stdin.end();

    const [code] = await once(child, 'close');
    expect(code).not.toBe(0);
    await expect(readFile(join(temp, stagingSecurityWorkflowReportFile))).rejects.toThrow();
  });

  it('guarantees GH_TOKEN privacy: token is never leaked in argv or child process environment', async () => {
    const { temp, recipe, correlationId, dispatchInputs, port, environment } = await setupFixtureHarness({
      trivyMode: 'clean',
      zapMode: 'clean'
    });

    // Instrument mock-trivy to dump its received environment and argv
    const auditFile = join(temp, 'security-audit.json');
    const instrumentedTrivy = `#!${process.execPath}
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('Version: ${recipe.tools.containerScanner.version}\\n');
  process.exit(0);
}

writeFileSync('${auditFile}', JSON.stringify({
  argv: process.argv,
  hasGhToken: 'GH_TOKEN' in process.env || 'GITHUB_TOKEN' in process.env,
  envKeys: Object.keys(process.env)
}));

const payload = {
  SchemaVersion: 2,
  ArtifactName: '${recipe.image.loginServer}/${recipe.image.repository}@${recipe.image.digest}',
  ArtifactType: 'container_image',
  Results: [{Target:'alpine (3.19.1)',Vulnerabilities:[]}]
};

const outIdx = args.indexOf('--output');
if (outIdx >= 0) writeFileSync(args[outIdx + 1], JSON.stringify(payload));
process.exit(0);
`;

    await writeFile(recipe.tools.containerScanner.executable, instrumentedTrivy);
    await chmod(recipe.tools.containerScanner.executable, 0o755);
    recipe.tools.containerScanner.expectedSha256 = 'sha256:' + createHash('sha256').update(instrumentedTrivy).digest('hex');

    const preload = `
const origFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input);
  const rewritten = new URL('http://127.0.0.1:${port}' + url.pathname + url.search);
  const headers = new Headers(init?.headers);
  headers.set('x-liftoff-test-host', url.hostname);
  return origFetch(rewritten, { ...init, headers });
};
`;

    const fullScript = preload + '\n' + stagingSecurityWorkflowProgram;

    const child = spawn(process.execPath, ['--input-type=module'], {
      cwd: temp,
      env: {
        ...process.env,
        LIFTOFF_STAGING_SECURITY_RECIPE: JSON.stringify(recipe),
        LIFTOFF_CORRELATION_ID: correlationId,
        LIFTOFF_CONFIGURATION_DIGEST: dispatchInputs.qualification_digest,
        LIFTOFF_RECIPE_DIGEST: canonicalSha256(recipe),
        LIFTOFF_TIMEOUT_MINUTES: '5',
        GH_TOKEN: 'ghp_secret_ultra_private_token',
        GITHUB_RUN_ID: '12345',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_REPOSITORY: recipe.repository,
        GITHUB_REPOSITORY_ID: String(recipe.repositoryId),
        GITHUB_SHA: recipe.sourceSha,
        GITHUB_REF: recipe.ref,
        ...environment()
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    child.stdin.write(fullScript);
    child.stdin.end();

    const [code] = await once(child, 'close');
    expect(code).toBe(0);

    const audit = JSON.parse(await readFile(auditFile, 'utf8'));
    expect(audit.hasGhToken).toBe(false);
    expect(audit.argv.join(' ')).not.toContain('ghp_secret_ultra_private_token');
    expect(audit.envKeys).not.toContain('GH_TOKEN');
    expect(audit.envKeys).not.toContain('GITHUB_TOKEN');
  });

  it('verifies tool binary digest pinning when expectedSha256 is supplied', async () => {
    const { temp, recipe, correlationId, dispatchInputs, port, environment } = await setupFixtureHarness({
      trivyMode: 'clean',
      zapMode: 'clean'
    });

    const binContent = await readFile(recipe.tools.containerScanner.executable);
    const actualDigest = createHash('sha256').update(binContent).digest('hex');

    // Case A: Correct expected digest succeeds
    recipe.tools.containerScanner.expectedSha256 = `sha256:${actualDigest}`;

    const preload = `
const origFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input);
  const rewritten = new URL('http://127.0.0.1:${port}' + url.pathname + url.search);
  const headers = new Headers(init?.headers);
  headers.set('x-liftoff-test-host', url.hostname);
  return origFetch(rewritten, { ...init, headers });
};
`;

    const fullScript = preload + '\n' + stagingSecurityWorkflowProgram;

    const child = spawn(process.execPath, ['--input-type=module'], {
      cwd: temp,
      env: {
        ...process.env,
        LIFTOFF_STAGING_SECURITY_RECIPE: JSON.stringify(recipe),
        LIFTOFF_CORRELATION_ID: correlationId,
        LIFTOFF_CONFIGURATION_DIGEST: dispatchInputs.qualification_digest,
        LIFTOFF_RECIPE_DIGEST: canonicalSha256(recipe),
        LIFTOFF_TIMEOUT_MINUTES: '5',
        GH_TOKEN: 'ghp_secret_private_token',
        GITHUB_RUN_ID: '12345',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_REPOSITORY: recipe.repository,
        GITHUB_REPOSITORY_ID: String(recipe.repositoryId),
        GITHUB_SHA: recipe.sourceSha,
        GITHUB_REF: recipe.ref,
        ...environment()
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    child.stdin.write(fullScript);
    child.stdin.end();

    const [code] = await once(child, 'close');
    expect(code).toBe(0);

    // Case B: Tampered digest fails closed
    recipe.tools.containerScanner.expectedSha256 = `sha256:${'0'.repeat(64)}`;
    const child2 = spawn(process.execPath, ['--input-type=module'], {
      cwd: temp,
      env: {
        ...process.env,
        LIFTOFF_STAGING_SECURITY_RECIPE: JSON.stringify(recipe),
        LIFTOFF_CORRELATION_ID: correlationId,
        LIFTOFF_CONFIGURATION_DIGEST: dispatchInputs.qualification_digest,
        LIFTOFF_RECIPE_DIGEST: canonicalSha256(recipe),
        LIFTOFF_TIMEOUT_MINUTES: '5',
        GH_TOKEN: 'ghp_secret_private_token',
        GITHUB_RUN_ID: '12345',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_REPOSITORY: recipe.repository,
        GITHUB_REPOSITORY_ID: String(recipe.repositoryId),
        GITHUB_SHA: recipe.sourceSha,
        GITHUB_REF: recipe.ref,
        ...environment()
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    child2.stdin.write(fullScript);
    child2.stdin.end();

    const [code2] = await once(child2, 'close');
    expect(code2).not.toBe(0);
  });
});
