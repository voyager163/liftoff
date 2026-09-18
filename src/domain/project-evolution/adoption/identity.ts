import { isRecord } from '../../governance/activation/canonical-json.js';
import { SEMVER_PATTERN } from '../../project/manifest/fields.js';

export const adoptionContractVersion = 1 as const;
export const adoptionRecordSchemaVersion = 1 as const;
export const adoptionRecipe = { id: 'supported-project-adoption', version: 1 } as const;
export const adoptionReadableWriterVersions = ['0.13.0'] as const;

export interface AdoptionExecutionIdentity {
  cliVersion: string;
  adoptionContractVersion: 1;
  recipe: typeof adoptionRecipe;
}

export function adoptionExecutionIdentity(cliVersion: string): AdoptionExecutionIdentity {
  if (!adoptionReadableWriterVersions.some((version) => version === cliVersion)) {
    throw new Error('Unregistered adoption writer identity; use a CLI supporting the original adoption contract rather than retagging history.');
  }
  return { cliVersion, adoptionContractVersion, recipe: adoptionRecipe };
}

export function validateAdoptionExecutionIdentity(value: unknown): AdoptionExecutionIdentity {
  if (!isRecord(value) || Object.keys(value).length !== 3 ||
    typeof value.cliVersion !== 'string' || !SEMVER_PATTERN.test(value.cliVersion) ||
    value.adoptionContractVersion !== adoptionContractVersion || !isRecord(value.recipe) ||
    Object.keys(value.recipe).length !== 2 || value.recipe.id !== adoptionRecipe.id || value.recipe.version !== adoptionRecipe.version) {
    throw new Error('Adoption requires the exact independent contract-1 and supported-project-adoption recipe-1 identity. Historical repair records are not adoption authority.');
  }
  return adoptionExecutionIdentity(value.cliVersion);
}
