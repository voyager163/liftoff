import { canonicalSha256 } from '../../src/domain/governance/activation/canonical-json.js';
import {
  renderStagingSecurityWorkflow, stagingSecuritySourceRecipe, stagingSecurityWorkflowJob,
  stagingSecurityWorkflowRecipeId, stagingSecurityWorkflowReportFile, stagingSecurityWorkflowStep,
  stagingSecurityWorkflowUploadStep, type PublishedStagingSecurityWorkflowRecipe, type StagingSecurityReport
} from '../../src/application/azure-activation/staging-security-workflow.js';
import { stagingSecurityWorkflowBinding } from '../../src/application/azure-activation/staging-security-artifact.js';
import { EnvironmentWorkflowProtocol, environmentReportZip } from './environment-qualification-fixture.js';

/** Raw provider fixtures only. Production staging still produces and reopens its own private witness. */
export function stagingProducerRecipe(input: {
  sourceSha: string; resourceId: string; fqdn: string; imageDigest: string;
  subscriptionId: string; tenantId: string; principalId: string;
}): PublishedStagingSecurityWorkflowRecipe {
  return {
    schemaVersion: 1, recipe: stagingSecurityWorkflowRecipeId,
    workflowPath: '.github/workflows/liftoff-staging-security.yml',
    repository: 'owner/repo', repositoryId: 42, actorId: 7, workflowId: 43, ref: 'develop', sourceSha: input.sourceSha,
    azure: { subscriptionId: input.subscriptionId, tenantId: input.tenantId,
      clientId: '12345678-1111-4222-8333-555555555555', principalId: input.principalId },
    environment: 'staging', target: {
      resourceId: input.resourceId, fqdn: input.fqdn, appName: 'application', healthPath: '/health',
      schemaPath: '/openapi.json', privateIp: '10.50.1.4'
    },
    image: { loginServer: 'crliftoff.azurecr.io', repository: 'team/app', digest: input.imageDigest },
    database: { cacheDirectory: '/srv/liftoff/trivy', databaseSha256: 'd'.repeat(64),
      metadataSha256: 'e'.repeat(64), maxAgeHours: 24 },
    runner: { group: 'dev-private', label: 'dev-linux', runnerId: null, runnerGroupId: 451 },
    tools: {
      containerScanner: { name: 'trivy', executable: '/usr/bin/trivy', version: '0.59.1', expectedSha256: `sha256:${'b'.repeat(64)}` },
      dastScanner: { name: 'zap-baseline', executable: '/opt/zap/zap-baseline.py', version: '2.14.0', expectedSha256: `sha256:${'c'.repeat(64)}` },
      azureCli: { name: 'az', executable: '/usr/bin/az', version: '2.74.0', expectedSha256: `sha256:${'e'.repeat(64)}` },
      azureLoginActionSha: 'e'.repeat(40), uploadArtifactActionSha: 'f'.repeat(40)
    },
    authority: {
      allowedNetworkTargets: [input.fqdn, 'api.github.com', 'crliftoff.azurecr.io'],
      budget: { currency: 'USD', fixedMonthlyCents: 0, usageMonthlyCents: 100 },
      limits: { maxRunMinutes: 15, commandTimeoutSeconds: 60, scanTimeoutSeconds: 300, httpTimeoutSeconds: 15 }
    },
    policy: { failOnSeverities: ['CRITICAL', 'HIGH'], failOnDastRisk: ['HIGH', 'MEDIUM'] }
  };
}

export class StagingProducerProtocol extends EnvironmentWorkflowProtocol {
  override readonly runId = 7413;
  override readonly jobId = 8202;
  override readonly checkId = 9202;
  override readonly artifactId = 6202;
  constructor(readonly security: PublishedStagingSecurityWorkflowRecipe, clock: () => Date) {
    super({
      workflowPath: '.github/workflows/liftoff-environment-staging.yml', environment: 'staging', resourceId: security.target.resourceId,
      fqdn: security.target.fqdn, healthPath: '/health', schemaPath: '/openapi.json',
      runner: { group: security.runner.group, label: security.runner.label },
      uploadArtifactActionSha: security.tools.uploadArtifactActionSha
    }, stagingSecurityWorkflowBinding(security),
    `${security.image.loginServer}/${security.image.repository}@${security.image.digest}`, 'application--fixture1', clock,
    security.azure.principalId);
    this.sourceContent = renderStagingSecurityWorkflow(security);
    this.publishedSourceContent = this.sourceContent;
    this.checkMutation.name = stagingSecurityWorkflowJob;
  }

