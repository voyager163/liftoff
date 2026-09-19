import { AzureArmError } from '../../adapters/azure/activation-rest.js';
import {
  AzureApplicationRegistryCopyClient, ApplicationRegistryCopyError,
  type ApplicationRegistryCopyOptions, type ApplicationRegistryPromotionReadback
} from '../../adapters/azure/application-registry-copy.js';
import { createScopedUserLocalRecordStore } from '../../adapters/filesystem/update-previews.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { azurePorts } from '../../governance-activation/azure-ports.js';
import type { PhaseAdapterExecutionInput } from '../../governance-activation/transition-ports.js';
import { AzureActivationAdmissionError } from './authority.js';
import {
  applicationRegistryPromotionInputs, applicationRegistryPromotionProtocol,
  assertApplicationRegistryPromotionAuthority, createApplicationRegistryPromotionAdmission,
  type ApplicationRegistryPromotionAdmission, type ApplicationRegistryPromotionCheckpoint,
  type ApplicationRegistryPromotionReceipt, type ApplicationRegistryPromotionResult
} from './application-registry-promotion-admission.js';

export {
  applicationRegistryPromotionAction, applicationRegistryPromotionInputs, applicationRegistryPromotionOperation,
  applicationRegistryPromotionProtocol, applicationRegistryPromotionRegistryId,
  assertApplicationRegistryPromotionAuthority, planApplicationRegistryPromotion,
  readApplicationRegistryPromotionCheckpoint, readApplicationRegistryPromotionSource,
  validateApplicationRegistryPromotionConfiguration,
  type ApplicationRegistryBuildReference, type ApplicationRegistryPromotionCheckpoint,
  type ApplicationRegistryPromotionCheckpointReference, type ApplicationRegistryPromotionConfiguration,
  type ApplicationRegistryPromotionDisposableTarget, type ApplicationRegistryPromotionEffect,
  type ApplicationRegistryPromotionEffectCheckpoint, type ApplicationRegistryPromotionEffectPrepared,
  type ApplicationRegistryPromotionEffectResponse, type ApplicationRegistryPromotionPrepared,
  type ApplicationRegistryPromotionReceipt, type ApplicationRegistryPromotionResult,
  type ApplicationRegistryPromotionSource, type ApplicationRegistryTransferBounds
} from './application-registry-promotion-admission.js';

/** Completion composes issued admission with the adapter's independently issued byte readback. */
export type ApplicationRegistryPromotionAuthority = ApplicationRegistryPromotionAdmission & {
  complete(readback: ApplicationRegistryPromotionReadback): Promise<ApplicationRegistryPromotionReceipt>;
};

function must(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new AzureActivationAdmissionError(`registry-promotion-${code}`, message);
}

function hash(value: unknown): string {
  must(typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value), 'digest', 'An exact lowercase SHA-256 metadata commitment is required.');
  return value;
}

export async function createApplicationRegistryPromotionAuthority(input: PhaseAdapterExecutionInput): Promise<ApplicationRegistryPromotionAuthority> {
  const authority = await createApplicationRegistryPromotionAdmission(input);
  const configuration = authority.configuration;
  const store = createScopedUserLocalRecordStore(authority.projectRoot, 'governance-operation', azurePorts(authority.input).storage);
  // Preserve the actual issued object's identity; a wrapper would not carry its private admission.
  return Object.assign(authority, {
    async complete(this: ApplicationRegistryPromotionAuthority, readback: ApplicationRegistryPromotionReadback): Promise<ApplicationRegistryPromotionReceipt> {
      await assertApplicationRegistryPromotionAuthority(this);
      must(this === authority, 'authority', 'Promotion completion must retain its original privately issued authority.');
      AzureApplicationRegistryCopyClient.assertIssuedReadback(this, readback);
      const checkpoint = await this.prepare();
      const receipt: ApplicationRegistryPromotionReceipt = {
        schemaVersion: 1, kind: 'application-registry-promotion.v1', protocol: applicationRegistryPromotionProtocol,
        source: this.source, sourceRegistryResourceId: configuration.sourceRegistryResourceId,
        targetRegistryResourceId: configuration.targetRegistryResourceId,
        sourceImageRef: this.source.provenance.imageRef,
        targetImageRef: `${configuration.targetLoginServer}/${configuration.targetRepository}@${configuration.imageDigest}`,
        imageDigest: configuration.imageDigest, configDigest: this.source.provenance.configDigest,
        readback, checkpoint: checkpoint.reference, planDigest: this.input.plan.planDigest,
        approvalEnvelopeHash: hash(this.input.plan.approval.envelopeHash), observedAt: new Date(this.now()).toISOString()
      };
      if (!checkpoint.completed) {
        await store.write(canonicalSha256({ key: this.key, stage: 'completed' }), { receipt, receiptDigest: canonicalSha256(receipt) });
      }
      return receipt;
    }
  });
}

