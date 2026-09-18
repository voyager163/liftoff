import { readFile } from 'node:fs/promises';
import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';
import * as transitions from '../src/governance-activation/transitions.js';
import * as planning from '../src/governance-activation/transition-planning.js';
import * as records from '../src/governance-activation/transition-records.js';
import * as operations from '../src/domain/governance/activation/operations.js';
import { phaseCapabilities } from '../src/domain/governance/activation/capabilities.js';
import * as validators from '../src/domain/governance/activation/validators.js';
import * as stateContracts from '../src/domain/governance/activation/validation/state.js';
import * as evidenceContracts from '../src/domain/governance/activation/validation/evidence.js';
import * as graphContracts from '../src/domain/governance/activation/validation/graph.js';
import * as governanceFacade from '../src/repository-governance.js';
import * as governanceArtifacts from '../src/application/repository-governance/artifacts.js';
import * as policyRendering from '../src/application/repository-governance/policy-rendering.js';

describe('activation orchestration boundaries', () => {
  it('preserves public planning, record-path and rollback exports as direct aliases', () => {
    expect(transitions.buildSavedTransitionPlan).toBe(planning.buildSavedTransitionPlan);
    expect(transitions.previewApplyNext).toBe(planning.previewApplyNext);
    expect(transitions.transitionPlanPathParts).toBe(records.transitionPlanPathParts);
    expect(transitions.governancePlanDirectoryPathParts).toBe(records.governancePlanDirectoryPathParts);
    expect(transitions.rollbackPlanFromCompletedOperations).toBe(operations.rollbackPlanFromCompletedOperations);
    expect(transitions.planDigestFor).toBe(operations.planDigestFor);
  });

  it('preserves facades over coherent validation and rendering families', () => {
    expect(validators.validateUserActivationState).toBe(stateContracts.validateUserActivationState);
    expect(validators.validateEvidenceHeader).toBe(evidenceContracts.validateEvidenceHeader);
    expect(validators.validateManagedPhaseGraph).toBe(graphContracts.validateManagedPhaseGraph);
    expect(governanceFacade.buildRepositoryGovernanceArtifacts).toBe(governanceArtifacts.buildRepositoryGovernanceArtifacts);
    expect(governanceFacade.renderCanonicalGovernancePolicy).toBe(policyRendering.renderCanonicalGovernancePolicy);
  });

  it('separates inspection and verification from CLI presentation and argument parsing', async () => {
    for (const file of ['inspection', 'verification', 'reporting', 'continuation']) {
      const source = await readFile(`src/application/repository-governance/${file}.ts`, 'utf8');
      const ast = parseAst(source, { lang: 'ts' }, file) as any;
      const imports = ast.body.filter((node: any) => node.type === 'ImportDeclaration').map((node: any) => node.source.value);
      expect(imports.some((value: string) => value.includes('/cli/') || value.endsWith('/terminal.js') ||
        value.endsWith('/repository-governance.js'))).toBe(false);
      expect(source).not.toMatch(/rawStdout|presentation\.status/);
    }
    const coordinator = await readFile('src/governance-activation/commands.ts', 'utf8');
    expect(coordinator).not.toMatch(/function (?:inspectGovernance|verifyChecks|validateStateEvidence|renderStatusHuman)\b/);
  });

  it('assembles the declared executors without retaining their implementations or raw file mutations', async () => {
    const source = await readFile('src/governance-activation/transitions.ts', 'utf8');
    const ast = parseAst(source, { lang: 'ts' }, 'transitions.ts') as any;
    const declarations = ast.body.map((node: any) => node.declaration ?? node);
    const functions = declarations.filter((node: any) => node.type === 'FunctionDeclaration').map((node: any) => node.id.name);
    for (const handler of [
      'executeSeedOperations', 'gitCommitOperations', 'gitPushOperations', 'executeGitOperations',
      'discoverPhase0', 'executeActivationApproval', 'executeCredentialReady', 'executeRulesetPhase',
      'remoteImportRetention', 'executeBootstrapStateDisposal', 'saveTransitionPlan', 'writeOutcomeTransaction'
    ]) expect(functions).not.toContain(handler);
    const imports = ast.body.filter((node: any) => node.type === 'ImportDeclaration').map((node: any) => node.source.value);
    expect(imports.some((value: string) => value.startsWith('node:fs') ||
      /adapters\/filesystem\/(?:project-files|project-transaction|project-paths)/.test(value))).toBe(false);
    const registry = declarations.flatMap((node: any) => node.declarations ?? [])
      .find((node: any) => node.id.name === 'builtInExecutors');
    const registered = registry.init.properties.map((entry: any) => entry.key.name ?? entry.key.value).sort();
    const declared = Object.entries(phaseCapabilities).filter(([, capability]) => capability.executor !== 'unavailable')
      .map(([phase]) => phase).sort();
    expect(registered).toEqual(declared);
  });

  it('keeps actual handler families independent of the orchestration module', async () => {
    for (const [file, definitions] of [
      ['phase-publication', ['gitCommitOperations', 'gitPushOperations', 'executeGitOperations']],
      ['phase-governance', ['executeActivationApproval', 'executeCredentialReady', 'executeRulesetPhase']],
      ['phase-bootstrap-state', ['remoteImportRetention', 'executeBootstrapStateDisposal']],
      ['seed-lifecycle', ['executeSeedOperations', 'runSeedBaselineChecks', 'archiveGeneratedSeedForPhase']]
    ] as const) {
      const source = await readFile(`src/governance-activation/${file}.ts`, 'utf8');
      const ast = parseAst(source, { lang: 'ts' }, file) as any;
      const functions = ast.body.map((node: any) => node.declaration ?? node)
        .filter((node: any) => node.type === 'FunctionDeclaration').map((node: any) => node.id.name);
      expect(functions).toEqual(expect.arrayContaining([...definitions]));
      expect(ast.body.some((node: any) => node.type === 'ImportDeclaration' && node.source.value === './transitions.js')).toBe(false);
    }
    const discoveryFacade = await import('../src/governance-activation/phase-discovery.js');
    const azureDiscovery = await import('../src/application/azure-activation/producer-full-discovery.js');
    expect(discoveryFacade.discoverPhase0).toBe(azureDiscovery.discoverPhase0);
  });
});
