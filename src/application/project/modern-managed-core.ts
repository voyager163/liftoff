import { createHash } from 'node:crypto';
import type { GeneratedArtifact } from '../../domain/project/contracts.js';
import { manifestActiveLayoutDigest } from '../../domain/project/manifest/layout.js';
import { canonicalJson } from '../../domain/governance/activation/canonical-json.js';
import { renderModernCredentialPolicySchema } from '../../domain/governance/activation/credential-policy-schema.js';
import { createModernGovernanceContextContract } from '../../domain/governance/policy/modern-context.js';
import { assertGovernanceContentSafe } from '../../domain/governance/policy/policy-contract.js';
import { governanceAgentIntegrations } from '../../domain/project/catalog.js';
import { createModernCompatibilityContract } from '../../governance-activation/modern-compatibility.js';
import { renderModernGovernanceGuide, renderModernGovernanceIntegration } from '../../generators/governance/modern-handoff.js';
import { projectCatalog } from './catalog.js';
import { resolveModernManifestV8SourceContract } from './manifest.js';
import { modernSourceRegistry } from './modern-plugins.js';
import { resolveModernProjectSourceContext, type ModernProjectSourceInput } from './source-context.js';

export type ModernManagedCoreInput = ModernProjectSourceInput;

export type ModernManagedCoreArtifact = Readonly<Pick<GeneratedArtifact, 'logicalName' | 'category' | 'content'>> & {
  readonly lifecycle: 'managed-core';
  readonly pathParts: readonly string[];
};

export function resolveModernManagedCoreInput(value: unknown) {
  return resolveModernProjectSourceContext(value);
}

/** Produces source-only managed content. No framework tools, project writes, credentials or providers are invoked. */
export function buildModernManagedCore(value: unknown): readonly ModernManagedCoreArtifact[] {
  const { selection, plugins, activeLayout, source } = resolveModernManagedCoreInput(value);
  const leaf = selection, profile = selection.profile;
  const contentByName = new Map<string, string>();
  const contracts = { catalog: projectCatalog, resolveSourceContract: resolveModernManifestV8SourceContract };
  if (profile !== 'none') {
    if (!('identity' in source.governanceSource)) throw new Error('Enabled managed core requires a real governance source.');
    const requested = { selection: { ...leaf, profile }, plugins, activeLayout };
    const contexts = createModernGovernanceContextContract(contracts);
    const context = contexts.validateModernGovernanceContext(contexts.buildModernGovernanceContext(requested));
    const compatibility = createModernCompatibilityContract(contracts).buildModernCompatibilityMetadataForSource(requested);
    if (canonicalJson(compatibility.activation.targetIdentity) !== canonicalJson(context.governance.activationIdentity)) {
      throw new Error('Managed context and compatibility disagree on the actual source identity.');
    }
    const policyAsset = profile === 'single-maintainer-gitflow' ? 'modern-single-maintainer-policy' : 'modern-team-policy';
    const policy = modernSourceRegistry().assetsFor({ kind: 'core' }).own[policyAsset];
    if (typeof policy !== 'string' ||
      `sha256:${createHash('sha256').update(policy, 'utf8').digest('hex')}` !== source.governanceSource.identity.policyDigest) {
      throw new Error('Verified modern policy bytes are unavailable or differ from the exact source.');
    }
    contentByName.set('repository-governance-policy', policy);
    contentByName.set('repository-governance-context', canonicalJson(context));
    contentByName.set('repository-governance-guide', renderModernGovernanceGuide(context, source.governanceSource.graph));
    contentByName.set('repository-governance-phase-graph', canonicalJson(source.governanceSource.graph));
    contentByName.set('repository-governance-compatibility', canonicalJson(compatibility));
    contentByName.set('repository-governance-credential-policy-schema', renderModernCredentialPolicySchema(projectCatalog, {
      recordedIdentity: context.governance.activationIdentity, profile, policyVersion: context.governance.policyVersion,
      selection: { ...leaf, profile }, pluginResolutionDigest: plugins.resolutionDigest,
      activeLayoutDigest: manifestActiveLayoutDigest(activeLayout, source.layoutDescriptor)
    }));
  }
  for (const agent of leaf.project.agents) {
    for (const operation of profile === 'none' ? ['repair'] as const : ['setup', 'assessment', 'repair'] as const) {
      const integration = governanceAgentIntegrations[agent][operation];
      contentByName.set(integration.logicalName, renderModernGovernanceIntegration(agent, operation, selection));
    }
  }
  if (contentByName.size !== source.managedArtifacts.length) {
    throw new Error('Modern managed content does not match the exact selected source inventory.');
  }
  return Object.freeze(source.managedArtifacts.map((identity): ModernManagedCoreArtifact => {
    const content = contentByName.get(identity.logicalName);
    if (content === undefined) throw new Error(`No modern managed producer for ${identity.logicalName}.`);
    assertGovernanceContentSafe(content);
    return Object.freeze({
      logicalName: identity.logicalName, category: identity.category, lifecycle: 'managed-core',
      pathParts: Object.freeze([...identity.pathParts]), content
    });
  }));
}
