import { canonicalSha256 } from '../../src/domain/governance/activation/canonical-json.js';
import type { PrivateRunnerAssignmentBinding } from '../../src/application/azure-activation/private-runner-assignment.js';
import {
  privateApplicationWorkflowContent, type PrivateRunnerApplicationSource
} from '../../src/application/azure-activation/private-runner-application-sources.js';
import {
  stagingSecurityWorkflowRecipeId, type StagingSecurityWorkflowRecipe
} from '../../src/application/azure-activation/staging-security-workflow.js';
import { fixtureBinding, fixtureGroup } from './private-activation-fixture.js';

export function privateApplicationSourceFixture(
  assignment: Pick<PrivateRunnerAssignmentBinding, 'repository' | 'repositoryId' | 'runnerGroupName' | 'runnerName'>,
  kind: PrivateRunnerApplicationSource['kind']
): PrivateRunnerApplicationSource {
  const common = {
    schemaVersion: 1 as const, repository: assignment.repository, repositoryId: assignment.repositoryId,
    workflowId: kind === 'environment-runtime' ? 31 : 32, workflowDigest: '', sourceSha: 'c'.repeat(40), ref: 'develop', actorId: 9
  };
  const runner = { group: assignment.runnerGroupName, label: assignment.runnerName };
  let source: PrivateRunnerApplicationSource;
  if (kind === 'environment-runtime') {
    source = { ...common, kind, recipe: {
      workflowPath: '.github/workflows/liftoff-environment-dev.yml', environment: 'dev',
      resourceId: `${fixtureGroup}/providers/Microsoft.App/containerApps/fixture-dev`,
      fqdn: 'fixture-dev.eastus.azurecontainerapps.io', healthPath: '/health', schemaPath: '/openapi.json',
      runner, uploadArtifactActionSha: 'b'.repeat(40)
    } };
  } else {
    const recipe: StagingSecurityWorkflowRecipe = {
      schemaVersion: 1, recipe: stagingSecurityWorkflowRecipeId,
      workflowPath: '.github/workflows/liftoff-staging-security.yml',
      repository: assignment.repository, repositoryId: assignment.repositoryId, actorId: 9, workflowId: null,
      ref: 'develop', sourceSha: null, azure: { ...fixtureBinding, clientId: '12345678-1111-4222-8333-555555555555' },
      environment: 'staging', target: {
        resourceId: `${fixtureGroup}/providers/Microsoft.App/containerApps/fixture-staging`, appName: 'fixture-staging',
        fqdn: null, healthPath: '/health', schemaPath: '/openapi.json', privateIp: null
      },
      image: { loginServer: 'fixture.azurecr.io', repository: 'fixture/application', digest: null },
      database: { cacheDirectory: '/opt/liftoff/trivy-db', databaseSha256: null, metadataSha256: null, maxAgeHours: 24 },
      runner, tools: {
        containerScanner: { name: 'trivy', executable: '/opt/liftoff/bin/trivy', version: '0.63.0', expectedSha256: `sha256:${'1'.repeat(64)}` },
        dastScanner: { name: 'zap-baseline', executable: '/opt/liftoff/bin/zap-baseline', version: '2.16.1', expectedSha256: `sha256:${'2'.repeat(64)}` },
        azureCli: { name: 'az', executable: '/opt/liftoff/bin/az', version: '2.75.0', expectedSha256: `sha256:${'3'.repeat(64)}` },
        azureLoginActionSha: 'a'.repeat(40), uploadArtifactActionSha: 'b'.repeat(40)
      },
      authority: {
        allowedNetworkTargets: null, budget: { currency: 'USD', fixedMonthlyCents: 1000, usageMonthlyCents: 1000 },
        limits: { maxRunMinutes: 10, commandTimeoutSeconds: 30, scanTimeoutSeconds: 120, httpTimeoutSeconds: 15 }
      },
      policy: { failOnSeverities: ['CRITICAL', 'HIGH'], failOnDastRisk: ['HIGH', 'MEDIUM'] }
    };
    source = { ...common, kind, recipe };
  }
  source.workflowDigest = canonicalSha256(privateApplicationWorkflowContent(source));
  return source;
}
