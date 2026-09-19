import type {
  PhaseId,
  LiveReadbackProof,
  TransitionOperation,
  ExternalOperationState,
  PhaseOutputBindings,
  UserActivationState
} from '../../domain/governance/activation/types.js';
import type { PhasePlanBuild, PhaseAdapterOutcome } from '../../governance-activation/transition-ports.js';

export interface AzurePhasePlanningContext {
  phaseId: PhaseId;
  subscriptionId: string;
  tenantId: string;
  region: string;
  resourceGroup: string;
  projectRoot: string;
  now: Date;
}

export interface AzureDisposableQualificationApproval {
  approved: boolean;
  spendLimitUsd?: number;
  maxDurationMinutes?: number;
  environment?: string;
  disposableTargetId?: string;
}

export interface AzureActivationPhaseOptions {
  subscriptionId?: string;
  tenantId?: string;
  region?: string;
  resourceGroup?: string;
  statePath?: 'existing-private' | 'bootstrap-local';
  storageAccount?: string;
  containerName?: string;
  vnetName?: string;
  subnetName?: string;
  acrName?: string;
  identityName?: string;
  appName?: string;
  imageName?: string;
  expectedDigest?: string;
  approvedRegistrations?: readonly string[];
  qualification?: AzureDisposableQualificationApproval;
}

export interface BoundedAzureCheckpoint {
  checkpointId: string;
  phaseId: PhaseId;
  actionId: string;
  operationId: string;
  resourceId: string;
  startedAt: string;
  preEffectSnapshotHash?: string;
  effectsPersisted: readonly string[];
}

export type AzureProducerResult =
  | {
      status: 'completed';
      resultState?: 'verified' | 'approved' | 'inapplicable' | 'retained';
      evidencePayload: unknown;
      liveReadback?: readonly LiveReadbackProof[];
      outputs?: PhaseOutputBindings;
      stateOverride?: UserActivationState;
      completedOperations: readonly TransitionOperation[];
      cleanupWarnings?: readonly string[];
    }
  | {
      status: 'pending';
      operation: ExternalOperationState;
      checkpoint?: BoundedAzureCheckpoint;
      blocker?: string;
      completedOperations: readonly TransitionOperation[];
    }
  | {
      status: 'blocked';
      blocker: string;
      completedOperations: readonly TransitionOperation[];
      checkpoint?: BoundedAzureCheckpoint;
    };
