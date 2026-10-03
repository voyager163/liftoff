import { packagedSkillSource } from '../../adapters/packaged-assets/skill-sources.js';
import { governanceAgentIntegrations } from '../../domain/project/catalog.js';
import type { CodingAgentId } from '../../domain/project/contracts.js';
import { repairContractVersion, repairRecipes, repairSchemaVersions } from '../../domain/repair/identity.js';

export function nativeIntegrationHeader(agent: CodingAgentId, operation: 'setup' | 'assessment' | 'repair'): string {
  const integration = governanceAgentIntegrations[agent];
  const skillName = operation === 'assessment' ? 'liftoff-governance-assess' : `liftoff-${operation}`;
  const description = operation === 'setup'
    ? 'Guide local readiness and separately approved repair, migration and activation.'
    : operation === 'assessment'
      ? 'Explain the Liftoff governance assessment without executing repairs, activation, or other mutations.'
      : 'Guide capability-checked project repair with staged verification and separate file approval.';
  const metadata = integration.kind === 'skill'
    ? `---\nname: ${skillName}\ndescription: ${JSON.stringify(description)}\n---\n\n`
    : '';
  return `${metadata}# ${integration[operation].invocation}\n`;
}

export function renderRepairIntegration(agent: CodingAgentId): string {
  return `${nativeIntegrationHeader(agent, 'repair')}${renderRepairInstructions()}`;
}

export function renderRepairInstructions(): string {
  let text = packagedSkillSource('repair');
  const substitutions = {
    capabilitiesSchema: repairSchemaVersions.capabilities,
    repairContract: repairContractVersion,
    reportSchema: repairSchemaVersions.report,
    inventorySchema: repairSchemaVersions.applicationInventory,
    patchSchema: repairSchemaVersions.applicationPatch,
    azureRecipe: repairRecipes['azure-local-layout'].id,
    azureRecipeVersion: repairRecipes['azure-local-layout'].version,
    applicationRecipe: repairRecipes['application-layout-patch'].id,
    applicationRecipeVersion: repairRecipes['application-layout-patch'].version
  };
  for (const [name, value] of Object.entries(substitutions)) {
    const token = `{{${name}}}`;
    if (!text.includes(token)) throw new Error(`Packaged repair skill is missing its ${name} placeholder.`);
    text = text.replaceAll(token, String(value));
  }
  if (/\{\{|\}\}/u.test(text)) throw new Error('Packaged repair skill contains an unknown or malformed placeholder.');
  return `\n${text}`;
}

export function renderSetupIntegration(agent: CodingAgentId): string {
  return `${nativeIntegrationHeader(agent, 'setup')}\n${packagedSkillSource('setup')}`;
}

export function renderAssessmentIntegration(agent: CodingAgentId): string {
  return `${nativeIntegrationHeader(agent, 'assessment')}\n${packagedSkillSource('governance-assessment')}`;
}
