import type { InstallationOwnershipRecord } from './contracts.js';

export interface RawOwnershipProbeInput {
  executablePath: string;
  isPackageJsonPresent?: boolean;
  packageName?: string;
  packageVersion?: string;
  isCaskroomPresent?: boolean;
  isWinGetRecordPresent?: boolean;
  hasDirectReceipt?: boolean;
  directReceiptVersion?: string;
  isDevelopmentCheckout?: boolean;
  isNpxCache?: boolean;
  isSymlinkedDevelopment?: boolean;
}

// These legacy hints remain diagnostic inputs, not authenticated manager or receipt observations.
export function classifyInstallationOwner(_input: RawOwnershipProbeInput): InstallationOwnershipRecord {
  return { owner: 'unknown', isCask: false, isFormula: false, isNodeDependent: false };
}
