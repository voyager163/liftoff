import {
  createDirectReceipt,
  type DirectInstallReceipt,
  type NativeTarget,
  type NativeTargetRuntimeConstraints
} from '../../../domain/distribution/index.js';

export interface DirectReceiptGeneratorInputs {
  version: string;
  target: NativeTarget;
  sourceCommit: string;
  installRoot: string;
  versionRoot: string;
  launcherPath: string;
  runtime: NativeTargetRuntimeConstraints;
  checksumSha256: string;
}

export function generateDirectReceiptContent(inputs: DirectReceiptGeneratorInputs): DirectInstallReceipt {
  return createDirectReceipt(inputs);
}