/** Recovery only re-reads exact outputs. It never repeats an upload, even with a known UUID. */
export async function executeApplicationRegistryPromotion(
  input: PhaseAdapterExecutionInput, options: ApplicationRegistryCopyOptions = {}
): Promise<ApplicationRegistryPromotionResult> {
  let authority: ApplicationRegistryPromotionAuthority | undefined;
  let client: AzureApplicationRegistryCopyClient | undefined;
  let checkpoint: ApplicationRegistryPromotionCheckpoint | null = null;
  try {
    authority = await createApplicationRegistryPromotionAuthority(input);
    authority.enter();
    checkpoint = await authority.checkpoint();
    must(authority.configuration.mode !== 'recover' || checkpoint, 'missing-recovery', 'The named original promotion checkpoint is missing; recovery will not create or repeat an effect.');
    client = new AzureApplicationRegistryCopyClient(authority, options);
    const readback = await client.execute();
    const receipt = await authority.complete(readback);
    return {
      status: 'completed',
      disposition: authority.configuration.mode === 'readback' ? 'readback' :
        checkpoint ? 'recovered' : client.usage.writeRequests ? 'copied' : 'already-present',
      receipt, usage: client.usage, completedOperations: [authority.operation]
    };
  } catch (error) {
    // No provider body, command diagnostic or auth-bearing URL is included in this outcome.
    if (authority) checkpoint = await authority.checkpoint();
    const recognized = error instanceof AzureActivationAdmissionError || error instanceof AzureArmError || error instanceof ApplicationRegistryCopyError;
    return {
      status: 'blocked', code: recognized ? error.code : 'registry-promotion-unverified',
      blocker: recognized ? error.message : 'Promotion did not produce a verified outcome. Preserve original private custody; no replacement or blind registry retry is authorized.',
      checkpoint: checkpoint?.reference ?? null, effects: checkpoint?.effects ?? [],
      usage: client?.usage ?? { requests: 0, writeRequests: 0, transferredBytes: 0, imageBytes: 0, blobs: 0, manifests: 0 },
      completedOperations: []
    };
  } finally { client?.dispose(); authority?.leave(); }
}

export async function readbackApplicationRegistryPromotion(
  input: PhaseAdapterExecutionInput, options: ApplicationRegistryCopyOptions = {}
): Promise<ApplicationRegistryPromotionResult> {
  must(applicationRegistryPromotionInputs(input).mode === 'readback', 'readback-mode', 'Independent readback requires its explicitly reviewed readback mode.');
  return executeApplicationRegistryPromotion(input, options);
}

export async function recoverApplicationRegistryPromotion(
  input: PhaseAdapterExecutionInput, options: ApplicationRegistryCopyOptions = {}
): Promise<ApplicationRegistryPromotionResult> {
  must(applicationRegistryPromotionInputs(input).mode === 'recover', 'recovery-mode', 'Recovery requires a separately approved exact original checkpoint and a new bounded readback interval.');
  return executeApplicationRegistryPromotion(input, options);
}
