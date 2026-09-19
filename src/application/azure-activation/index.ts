import { planAzurePhase, executeAzurePhase } from '../../governance-activation/phase-azure.js';
import { planCompositePhase, executeCompositePhase } from '../../governance-activation/phase-composite.js';
import { azureActivationEngine } from './capabilities.js';

export const azureActivationRuntime = Object.freeze({
  descriptor: azureActivationEngine,
  planPhase: planAzurePhase,
  executePhase: executeAzurePhase,
  planCompositePhase,
  executeCompositePhase
});

export * from './capabilities.js';
