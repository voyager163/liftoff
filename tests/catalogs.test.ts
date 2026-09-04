import { describe, expect, it } from 'vitest';
import {
  apiStacks,
  canonicalDefaultEnvironmentIds,
  canonicalDefaultEnvironments,
  canonicalizeCodingAgents,
  codingAgents,
  environments,
  frameworkDefinitions,
  governanceProfiles,
  getGovernanceProfile,
  getApiStack,
  getDefaultRegion,
  getEnvironment,
  patterns,
  projectTypes,
  providers,
  resolveRegion,
  searchRegions
} from '../src/catalogs.js';
import { workstationRequirementCatalog } from '../src/workstation-catalog.js';

describe('catalogs', () => {
  it('defines all nine GenAI patterns with generic first', () => {
    expect(patterns.map((pattern) => pattern.id)).toEqual([
      'generic',
      'rag',
      'chatbot',
      'agent',
      'prompt',
      'multi-agent',
      'fine-tuned',
      'streaming',
      'workflow'
    ]);
    expect(patterns.every((pattern) => pattern.scaffoldStatus)).toBe(true);
    expect(patterns[0]).toMatchObject({
      id: 'generic',
      label: 'Generic GenAI Starter',
      aliases: ['generic', 'undecided', 'unsure', 'not-sure'],
      scaffoldStatus: 'foundation',
      routePrefix: '/api/ai',
      worker: false
    });
  });

  it('marks Azure available and AWS/GCP planned', () => {
    expect(providers.find((provider) => provider.id === 'azure')?.status).toBe('available');
    expect(providers.find((provider) => provider.id === 'aws')?.status).toBe('planned');
    expect(providers.find((provider) => provider.id === 'gcp')?.status).toBe('planned');
  });

  it('defines explicit project types and approved API stack aliases', () => {
    expect(projectTypes.map((projectType) => projectType.id)).toEqual([
      'genai',
      'standard',
      'power-apps-code-app'
    ]);
    expect(apiStacks.map((stack) => stack.id)).toEqual(['python-fastapi', 'node-fastify', 'go-huma']);
    expect(getApiStack('nodejs')?.id).toBe('node-fastify');
    expect(getApiStack('golang')?.id).toBe('go-huma');
    expect(getApiStack('fastapi')?.id).toBe('python-fastapi');
  });

  it('defaults Azure to East US', () => {
    expect(getDefaultRegion('azure').slug).toBe('eastus');
  });

  it('defines the supported deployment environments in canonical order', () => {
    expect(environments.map((environment) => environment.id)).toEqual(['dev', 'staging', 'prod']);
    expect(getEnvironment('test')).toBeUndefined();
    expect(canonicalDefaultEnvironmentIds).toEqual(['dev', 'staging', 'prod']);
    expect(canonicalDefaultEnvironments.map((environment) => environment.id)).toEqual(['dev', 'staging', 'prod']);
  });

  it('disambiguates natural Korea region input', () => {
    const result = resolveRegion('azure', 'korea');
    expect(result.status).toBe('ambiguous');
    if (result.status === 'ambiguous') {
      expect(result.matches.map((region) => region.slug)).toEqual(['koreacentral', 'koreasouth']);
    }
  });

  it('searches regions by human-friendly aliases', () => {
    expect(searchRegions('azure', 'seoul').map((region) => region.slug)).toEqual(['koreacentral']);
  });

  it('canonicalizes multi-agent aliases in stable catalog order', () => {
    expect(codingAgents.map((agent) => agent.id)).toEqual(['github-copilot', 'claude']);
    expect(canonicalizeCodingAgents(['claude-code', 'copilot', 'claude']).agents.map((agent) => agent.id))
      .toEqual(['github-copilot', 'claude']);
  });

  it('keeps append-only repository governance profiles with the enabled default', () => {
    expect(governanceProfiles.map((profile) => profile.id)).toEqual([
      'single-maintainer-gitflow',
      'none'
    ]);
    expect(governanceProfiles.find((profile) => profile.default)).toMatchObject({
      id: 'single-maintainer-gitflow',
      policyVersion: '6'
    });
    expect(getGovernanceProfile('Single Maintainer GitFlow')?.id)
      .toBe('single-maintainer-gitflow');
    expect(getGovernanceProfile('none')?.id).toBe('none');
  });

  it('pins the tested framework contracts and generated markers', () => {
    expect(frameworkDefinitions.openspec.version).toBe('1.11.0');
    expect(frameworkDefinitions['spec-kit'].version).toBe('1.0.1');
    expect(frameworkDefinitions.openspec.agentMarkers.claude[0]).toEqual([
      '.claude', 'skills', 'openspec-apply-change', 'SKILL.md'
    ]);
    expect(frameworkDefinitions['spec-kit'].baseMarkers).toContainEqual(['.specify', 'integration.json']);
  });

  it('centralizes platform installers and runtime floors', () => {
    expect(workstationRequirementCatalog.node.minimumVersion).toBe('24.20.0');
    expect(workstationRequirementCatalog.python.minimumVersion).toBe('3.14.0');
    expect(workstationRequirementCatalog.openspec.install.linux?.manager).toBe('npm');
    expect(workstationRequirementCatalog['spec-kit'].install.linux?.manager).toBe('uv');
    expect(workstationRequirementCatalog.claude.install.win32?.command.args).toContain('Anthropic.ClaudeCode');
  });
});