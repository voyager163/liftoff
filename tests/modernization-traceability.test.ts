import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { liftoffVersion } from '../src/version.js';
import { publicProtocolSchemaVersion } from '../src/protocol/schema.js';
import { repairContractVersion, repairSchemaVersions } from '../src/domain/repair/identity.js';
import { updateReportSchemaVersion } from '../src/application/update/output.js';

interface TraceabilityInventory {
  schemaVersion: number;
  product: string;
  repository: string;
  change: string;
  baseline: { version: string; tag: string; sourceCommit: string };
  candidate: { version: string; state: string; publicationAuthorized: boolean };
  engines: string[];
  qualificationOwners: string[];
  capabilities: Array<{ id: string; engine: string; taskGroups: number[]; qualificationOwners: string[] }>;
  issues: Array<{ number: number; taskGroups: number[]; engines: string[]; qualificationOwners: string[] }>;
  operatorDashboard: { implementationOwner: string; qualificationOwners: string[]; taskGroups: number[]; resourceType: string };
  requiredProductionExecutors: Array<{ id: string; engine: string; qualificationOwner: string }>;
  requiredNativeTargets: string[];
  nativeQualificationMatrix: Array<{
    target: string;
    os: string;
    arch: string;
    hostFloor: string;
    runnerLabel: string;
    runnerStatus: string;
    qualified: boolean;
    blockerReason: string;
  }>;
  externalQualification: {
    state: string;
    requiredPublicInputs: string[];
    releaseBlockers: string[];
    credentialsInPublicArtifacts: boolean;
    mockEvidenceQualifiesProduction: boolean;
  };
  historicalWindowsFailure: {
    sourceCommit: string;
    runId: string;
    jobId: string;
    runnerLabels: string[];
    conclusion: string;
    failedStep: string;
    observations: Array<{ id: string; message: string; cases: string[] }>;
    rootCauseStatus: string;
    observationEstablishesCause: boolean;
  };
  verification: {
    schemaVersion: number;
    collectionWorkflow: null;
    workflows: Record<string, unknown>;
    nativeSigning: null;
    qualificationRegistry: null;
    reportProducers: { approvalRequest: null; executionQualification: null };
    telemetryGateway: null;
    authorities: Record<string, null>;
    qualificationPlans: Record<string, unknown[]>;
    channels: Record<string, null>;
  };
}

async function inventory(): Promise<TraceabilityInventory> {
  return JSON.parse(await readFile(new URL('../assets/qualification/release-scope.json', import.meta.url), 'utf8'));
}

async function changeRoot(name: string): Promise<string> {
  const root = path.join(process.cwd(), 'openspec', 'changes');
  const entries = await readdir(root);
  if (entries.includes(name)) return path.join(root, name);
  const archived = (await readdir(path.join(root, 'archive'))).filter((entry) => entry.endsWith(`-${name}`));
  expect(archived, 'Exactly one retained change defines the release scope').toHaveLength(1);
  return path.join(root, 'archive', archived[0]);
}