  override job() {
    return {
      ...super.job(), name: stagingSecurityWorkflowJob,
      steps: ['Prepare private scanner authentication', 'Authenticate exact read-only scanner identity',
        stagingSecurityWorkflowStep, stagingSecurityWorkflowUploadStep].map((name, index) => ({
        number: index + 1, name, status: 'completed', conclusion: 'success'
      }))
    };
  }

  override reportBytes(): Buffer {
    const recipe = this.security;
    const report: StagingSecurityReport = {
      schemaVersion: 1, kind: 'liftoff-staging-security', correlationId: this.correlation,
      configurationDigest: this.configurationDigest, recipeDigest: canonicalSha256(stagingSecuritySourceRecipe(recipe)),
      source: { repository: recipe.repository, repositoryId: recipe.repositoryId, commitSha: recipe.sourceSha, ref: recipe.ref },
      producer: { workflowId: recipe.workflowId, workflowPath: recipe.workflowPath, workflowDigest: this.workflow.workflowDigest,
        runId: this.runId, runAttempt: 1, actorId: recipe.actorId, jobId: this.jobId,
        runnerId: this.runner.id, runnerGroupId: this.runner.groupId },
      target: { environment: 'staging', resourceId: recipe.target.resourceId, fqdn: recipe.target.fqdn, imageDigest: recipe.image.digest },
      prerequisites: {
        health: { path: '/health', status: 200, mediaType: 'application/json', bodyDigest: canonicalSha256({ status: 'ok' }), statusValue: 'ok' },
        schema: { path: '/openapi.json', status: 200, mediaType: 'application/json',
          bodyDigest: canonicalSha256({ openapi: '3.1.0', paths: { '/api/v1/quote': {} } }), openapi: '3.1.0', paths: ['/api/v1/quote'] },
        reachabilityVerified: true, privateAccess: null
      },
      scans: {
        supplyChain: {
          tool: { name: recipe.tools.containerScanner.name, version: recipe.tools.containerScanner.version,
            binarySha256: recipe.tools.containerScanner.expectedSha256 },
          target: this.imageRef, status: 'passed', exitCode: 0, reportDigest: canonicalSha256({ Results: [] }),
          findingsCount: { critical: 0, high: 0, medium: 0, low: 0, info: 0 }, findings: []
        },
        dast: {
          tool: { name: recipe.tools.dastScanner.name, version: recipe.tools.dastScanner.version,
            binarySha256: recipe.tools.dastScanner.expectedSha256 },
          target: `https://${recipe.target.fqdn}`, status: 'passed', exitCode: 0,
          reportDigest: canonicalSha256({ site: [] }), alertsCount: { high: 0, medium: 0, low: 0, info: 0 }, alerts: []
        }
      },
      overallStatus: 'passed', observedAt: this.effectTime
    };
    const witness = (path: string, bodyDigest: string) => ({
      protocol: 'https:' as const, fqdn: recipe.target.fqdn, path,
      observedDnsAddresses: [recipe.target.privateIp!], peerAddress: recipe.target.privateIp!, peerPort: 443,
      tlsAuthorized: true, tlsPeerCertificate: { fingerprint256: Array(32).fill('aa').join(':') },
      statusCode: 200, mediaType: 'application/json', bodyDigest, bodyBytesLength: 32, observedAt: this.effectTime
    });
    report.prerequisites.privateAccess = {
      health: witness('/health', report.prerequisites.health.bodyDigest),
      schema: witness('/openapi.json', report.prerequisites.schema.bodyDigest)
    };
    return Buffer.from(`${JSON.stringify(report)}\n`);
  }

  override archive(): Buffer {
    const bytes = environmentReportZip(this.reportBytes(), { name: stagingSecurityWorkflowReportFile, deflate: true, descriptor: true });
    return this.archiveMutation ? this.archiveMutation(bytes) : bytes;
  }

  override artifact() {
    return { ...super.artifact(), name: `liftoff-staging-security-${this.correlation}` };
  }
}
