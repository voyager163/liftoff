import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/cli/args/parser.js';
import * as registry from '../src/application/engine-composition.js';
import { generateRecommendations } from '../src/application/standards-assessment/recommendations.js';
import { listSupportedProfiles } from '../src/domain/standards-assessment/catalog.js';
import { loadPackagedProfilesCatalog } from '../src/adapters/packaged-assets/resource-catalog.js';
import type { AssessmentTarget } from '../src/domain/standards-assessment/types.js';
import type { PublicCapabilityV1, QualificationState } from '../src/protocol/capabilities.js';

afterEach(() => vi.restoreAllMocks());

function context() {
  const projectRoot = path.resolve('tests', 'recommendation project');
  const cwd = path.resolve('tests', 'different invocation directory');
  const profile = listSupportedProfiles(loadPackagedProfilesCatalog()).find((entry) => entry.id === 'node-fastify');
  if (!profile) throw new Error('Expected the actual installed Fastify profile.');
  const target: AssessmentTarget = {
    targetPath: projectRoot, projectRoot, repositoryRoot: null, componentPath: null,
    scanRoot: projectRoot, hasGit: false, hasManifest: false, manifestVersion: null
  };
  return { target, profile, observedProfiles: [profile], findings: [], invocationCwd: cwd };
}

describe('assessment recommendations preserve actual operation context', () => {
  it('uses an absolute target and real schema identity rather than cwd-dependent or schema-1 placeholders', () => {
    const source = context();
    const recommendation = generateRecommendations(source)[0]!;
    const parsed = parseArgs(recommendation.args);
    expect(parsed).toMatchObject({
      command: 'adopt', flags: { project: source.target.projectRoot, profile: source.profile.id, check: true, json: true }
    });
    expect(recommendation.cwd).toBe(source.invocationCwd);
    expect(path.resolve(path.resolve('elsewhere'), String(parsed.flags.project))).toBe(source.target.projectRoot);
    expect(recommendation.compatibility).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(recommendation.continuation?.compatibilityIdentity).toBe(recommendation.compatibility);
    expect(recommendation.commandSchema).toEqual(registry.resolveCapability('project-adoption')?.commandSchema);
    expect(recommendation.capabilityId).toBe('project-adoption');
  });

  it.each<QualificationState>([
    'qualified', 'unqualified', 'planner-only', 'implementation-missing', 'prerequisite-blocked'
  ])('retains the actual %s capability state without turning it into mutation permission', (qualificationState) => {
    const resolve = registry.resolveCapability;
    const base = resolve('project-adoption');
    if (!base) throw new Error('Expected registered adoption capability.');
    const capability: PublicCapabilityV1 = {
      ...base, qualificationState,
      executor: qualificationState === 'planner-only' || qualificationState === 'implementation-missing' ? 'unavailable' : 'built-in'
    };
    vi.spyOn(registry, 'resolveCapability').mockImplementation((id) => id === 'project-adoption' ? capability : resolve(id));
    const recommendation = generateRecommendations(context())[0]!;
    expect(recommendation.qualification).toBe(qualificationState);
    if (capability.executor === 'unavailable') {
      expect(recommendation).toMatchObject({ status: 'blocked', executable: null, args: [] });
      expect(recommendation.continuation).toBeUndefined();
      expect(recommendation.blockedReasons.join(' ')).toContain('executor is unavailable');
    } else {
      expect(recommendation.status).toBe(qualificationState === 'qualified' ? 'available' : 'plan-only');
      expect(parseArgs(recommendation.args).flags).toMatchObject({ check: true, json: true });
    }
    expect(recommendation.args).not.toContain('--approve-plan');
    expect(recommendation.args).not.toContain('--verify-plan');
  });

  it('retains captured inputs as blocked guidance rather than emitting a context-dropping command', () => {
    const source = context();
    const reference = path.resolve('public inputs.json');
    const digest = `sha256:${'a'.repeat(64)}`;
    const recommendation = generateRecommendations({ ...source, inputsReference: reference, inputsDigest: digest })[0]!;
    expect(recommendation).toMatchObject({
      status: 'blocked', executable: null, args: [], inputs: { reference, digest },
      cwd: source.invocationCwd, project: source.target.projectRoot
    });
    expect(recommendation.continuation).toBeUndefined();
    expect(recommendation.blockedReasons.join(' ')).toContain('cannot consume');
  });

  it('does not silently widen a selected component to a project-wide update', () => {
    const source = context();
    source.target = {
      ...source.target, hasManifest: true, manifestVersion: 8,
      componentPath: 'frontend', scanRoot: path.join(source.target.projectRoot, 'frontend')
    };
    const recommendation = generateRecommendations(source).find((entry) => entry.capabilityId === 'project-update')!;
    expect(recommendation.status).toBe('blocked');
    expect(recommendation.executable).toBeNull();
    expect(recommendation.continuation).toBeUndefined();
    expect(recommendation.blockedReasons.join(' ')).toContain('component boundary');
  });

  it('does not infer an adoption scope from multiple observed components', () => {
    const source = context();
    expect(generateRecommendations({
      ...source,
      observedProfiles: [
        { ...source.profile, componentRoot: 'first' },
        { ...source.profile, componentRoot: 'second' }
      ]
    }).some((entry) => entry.capabilityId === 'project-adoption')).toBe(false);
  });
});
