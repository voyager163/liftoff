import type { UpdatePreviewOptions } from '../adapters/filesystem/update-previews.js';
import type { PhaseAdapterExecutionInput, PhasePlanningInput } from './transition-ports.js';
import type { AzureArmTransport } from '../adapters/azure/activation-rest.js';

export interface AzureActivationPorts {
  storage?: UpdatePreviewOptions;
  transport?: AzureArmTransport;
}

export function azurePorts(input: PhasePlanningInput | PhaseAdapterExecutionInput): AzureActivationPorts {
  return input.adapters?.azureActivation ?? {};
}