describe('coordinated modernization traceability', () => {
  it('pins the immutable baseline independently of an unpublished candidate', async () => {
    const scope = await inventory();
    expect(scope.schemaVersion).toBe(1);
    expect(scope.product).toBe('@msn-control/liftoff');
    expect(scope.repository).toBe('voyager163/liftoff');
    expect(scope.baseline).toEqual({
      version: '0.12.3', tag: 'v0.12.3', sourceCommit: '70d10881b46d873118d825735696f39b6d35ebe0'
    });
    expect(scope.candidate).toEqual({
      version: '0.13.0', state: 'development', publicationAuthorized: false
    });
    expect(liftoffVersion).toBe(scope.candidate.version);
    expect(publicProtocolSchemaVersion).toBe(1);
    expect(repairContractVersion).toBe(1);
    expect(repairSchemaVersions.report).toBe(2);
    expect(repairSchemaVersions.journal).toBe(2);
    expect(updateReportSchemaVersion).toBe(3);
  });

  it('assigns all 27 delta specifications and their requirements to implementation and qualification owners', async () => {
    const scope = await inventory();
    const root = await changeRoot(scope.change);
    const specifications = (await readdir(path.join(root, 'specs'))).sort();
    const ids = scope.capabilities.map((capability) => capability.id);
    expect([...ids].sort()).toEqual(specifications);
    expect(new Set(ids).size).toBe(27);
    expect(new Set(scope.engines).size).toBe(6);
    expect(scope.engines).not.toContain('execution');
    for (const capability of scope.capabilities) {
      expect(scope.engines).toContain(capability.engine);
      expect(capability.qualificationOwners.length).toBeGreaterThan(0);
      for (const owner of capability.qualificationOwners) expect(scope.qualificationOwners).toContain(owner);
      expect(capability.taskGroups.length).toBeGreaterThan(0);
      expect(capability.taskGroups.every((group) => Number.isInteger(group) && group >= 1 && group <= 18)).toBe(true);
      const spec = await readFile(path.join(root, 'specs', capability.id, 'spec.md'), 'utf8');
      expect(spec.match(/^### Requirement: /gm)?.length, capability.id).toBeGreaterThan(0);
    }
  });

  it('includes all linked issues and the operator dashboard without adding a seventh CLI engine', async () => {
    const scope = await inventory();
    expect(scope.issues.map((issue) => issue.number)).toEqual([78, 79, 80, 81, 82]);
    for (const issue of scope.issues) {
      expect(issue.taskGroups.length).toBeGreaterThan(0);
      for (const engine of issue.engines) expect(scope.engines).toContain(engine);
      for (const owner of issue.qualificationOwners) expect(scope.qualificationOwners).toContain(owner);
    }
    expect(scope.operatorDashboard.resourceType).toBe('Microsoft.Dashboard/dashboards');
    expect(scope.operatorDashboard.implementationOwner).toBe('telemetry-operator');
    expect(scope.operatorDashboard.taskGroups).toEqual([17, 18]);
    expect(scope.engines).not.toContain('telemetry-operator');
  });

  it('keeps every required production producer and all six native targets in the release gate', async () => {
    const scope = await inventory();
    expect(scope.requiredNativeTargets).toEqual([
      'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64'
    ]);
    expect(scope.requiredProductionExecutors.map((executor) => executor.id)).toEqual([
      'bootstrap-workflow-source-ready', 'workflow-source-ready', 'credential-ready', 'provider-ready',
      'state-path-selected', 'existing-private-path', 'bootstrap-local', 'runner-ready',
      'private-backend-proof', 'remote-import-verified', 'application-prerequisites-ready',
      'application-artifact-ready', 'application-foundation', 'dev-proof', 'staging-qualified',
      'production-rehearsed', 'green-red-proof', 'rulesets-applied', 'live-readback'
    ]);
    for (const executor of scope.requiredProductionExecutors) {
      expect(scope.engines).toContain(executor.engine);
      expect(scope.qualificationOwners).toContain(executor.qualificationOwner);
    }
    expect(scope.externalQualification.state).toBe('approval-inputs-required');
    expect(scope.externalQualification.requiredPublicInputs.length).toBeGreaterThan(0);
    expect(scope.externalQualification.releaseBlockers.length).toBeGreaterThan(0);
    expect(scope.externalQualification.credentialsInPublicArtifacts).toBe(false);
    expect(scope.externalQualification.mockEvidenceQualifiesProduction).toBe(false);
    expect(scope.verification.schemaVersion).toBe(1);
    expect(scope.verification.collectionWorkflow).toBeNull();
    expect(scope.verification.workflows).toEqual({});
    expect(scope.verification.nativeSigning).toBeNull();
    expect(scope.verification.qualificationRegistry).toBeNull();
    expect(scope.verification.reportProducers).toEqual({ approvalRequest: null, executionQualification: null });
    expect(scope.verification.telemetryGateway).toBeNull();
    expect(scope.verification.authorities).toEqual({ publication: null, liveQualification: null, dashboard: null, telemetryGateway: null });
    expect(scope.verification.qualificationPlans).toEqual({ liveQualification: [], dashboard: [], telemetryGateway: [] });
    expect(scope.verification.channels).toEqual({ homebrewCask: null, winget: null, linuxDirect: null });
  });

  it('records preservation rather than granting deletion authority from branch names', async () => {
    const preserved = JSON.parse(await readFile(
      new URL('../assets/qualification/source-preservation.json', import.meta.url), 'utf8'
    ));
    expect(preserved.permanentBranches).toEqual(['main', 'develop']);
    expect(preserved.eligibleBranchDeletions).toEqual([]);
    expect(preserved.eligibleWorktreeRemovals).toEqual([]);
    expect(preserved.verifiedStaleTrackingRefs).toEqual([]);
    expect(preserved.observationsGrantDeletionAuthority).toBe(false);
    expect(preserved.mutationsPerformed).toEqual([]);
  });

  it('identifies documented native runners without treating current images as minimum-host qualification', async () => {
    const scope = await inventory();
    const runners = [
      ['darwin-x64', 'macos-15-intel'],
      ['darwin-arm64', 'macos-14'],
      ['win32-x64', 'windows-2022'],
      ['win32-arm64', 'windows-11-arm'],
      ['linux-x64', 'ubuntu-22.04'],
      ['linux-arm64', 'ubuntu-24.04-arm']
    ];
    expect(scope.nativeQualificationMatrix.map((entry) => [entry.target, entry.runnerLabel])).toEqual(runners);
    for (const entry of scope.nativeQualificationMatrix) {
      expect(entry.target).toBe(`${entry.os}-${entry.arch}`);
      expect(entry.runnerStatus).toBe('available');
      expect(entry.qualified).toBe(false);
      expect(entry.hostFloor.length).toBeGreaterThan(0);
      expect(entry.blockerReason).toContain('minimum-host qualification');
    }
  });

  it('binds the observed Windows failures to native reproduction cases without claiming a cause', async () => {
    const scope = await inventory();
    const failure = scope.historicalWindowsFailure;
    expect(failure.sourceCommit).toBe(scope.baseline.sourceCommit);
    expect(failure.runId).toBe('34842047858');
    expect(failure.jobId).toBe('103969047717');
    expect(failure.runnerLabels).toEqual(['windows-latest']);
    expect(failure.conclusion).toBe('failure');
    expect(failure.failedStep).toBe('Run Windows project and packaging boundary coverage');
    expect(failure.rootCauseStatus).toBe('not-established-by-native-reproduction');
    expect(failure.observationEstablishesCause).toBe(false);
    expect(failure.observations.map((observation) => observation.id)).toEqual([
      'timeout-classification', 'npm-admission', 'spawn-and-settlement'
    ]);
    for (const observation of failure.observations) {
      expect(observation.message.length).toBeGreaterThan(0);
      expect(observation.cases.length).toBeGreaterThan(0);
      for (const testFile of observation.cases) {
        expect(await readFile(path.join(process.cwd(), testFile), 'utf8')).toContain('test');
      }
    }
  });
});
