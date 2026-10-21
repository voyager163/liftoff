import { types } from 'node:util';
import { exactRecord } from '../../project/manifest/fields.js';
import { canonicalSha256 } from './canonical-json.js';
import type { ExternalOperationStateFieldsV1 } from './record-contracts.js';

export const applicationPublicationActionId = 'github.artifact.digest-dispatch';

export interface DigestApplicationPublicationReceipt {
  readonly schemaVersion: 2;
  readonly kind: 'application-artifact-publication.v2';
  readonly recipeVersion: 'oci-digest-v1';
  readonly repository: string;
  readonly sourceSha: string;
  readonly sourceTreeSha: string;
  readonly workflowDigest: string;
  readonly contextDigest: string;
  readonly programDigest: string;
  readonly executionRef: string;
  readonly workflowId: number;
  readonly workflowRunId: number;
  readonly workflowJobId: number;
  readonly attempt: 1;
  readonly environment: 'dev' | 'staging' | 'prod';
  readonly registryResourceId: string;
  readonly loginServer: string;
  readonly imageRepository: string;
  readonly artifactDigest: string;
  readonly immutableImage: string;
  readonly artifactBindingDigest: string;
  readonly planDigest: string;
  readonly savedPlanDigest: string;
  readonly originalOperationDigest: string;
  readonly attestationVerificationDigest: string;
  readonly authenticatedDeliveryDigest: string;
  readonly wholeJobCustodyDigest: string;
  readonly toolQualificationDigest: string;
}

const receiptFields = [
  'schemaVersion', 'kind', 'recipeVersion', 'repository', 'sourceSha', 'sourceTreeSha', 'workflowDigest',
  'contextDigest', 'programDigest', 'executionRef', 'workflowId', 'workflowRunId', 'workflowJobId', 'attempt',
  'environment', 'registryResourceId', 'loginServer', 'imageRepository', 'artifactDigest', 'immutableImage',
  'artifactBindingDigest', 'planDigest', 'savedPlanDigest', 'originalOperationDigest',
  'attestationVerificationDigest', 'authenticatedDeliveryDigest', 'wholeJobCustodyDigest', 'toolQualificationDigest'
] as const;

/** Record data only: commitments do not mint delivery, custody, tool or execution authority. */
export function readDigestApplicationPublicationReceipt(input: unknown): DigestApplicationPublicationReceipt {
  if (types.isProxy(input)) throw new Error('Publication source6 receipt must be plain JSON data.');
  const value = exactRecord(input, receiptFields, 'Publication source6 receipt');
  const text = (field: typeof receiptFields[number], pattern: RegExp): string => {
    const entry = value[field];
    if (typeof entry !== 'string' || entry.length > 1024 || !pattern.test(entry)) {
      throw new Error(`Publication source6 receipt has invalid ${field}.`);
    }
    return entry;
  };
  const id = (field: 'workflowId' | 'workflowRunId' | 'workflowJobId'): number => {
    const entry = value[field];
    if (typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry <= 0) {
      throw new Error(`Publication source6 receipt requires an actual positive ${field}.`);
    }
    return entry;
  };
  const hex = /^[a-f0-9]{64}$/u, git = /^[a-f0-9]{40}$/u;
  if (value.schemaVersion !== 2 || value.kind !== 'application-artifact-publication.v2' ||
    value.recipeVersion !== 'oci-digest-v1' || value.attempt !== 1) {
    throw new Error('Publication source6 receipt requires its exact version, digest recipe and original attempt.');
  }
  const environment = value.environment;
  if (environment !== 'dev' && environment !== 'staging' && environment !== 'prod') {
    throw new Error('Publication source6 receipt requires a declared environment.');
  }
  const sourceSha = text('sourceSha', git);
  const repository = text('repository', /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/u);
  const executionRef = text('executionRef', /^liftoff-execution-[a-f0-9]{40}$/u);
  const registryResourceId = text('registryResourceId',
    /^\/subscriptions\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/resourceGroups\/[A-Za-z0-9_.()-]+\/providers\/Microsoft\.ContainerRegistry\/registries\/[a-z0-9]{5,50}$/u);
  const loginServer = text('loginServer', /^[a-z0-9]{5,50}\.azurecr\.io$/u);
  const imageRepository = text('imageRepository', /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/u);
  const artifactDigest = text('artifactDigest', /^sha256:[a-f0-9]{64}$/u);
  const immutableImage = text('immutableImage', /^[a-z0-9./_@:-]+$/u);
  if (['.', '..'].includes(repository.split('/')[1]) || executionRef !== `liftoff-execution-${sourceSha}` ||
    loginServer !== `${registryResourceId.split('/').at(-1)}.azurecr.io` ||
    imageRepository.length > 255 || immutableImage !== `${loginServer}/${imageRepository}@${artifactDigest}`) {
    throw new Error('Publication source6 receipt contradicts its immutable source, registry or digest-only image.');
  }
  return Object.freeze({
    schemaVersion: 2, kind: 'application-artifact-publication.v2', recipeVersion: 'oci-digest-v1',
    repository,
    sourceSha, sourceTreeSha: text('sourceTreeSha', git), workflowDigest: text('workflowDigest', hex),
    contextDigest: text('contextDigest', hex), programDigest: text('programDigest', hex), executionRef,
    workflowId: id('workflowId'), workflowRunId: id('workflowRunId'), workflowJobId: id('workflowJobId'),
    attempt: 1, environment, registryResourceId, loginServer, imageRepository, artifactDigest, immutableImage,
    artifactBindingDigest: text('artifactBindingDigest', hex), planDigest: text('planDigest', hex),
    savedPlanDigest: text('savedPlanDigest', hex), originalOperationDigest: text('originalOperationDigest', hex),
    attestationVerificationDigest: text('attestationVerificationDigest', hex),
    authenticatedDeliveryDigest: text('authenticatedDeliveryDigest', hex),
    wholeJobCustodyDigest: text('wholeJobCustodyDigest', hex), toolQualificationDigest: text('toolQualificationDigest', hex)
  });
}

export function assertDigestApplicationPublicationOperation(
  receipt: DigestApplicationPublicationReceipt, operation: ExternalOperationStateFieldsV1 | undefined
): void {
  const resource = `/repos/${receipt.repository}/actions/runs/${receipt.workflowRunId}`;
  if (!operation || operation.provider !== 'github' || operation.actionId !== applicationPublicationActionId ||
    operation.status !== 'completed' || operation.planDigest !== receipt.planDigest ||
    operation.operationId !== `github-actions:${receipt.workflowRunId}` || operation.resourceId !== resource ||
    operation.pollUrl !== `https://api.github.com${resource}` ||
    canonicalSha256(operation) !== receipt.originalOperationDigest) {
    throw new Error('Publication source6 requires its exact original completed digest dispatch; legacy, missing, pending or substituted handles cannot authorize consumption.');
  }
}
