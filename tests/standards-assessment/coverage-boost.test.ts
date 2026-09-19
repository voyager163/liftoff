import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  INVENTORY_CATEGORIES,
  type AssessmentFinding,
  type AssessmentInventory,
  type AssessmentTarget,
  type StandardsProfileIdentity
} from '../../src/domain/standards-assessment/types.js';
import {
  standardsAssessmentCapabilities,
  standardsAssessmentEngine
} from '../../src/application/standards-assessment/capabilities.js';
import {
  getRuleDefinition,
  normalizeRuleId,
  STANDARDS_RULES
} from '../../src/domain/standards-assessment/rules.js';
import {
  evaluateRule,
  evaluateProfileRules
} from '../../src/domain/standards-assessment/evaluation.js';
import {
  calculateCoverage,
  determineOutcomeAndExitCode
} from '../../src/domain/standards-assessment/outcomes.js';
import {
  canonicalValue,
  computeInventoryDigest,
  containsSensitiveText,
  isRecord,
  sanitizeText
} from '../../src/domain/standards-assessment/sanitizer.js';
import {
  assessProject
} from '../../src/application/standards-assessment/runner.js';
import {
  generateRecommendations
} from '../../src/application/standards-assessment/recommendations.js';
import {
  assessCommand,
  runAssess
} from '../../src/cli/commands/assess.js';
import { PresentationSession } from '../../src/terminal.js';
import type { ExecutionContext } from '../../src/application/context.js';
import type { ParsedArgs } from '../../src/domain/project/contracts.js';
import { listSupportedProfiles } from '../../src/domain/standards-assessment/catalog.js';
import { loadPackagedProfilesCatalog } from '../../src/adapters/packaged-assets/resource-catalog.js';

const fixtureDirs: string[] = [];

