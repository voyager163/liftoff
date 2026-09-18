import { describe, expect, it } from 'vitest';
import {
  buildPublicCapabilitiesEnvelope,
  getRegisteredCapabilities,
  getRegisteredEngines,
  resolveCapability,
  resolveEngine
} from '../src/application/engine-composition.js';
import {
  canonicalEngines,
  engineIds,
  engineOwners
} from '../src/domain/execution/engines.js';
import { validatePublicCapabilitiesEnvelope } from '../src/protocol/capabilities.js';
import { liftoffVersion } from '../src/version.js';
import * as azureModule from '../src/application/azure-activation/index.js';
import * as repositoryModule from '../src/application/repository-governance/index.js';
import { azureActivationCapabilities } from '../src/application/azure-activation/capabilities.js';
import { repositoryGovernanceCapabilities } from '../src/application/repository-governance/capabilities.js';
import { SUPPORTED_STANDARDS_PROFILE_IDS } from '../src/domain/standards/profile-schema.js';

describe('Six Engine Module Boundaries and Composition Root (Task 4.1 & 4.5)', () => {
  it('uses the same canonical descriptors through engine barrels and public registration', () => {
    expect(azureModule.azureActivationCapabilities).toBe(azureActivationCapabilities);
    expect(repositoryModule.repositoryGovernanceCapabilities).toBe(repositoryGovernanceCapabilities);
    for (const capability of [
      ...azureModule.azureActivationCapabilities,
      ...repositoryModule.repositoryGovernanceCapabilities
    ]) {
      expect(resolveCapability(capability.id)).toBe(capability);
    }
    expect(azureModule.azureActivationCapabilities[0].supportedProfiles)
      .toEqual(SUPPORTED_STANDARDS_PROFILE_IDS.filter((profile) => profile !== 'vue-component'));
    const assessment = repositoryModule.repositoryGovernanceCapabilities.find((capability) =>
      capability.id === 'governance-assessment');
    expect(assessment).toMatchObject({
      qualificationState: 'unqualified',
      authorization: { automationFlags: ['--live'] },
      effectClasses: ['filesystem-read', 'network-read']
    });
  });

  it('registers exactly six capability engines and no seventh execution engine', () => {
    const engines = getRegisteredEngines();
    expect(engines).toHaveLength(6);
    expect(engines.map((e) => e.id)).toEqual(engineIds);
    expect(engines.map((e) => e.owner)).toEqual(engineOwners);

    // Verify there is no 'execution-kernel' engine
    expect(engines.some((e) => e.id === ('execution-kernel' as any))).toBe(false);
    expect(engines.some((e) => e.owner === ('Execution Kernel' as any))).toBe(false);

    // Each engine has an explicit application ownership module
    for (const engine of engines) {
      expect(engine.applicationModule).toMatch(/^application\//);
      expect(engine.title).toBeDefined();
      expect(engine.description).toBeDefined();
    }
  });

  it('builds a valid Schema 1 public capabilities envelope', () => {
    const envelope = buildPublicCapabilitiesEnvelope();
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.kind).toBe('liftoff-public-capabilities');
    expect(envelope.cliVersion).toBe(liftoffVersion);
    expect(envelope.engines).toHaveLength(6);
    expect(envelope.capabilities.length).toBeGreaterThanOrEqual(6);

    // Envelope validates cleanly against strict Schema 1 rules
    expect(validatePublicCapabilitiesEnvelope(envelope)).toEqual(envelope);
  });

  it('binds every registered capability to one of the six engine owners', () => {
    const capabilities = getRegisteredCapabilities();
    for (const cap of capabilities) {
      expect(engineIds).toContain(cap.engine);
      expect(engineOwners).toContain(cap.owner);
      expect(cap.owner).toBe(canonicalEngines[cap.engine].owner);
      expect(cap.schemaVersion).toBe(1);
      expect(cap.commandSchema).toBeDefined();
      expect(cap.commandSchema.resultSchemaVersion).toBeDefined();
    }
  });

  it('resolves capability by id for all lifecycle domains', () => {
    // Standards and Assessment
    const assess = resolveCapability('standards-assessment');
    expect(assess).toBeDefined();
    expect(assess?.engine).toBe('standards-assessment');
    expect(assess?.readOnly).toBe(true);

    // Project Generation
    const gen = resolveCapability('project-generation');
    expect(gen).toBeDefined();
    expect(gen?.engine).toBe('project-generation');

    // Project Evolution
    const update = resolveCapability('project-update');
    expect(update).toBeDefined();
    expect(update?.engine).toBe('project-evolution');
    expect(update?.commandSchema.resultSchemaVersion).toBe(3);

    const repair = resolveCapability('project-repair');
    expect(repair).toBeDefined();
    expect(repair?.engine).toBe('project-evolution');
    expect(repair?.commandSchema.resultSchemaVersion).toBe(2);
    expect(repair?.commandSchema.contractVersion).toBe(1);

    // Repository Governance
    const gov = resolveCapability('repository-governance');
    expect(gov).toBeDefined();
    expect(gov?.engine).toBe('repository-governance');

    // Azure Activation
    const azure = resolveCapability('azure-activation');
    expect(azure).toBeDefined();
    expect(azure?.engine).toBe('azure-activation');

    // Distribution and CLI Upgrade
    const upgrade = resolveCapability('cli-upgrade');
    expect(upgrade).toBeDefined();
    expect(upgrade?.engine).toBe('distribution');
    expect(upgrade?.authorization.mechanism).toBe('command-invocation');
  });

  it('resolves engine descriptor by engine id', () => {
    for (const id of engineIds) {
      const engine = resolveEngine(id);
      expect(engine).toBeDefined();
      expect(engine?.id).toBe(id);
      expect(engine?.owner).toBe(canonicalEngines[id].owner);
    }
  });

  it('exposes all 35 canonical activation phases without filtering and preserves unqualified distinctions', async () => {
    const { phaseCapabilities } = await import('../src/application/engine-composition.js');
    const phaseNames = Object.keys(phaseCapabilities);
    expect(phaseNames).toHaveLength(35);

    // 6 dedicated repository phases
    const repoPhases = [
      'repository-discovered',
      'repository-workflow-source-ready',
      'repository-checks-qualified',
      'repository-enforcement-approved',
      'repository-rulesets-applied',
      'repository-live-readback'
    ];
    for (const p of repoPhases) {
      expect(phaseNames).toContain(p);
    }

    // Built-in phases are marked unqualified (not qualified merely because released predecessors existed)
    expect(phaseCapabilities['committed'].qualification).toBe('unqualified');
    expect(phaseCapabilities['pushed'].qualification).toBe('unqualified');
    expect(phaseCapabilities['remote-ready'].qualification).toBe('unqualified');

    // Local seeds are marked local-regression (not release-qualified)
    expect(phaseCapabilities['seed-valid'].qualification).toBe('local-regression');

    // Gaps are marked implementation-missing
    expect(phaseCapabilities['credential-ready'].blockerKind).toBe('implementation-missing');
  });
});
