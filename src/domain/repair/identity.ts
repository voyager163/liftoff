import { canonicalSha256, isRecord } from '../governance/activation/canonical-json.js';

export const repairContractVersion = 1 as const;
export const repairSchemaVersions = {
  capabilities: 1,
  report: 2,
  preview: 2,
  history: 2,
  journal: 2,
  applicationInventory: 1,
  applicationPatch: 1,
  applicationPatchReport: 1,
  applicationVerificationResult: 1,
  applicationVerification: 1,
  applicationBackup: 1
} as const;

export const applicationTargetLayoutId = 'liftoff-application-artifacts-v1' as const;

export const repairRecipes = {
  'azure-local-layout': {
    id: 'azure-local-layout',
    version: 1,
    sourceLayouts: ['azure-flat-root-v1', 'azure-partial-independent-v1'],
    targetLayout: 'azure-independent-roots-v1'
  },
  'application-layout-patch': {
    id: 'application-layout-patch',
    version: 1,
    sourceLayouts: ['explicit-project-file-mapping-v1'],
    targetLayout: applicationTargetLayoutId
  }
} as const;

export type RepairRecipeId = keyof typeof repairRecipes;
export type RepairRecipeIdentity = (typeof repairRecipes)[RepairRecipeId];

export interface RepairExecutionIdentity {
  cliVersion: string;
  repairContractVersion: typeof repairContractVersion;
  recipe: RepairRecipeIdentity;
}

export function repairExecutionIdentity(cliVersion: string, recipe: RepairRecipeId): RepairExecutionIdentity {
  return { cliVersion, repairContractVersion, recipe: repairRecipes[recipe] };
}

export function validateRepairExecutionIdentity(value: unknown): RepairExecutionIdentity {
  if (!isRecord(value) ||
      Object.keys(value).length !== 3 ||
      typeof value.cliVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(value.cliVersion)) {
    throw new Error('Repair identity must record exactly cliVersion, repairContractVersion and recipe.');
  }
  if (value.repairContractVersion !== repairContractVersion) {
    throw new Error(`Unsupported repairContractVersion: found ${JSON.stringify(value.repairContractVersion)}; supported ${repairContractVersion}. Use a CLI supporting the recorded contract; do not edit the record.`);
  }
  const recipe = Object.values(repairRecipes).find((entry) =>
    isRecord(value.recipe) && canonicalSha256(entry) === canonicalSha256(value.recipe));
  if (!recipe) {
    throw new Error('Unsupported repair recipe/layout identity; supported azure-local-layout v1 or application-layout-patch v1 with their exact registered layouts. Use a compatible CLI or request a new preview; do not retag history.');
  }
  return { cliVersion: value.cliVersion, repairContractVersion, recipe };
}

export const repairRecoveryCompatibility = [
  { journalSchemaVersion: 1, repairContractVersion: null, recipe: 'legacy-unversioned', recoveryOnly: true },
  ...Object.values(repairRecipes).map((recipe) => ({
    journalSchemaVersion: repairSchemaVersions.journal, repairContractVersion,
    recipe: recipe.id, recipeVersion: recipe.version, recoveryOnly: true
  }))
] as const;
