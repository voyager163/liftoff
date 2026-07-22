import { describe, expect, it } from 'vitest';
import { apiStacks, getApiStack, getDefaultRegion, patterns, projectTypes, providers, resolveRegion, searchRegions } from '../src/catalogs.js';

describe('catalogs', () => {
  it('defines all eight GenAI patterns with scaffold status', () => {
    expect(patterns.map((pattern) => pattern.id)).toEqual([
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
  });

  it('marks Azure available and AWS/GCP planned', () => {
    expect(providers.find((provider) => provider.id === 'azure')?.status).toBe('available');
    expect(providers.find((provider) => provider.id === 'aws')?.status).toBe('planned');
    expect(providers.find((provider) => provider.id === 'gcp')?.status).toBe('planned');
  });

  it('defines explicit project types and approved API stack aliases', () => {
    expect(projectTypes.map((projectType) => projectType.id)).toEqual(['genai', 'standard']);
    expect(apiStacks.map((stack) => stack.id)).toEqual(['python-fastapi', 'node-fastify', 'go-huma']);
    expect(getApiStack('nodejs')?.id).toBe('node-fastify');
    expect(getApiStack('golang')?.id).toBe('go-huma');
    expect(getApiStack('fastapi')?.id).toBe('python-fastapi');
  });

  it('defaults Azure to East US', () => {
    expect(getDefaultRegion('azure').slug).toBe('eastus');
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
});