function createFixtureDir(prefix: string): string {
  const dir = path.resolve(process.cwd(), 'tests', `.cov-fixture-${prefix}-${randomUUID()}`);
  fixtureDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of fixtureDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function createMockContext(cwd: string, jsonMode = false) {
  let stdoutData = '';
  let stderrData = '';

  const stdout = {
    write: (chunk: string | Buffer) => {
      stdoutData += chunk.toString();
      return true;
    }
  } as unknown as NodeJS.WritableStream;

  const stderr = {
    write: (chunk: string | Buffer) => {
      stderrData += chunk.toString();
      return true;
    }
  } as unknown as NodeJS.WritableStream;

  const presentation = new PresentationSession({
    stdout,
    stderr,
    json: jsonMode
  });

  const context: ExecutionContext = {
    cwd,
    env: {},
    stdout,
    stderr,
    presentation
  };

  return { context, getStdout: () => stdoutData, getStderr: () => stderrData };
}

describe('standards assessment comprehensive failure and edge case coverage', () => {
  it('covers capabilities constants and inventory categories array', () => {
    expect(INVENTORY_CATEGORIES.length).toBe(13);
    expect(standardsAssessmentEngine.id).toBe('standards-assessment');
    expect(standardsAssessmentCapabilities.length).toBe(1);
    expect(standardsAssessmentCapabilities[0].id).toBe('standards-assessment');
    expect(standardsAssessmentCapabilities[0].readOnly).toBe(true);
  });

  it('covers rule ID normalization and rule definitions for all variants', () => {
    expect(normalizeRuleId('RULE-FRONTEND-PACKAGE')).toBe('STD-DEP-LOCK');
    expect(normalizeRuleId('RULE-FRONTEND-ENTRY')).toBe('STD-FRONTEND-ENTRY');
    expect(normalizeRuleId('RULE-FRONTEND-BUILD')).toBe('STD-FRONTEND-BUILD');
    expect(normalizeRuleId('RULE-API-HEALTH')).toBe('STD-API-HEALTH');
    expect(normalizeRuleId('CUSTOM-RULE')).toBe('CUSTOM-RULE');

    expect(getRuleDefinition('RULE-FRONTEND-ENTRY')).toBeDefined();
    expect(getRuleDefinition('RULE-FRONTEND-BUILD')).toBeDefined();
    expect(getRuleDefinition('NON_EXISTENT_RULE')).toBeUndefined();
    expect(STANDARDS_RULES.length).toBeGreaterThan(5);
  });

  it('covers evaluation branches for frontend entry and build rules', () => {
    const profile = listSupportedProfiles(loadPackagedProfilesCatalog()).find((p) => p.id === 'vue-component')!;
    const target: AssessmentTarget = {
      targetPath: '/test',
      projectRoot: '/test',
      repositoryRoot: null,
      componentPath: null,
      scanRoot: '/test',
      hasGit: false,
      hasManifest: false,
      manifestVersion: null
    };

    const emptyInventory: AssessmentInventory = {
      summary: { totalFiles: 0, totalBytes: 0, byCategory: { source: 0, declarations: 0, locks: 0, tests: 0, build: 0, config: 0, docs: 0, containers: 0, infrastructure: 0, workflows: 0, framework: 0, agent: 0, provenance: 0 } },
      files: [],
      unobserved: [],
      limits: { maxFiles: 5000, maxFileSize: 2000000, maxDepth: 15, exceeded: false },
      protectedExclusions: []
    };

    const entryRule = getRuleDefinition('STD-FRONTEND-ENTRY')!;
    const buildRule = getRuleDefinition('STD-FRONTEND-BUILD')!;

    // Missing case
    const missingEntry = evaluateRule(entryRule, profile, target, emptyInventory, {});
    expect(missingEntry.classification).toBe('missing');

    const missingBuild = evaluateRule(buildRule, profile, target, emptyInventory, {});
    expect(missingBuild.classification).toBe('missing');

    // Filenames without captured source and valid evidence are not conformance.
    const presentInventory: AssessmentInventory = {
      ...emptyInventory,
      files: [
        { path: 'src/App.vue', category: 'source', size: 100, digest: 'abc', modifiedTime: '2026-09-15T00:00:00Z' },
        { path: 'src/main.ts', category: 'source', size: 100, digest: 'def', modifiedTime: '2026-09-15T00:00:00Z' },
        { path: 'vite.config.ts', category: 'build', size: 100, digest: 'ghi', modifiedTime: '2026-09-15T00:00:00Z' }
      ]
    };

    const uncapturedEntry = evaluateRule(entryRule, profile, target, presentInventory, {});
    expect(uncapturedEntry.classification).toBe('unknown');

    const uncapturedBuild = evaluateRule(buildRule, profile, target, presentInventory, {});
    expect(uncapturedBuild.classification).toBe('unknown');

    // Unknown evaluator case
    const fakeRule = { ...entryRule, id: 'STD-UNKNOWN-EVALUATOR' };
    const unknownResult = evaluateRule(fakeRule, profile, target, presentInventory, {});
    expect(unknownResult.classification).toBe('unknown');

    // Backend-only rules remain inapplicable to the Vue component.
    const unobservedInventory: AssessmentInventory = {
      ...emptyInventory,
      unobserved: [
        { path: 'src/routes.ts', reason: 'permission_denied', message: 'EACCES' },
        { path: 'tests/unit.test.ts', reason: 'unreadable', message: 'IO error' }
      ]
    };
    const healthRule = getRuleDefinition('STD-API-HEALTH')!;
    const testRule = getRuleDefinition('STD-TEST-SUITE')!;
    expect(evaluateRule(healthRule, profile, target, unobservedInventory, {}).classification).toBe('inapplicable');
    expect(evaluateRule(testRule, profile, target, unobservedInventory, {}).classification).toBe('unknown');
  });

  it('covers evaluateProfileRules with unsupported and unresolved profile statuses', () => {
    const unsupportedProfile: StandardsProfileIdentity = {
      schemaVersion: 1,
      id: 'express',
      revision: 'none',
      digest: 'abc',
      name: 'Express',
      description: 'Unsupported',
      status: 'unsupported',
      declaredRuleCoverage: ['STD-API-HEALTH']
    };
    const target: AssessmentTarget = {
      targetPath: '/test',
      projectRoot: '/test',
      repositoryRoot: null,
      componentPath: null,
      hasGit: false,
      hasManifest: false,
      manifestVersion: null
    };
    const emptyInventory: AssessmentInventory = {
      summary: { totalFiles: 0, totalBytes: 0, byCategory: { source: 0, declarations: 0, locks: 0, tests: 0, build: 0, config: 0, docs: 0, containers: 0, infrastructure: 0, workflows: 0, framework: 0, agent: 0, provenance: 0 } },
      files: [],
      unobserved: [],
      limits: { maxFiles: 5000, maxFileSize: 2000000, maxDepth: 15, exceeded: false },
      protectedExclusions: []
    };

    const findings = evaluateProfileRules(unsupportedProfile, target, emptyInventory, {});
    expect(findings).toEqual([]);
  });

  it('covers coverage calculation with unsupported findings and outcome branches', () => {
    const profile = listSupportedProfiles(loadPackagedProfilesCatalog())[0];
    const findings: AssessmentFinding[] = [
      {
        ruleId: 'STD-DEP-LOCK',
        title: 'Lock',
        targetProfile: profile.id,
        scope: 'component',
        severity: 'error',
        classification: 'unsupported',
        expected: 'lock',
        observed: { facts: {}, references: [], limitations: [] }
      }
    ];

    const coverage = calculateCoverage(profile, findings);
    expect(coverage.unsupportedRules).toBe(1);

    // Fatal error diagnostic
    const errorOutcome = determineOutcomeAndExitCode(profile, coverage, [
      { code: 'FATAL', severity: 'error', message: 'fatal error' }
    ]);
    expect(errorOutcome.outcome).toBe('error');
    expect(errorOutcome.exitCode).toBe(1);

    // Unobserved scopes leading to exit 2
    const unobservedOutcome = determineOutcomeAndExitCode(profile, coverage, [], 1);
    expect(unobservedOutcome.outcome).toBe('differences');
    expect(unobservedOutcome.exitCode).toBe(2);
  });

  it('covers canonicalValue error handling for non-finite numbers and functions', () => {
    expect(() => canonicalValue(Infinity)).toThrow(/non-finite/);
    expect(() => canonicalValue(NaN)).toThrow(/non-finite/);
    expect(() => canonicalValue(() => {})).toThrow(/Canonical JSON cannot encode/);
    expect(() => canonicalValue({ invalid: undefined })).toThrow(/undefined field invalid/);
    expect(canonicalValue([1, 2, 'a', true, null])).toEqual([1, 2, 'a', true, null]);
    expect(canonicalValue({ b: 2, a: 1 })).toEqual({ a: 1, b: 2 });
    expect(canonicalValue(null)).toBeNull();
    expect(canonicalValue(true)).toBe(true);
    expect(canonicalValue(42)).toBe(42);
    expect(canonicalValue('str')).toBe('str');

    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord('str')).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it('covers recommendations with bound inputs and unresolved profiles', () => {
    const profile = listSupportedProfiles(loadPackagedProfilesCatalog())[0];
    const targetWithGit: AssessmentTarget = {
      targetPath: '/test/app',
      projectRoot: '/test',
      repositoryRoot: '/test',
      componentPath: 'app',
      scanRoot: '/test/app',
      hasGit: true,
      hasManifest: true,
      manifestVersion: 8
    };

    const repairableFinding: AssessmentFinding = {
      ruleId: 'RULE-API-DOCS',
      title: 'API documentation',
      targetProfile: profile.id,
      scope: 'component',
      severity: 'error',
      classification: 'missing',
      expected: 'Observed API schema route',
      observed: { facts: {}, references: [], limitations: ['Runtime schema response is unobserved.'] }
    };

    const recs = generateRecommendations({
      target: targetWithGit,
      profile,
      findings: [repairableFinding],
      inputsReference: path.resolve('inputs.json'),
      inputsDigest: 'sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
    });

    expect(recs.some((r) => r.capability === 'governance')).toBe(true);
    expect(recs.some((r) => r.capability === 'repair')).toBe(true);
    expect(recs.some((r) => r.capability === 'update')).toBe(true);
    for (const recommendation of recs) {
      expect(recommendation.status).toBe('blocked');
      expect(recommendation.executable).toBeNull();
      expect(recommendation.args).toEqual([]);
      expect(recommendation.continuation).toBeUndefined();
      expect(recommendation.inputs?.reference).toBe(path.resolve('inputs.json'));
      expect(recommendation.blockedReasons.some((reason) => reason.includes('--inputs'))).toBe(true);
    }

    const unresolvedProfile: StandardsProfileIdentity = {
      ...profile,
      status: 'unresolved'
    };
    expect(generateRecommendations({
      target: targetWithGit,
      profile: unresolvedProfile,
      findings: []
    })).toEqual([]);
  });

  it('handles inputs file read errors gracefully in assessProject', async () => {
    const result = await assessProject({
      inputsPath: '/non/existent/path/inputs.json'
    });
    expect(result.outcome).toBe('error');
    expect(result.exitCode).toBe(1);
    expect(result.diagnostics[0].code).toBe('INPUTS_FILE_ERROR');
  });

  it('renders human report with componentPath, diagnostics, unobserved scopes, and exit 1 outcome', async () => {
    const dir = createFixtureDir('human-report-coverage');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'liftoff.manifest.json'), '{ malformed json');

    const { context, getStdout } = createMockContext(dir, false);
    const parsed: ParsedArgs = {
      command: 'assess',
      flags: { component: 'sub' },
      positional: [dir]
    };

    const exitCode = await assessCommand(parsed, context);
    expect(exitCode).toBe(1);

    const stdout = getStdout();
    expect(stdout).toMatch(/assess/i);
    expect(stdout).toContain('Assessment Outcome');
    expect(stdout).toContain('Assessment error encountered');
  });

  it('covers runAssess with relative project flag, success report rendering, and error findings', async () => {
    const dir = createFixtureDir('assess-flags-coverage');
    await mkdir(path.join(dir, 'sub'), { recursive: true });
    await writeFile(path.join(dir, 'sub', 'package.json'), '{"name":"sub"}');
    await writeFile(path.join(dir, 'sub', '.env'), 'SECRET=123'); // protected exclusion

    const { context, getStdout } = createMockContext(dir, false);
    const { exitCode } = await runAssess({
      project: 'sub' // relative path
    }, context);
    expect(exitCode).toBe(2);

    const stdout = getStdout();
    expect(stdout).toMatch(/Target Boundaries/i);
    expect(stdout).toMatch(/Protected exclusions/i);
  });
});
