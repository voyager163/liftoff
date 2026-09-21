import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  adoptedBaseIdentity, canonicalDigest, evaluateAdmission, loadAdoptedBase,
  type AdoptedBaseHandle, type AdmissionObservation
} from '../scripts/repository-security/admission.ts';
import {
  assessDeclaredSecretSource, readIssuedSecretSource, type DeclaredSecretAssessment, type SecretSourceOccurrence
} from '../scripts/repository-security/gitleaks-source.ts';
import { fetchPinnedDerivedProfileSource } from '../scripts/repository-security/gitleaks-derived.ts';
import { installPinnedFixtureGitleaks, type PinnedFixtureTool } from '../scripts/repository-security/gitleaks.ts';
import {
  secretOccurrenceKey, bindSecretSourceAssessment, prepareReleaseSecretPayload
} from '../scripts/repository-security/secrets-admission.ts';
import { artifactHashes, type NpmCandidate } from '../scripts/repository-security/npm-release.ts';
import { type EvidenceIdentity } from '../scripts/repository-security/evidence.ts';
import { prepareAdoptedSecretProfile } from '../scripts/repository-security/secret-profile.ts';
import { createAdmissionGitFixture } from './fixtures/security-git.js';

const digest = `sha256:${'a'.repeat(64)}`;
const occurrence: SecretSourceOccurrence = {
  kind: 'current-tree', rule: 'pkcs12-file', pathParts: ['fixture with spaces.p12'], blob: 'a'.repeat(40),
  commit: 'b'.repeat(40), line: null, column: null, endLine: null, endColumn: null
};
const detector = { version: '8.30.1', binaryDigest: digest, configDigest: digest };

describe('secret finding comparison without provenance substitution', () => {
  it('preserves stable exact source identity while retaining different commit/scope occurrences separately', () => {
    const key = secretOccurrenceKey(occurrence, detector);
    expect(secretOccurrenceKey({ ...occurrence, kind: 'reachable-history', commit: 'c'.repeat(40) }, detector)).toBe(key);
    for (const changed of [
      { ...occurrence, blob: 'c'.repeat(40) }, { ...occurrence, pathParts: ['different.p12'] },
      { ...occurrence, rule: 'another-rule' }, { ...occurrence, line: 1, column: 1, endLine: 1, endColumn: 2 }
    ]) expect(secretOccurrenceKey(changed, detector)).not.toBe(key);
    expect(secretOccurrenceKey(occurrence, { ...detector, configDigest: `sha256:${'b'.repeat(64)}` })).not.toBe(key);
  });

  it('never accepts a serialized, candidate-authored or skipped producer as an issued scan', () => {
    // Deliberately invalid runtime inputs, not a substitute for native qualification.
    for (const result of [{}, { scans: [] }, { analysisComplete: true }, { approved: true }]) {
      expect(() => readIssuedSecretSource(result as DeclaredSecretAssessment)).toThrow('unissued-or-mutated-assessment');
    }
  });
});

it.runIf(process.env.LIFTOFF_REAL_GITLEAKS_ADMISSION_FIXTURE === '1')(
  'binds a real redacted scan to base-only fixture maintenance and fresh post-adoption normal evaluation',
  async () => {
    const parent = process.env.LIFTOFF_SECURITY_WORKSPACE_PARENT;
    if (!parent) throw new Error('Explicit registered external workspace parent required.');
    const fixture = await createAdmissionGitFixture();
    let tool: PinnedFixtureTool | undefined;
    try {
      tool = await installPinnedFixtureGitleaks(process.cwd(), parent);
      const upstreamProfile = await fetchPinnedDerivedProfileSource();
      const detectorRegistration = await readFile(path.join(process.cwd(), 'security', 'secret-detector.json'), 'utf8');
      const control = {
        schemaVersion: 1, repository: 'voyager163/liftoff',
        policyData: [{ id: 'secrets', adapter: 'secrets', pathParts: ['security', 'data.json'] }],
        controlInputs: [['validator.txt'], ['security', 'secret-detector.json']],
        validatorInputs: [['validator.txt']]
      };
      const files = {
        'validator.txt': 'Fixed nonfunctional validator fixture.\n',
        'fixture with spaces.p12': 'NONFUNCTIONAL_TEXT_NOT_A_PKCS12_CONTAINER\n',
        'security/control-plane.json': JSON.stringify(control),
        'security/data.json': '{"schemaVersion":1,"dispositions":[]}',
        'security/secret-detector.json': detectorRegistration
      };
      const baseCommit = await fixture.commit(files);
      const scan = async (sourceCommit: string, introducedBase?: string, executionIdentity?: EvidenceIdentity) => {
        const scope = { sourceCommit, refs: { 'refs/heads/fixture': sourceCommit } };
        if (!executionIdentity) {
          const anchor = introducedBase ?? sourceCommit;
          const base = await loadAdoptedBase(fixture.root, {
            repository: 'voyager163/liftoff', baseRef: 'develop', baseCommit: anchor, headCommit: sourceCommit, now: new Date()
          });
          const profile = await prepareAdoptedSecretProfile(base, upstreamProfile);
          executionIdentity = {
            repository: 'voyager163/liftoff', event: 'pull_request', sourceSha: sourceCommit,
            baseSha: anchor, workflowSha: anchor, runId: introducedBase ? '202' : '101', attempt: 1,
            policyDigest: adoptedBaseIdentity(base).policyDigest, inventoryDigest: canonicalDigest(scope),
            configurationDigest: canonicalDigest({
              detector: { version: tool!.version, binaryDigest: tool!.binaryDigest, configDigest: profile.configDigest },
              rules: profile.rules
            })
          };
        }
        return assessDeclaredSecretSource({
          repository: fixture.root, workspaceParent: parent, tool: tool!, upstreamProfile, scope, executionIdentity,
          ...(introducedBase ? { introducedBase } : {})
        });
      };
      const baseScan = await scan(baseCommit);
      const baseMetadata = readIssuedSecretSource(baseScan);
      expect(baseMetadata.occurrences.every(item => item.rule === 'pkcs12-file')).toBe(true);
      expect(baseMetadata.occurrences).toHaveLength(2);
      const scanner = {
        version: baseScan.tool.version, binaryDigest: baseScan.tool.binaryDigest,
        configDigest: baseScan.profile.configDigest
      };
      const findingKey = secretOccurrenceKey(baseMetadata.occurrences[0]!, scanner);
      const facts = [{ key: findingKey, confirmedUnremediated: false,
        evidenceDigests: [digest], verifiedRemediationDigests: [] }];
      const grant = {
        findingKey, state: 'nonfunctional-fixture', owner: 'voyager163',
        rationale: 'documented-nonfunctional-fixture', evidenceDigests: [digest], incidentHistory: []
      };
      const adoptedFiles = { ...files, 'security/data.json': JSON.stringify({ schemaVersion: 1, dispositions: [grant] }) };
      const headCommit = await fixture.commit(adoptedFiles);
      const headScan = await scan(headCommit, baseCommit);
      const base = await loadAdoptedBase(fixture.root, {
        repository: 'voyager163/liftoff', baseRef: 'develop', baseCommit, headCommit, now: new Date()
      });
      const options = (handle: AdoptedBaseHandle, side: 'base' | 'candidate', result: DeclaredSecretAssessment) => {
        const authority = adoptedBaseIdentity(handle), metadata = readIssuedSecretSource(result);
        return {
          base: handle, side, result, expectedReportDigest: metadata.reportDigest,
          expectedScope: result.scope, upstreamProfile, policyId: 'secrets', verifiedFacts: facts, now: new Date(),
          identity: {
            repository: 'voyager163/liftoff', event: 'pull_request' as const,
            sourceSha: result.scope.sourceCommit, baseSha: authority.baseCommit, workflowSha: authority.baseCommit,
            runId: side === 'base' ? '101' : '202', attempt: 1,
            policyDigest: authority.policyDigest, inventoryDigest: canonicalDigest(result.scope),
            configurationDigest: canonicalDigest({ detector: scanner, rules: metadata.rules })
          }
        };
      };
      const baseOptions = options(base, 'base', baseScan), headOptions = options(base, 'candidate', headScan);
      const before = await bindSecretSourceAssessment(baseOptions), candidate = await bindSecretSourceAssessment(headOptions);
      expect(before.findingPolicy).toBe('blocked');
      expect(candidate.findingPolicy).toBe('blocked');
      expect(candidate.findings).toEqual(before.findings);
      expect(candidate.comparisonCoverageDigest).toBe(before.comparisonCoverageDigest);
      expect(candidate.coverage).toMatchObject({ complete: true, distinctFindingCount: 1, introducedCommits: 1 });

      const observation = (value: typeof candidate): AdmissionObservation => ({
        sourceCommit: value.identity.sourceSha, runId: value.identity.runId, attempt: 1,
        validatorDigest: adoptedBaseIdentity(base).validatorDigest, policyDigest: value.identity.policyDigest,
        protectedInputsDigest: value.protectedInputsDigest, analysisConfigurationDigest: value.analysisConfigurationDigest,
        coverageDigest: value.comparisonCoverageDigest, completedAt: value.completedAt,
        execution: 'success', integrity: 'success', functional: 'success', coverageComplete: true,
        findingPolicy: value.findingPolicy, findings: value.findings
      });
      // Other whole-PR producers are simulated here. The secrets producer itself
      // is real; this is not hosted/full-repository admission qualification.
      const observations = { base: observation(before), candidate: observation(candidate) };
      const expected = (value: AdmissionObservation) => ({
        sourceCommit: value.sourceCommit, runId: value.runId, attempt: value.attempt, reportDigest: canonicalDigest(value)
      });
      expect(evaluateAdmission(base, observations, {
        base: expected(observations.base), candidate: expected(observations.candidate)
      }, new Map([['secrets', candidate.adapter]]))).toMatchObject({
        decision: 'maintenance-admitted', findingPolicy: 'blocked', policyAdopted: false, publicationQualified: false
      });
      for (const invalid of [
        { ...headOptions, result: structuredClone(headScan) },
        { ...headOptions, expectedReportDigest: digest },
        { ...headOptions, result: baseScan },
        { ...headOptions, now: new Date(Date.now() + 86_400_001) },
        { ...headOptions, identity: { ...headOptions.identity, policyDigest: digest } },
        { ...headOptions, identity: { ...headOptions.identity, configurationDigest: digest } },
        { ...headOptions, expectedScope: { ...headScan.scope, refs: { 'refs/heads/unknown': headCommit } } }
      ]) await expect(bindSecretSourceAssessment(invalid)).rejects.toThrow('Security evidence rejected');
      const noHistory = await scan(headCommit, undefined, headOptions.identity);
      await expect(bindSecretSourceAssessment(options(base, 'candidate', noHistory))).rejects.toThrow('incomplete-coverage');
      const confirmed = await bindSecretSourceAssessment({
        ...headOptions, verifiedFacts: [{ ...facts[0]!, confirmedUnremediated: true }]
      });
      expect(confirmed.findings[0]!.confirmedUnremediated).toBe(true);
      expect(confirmed.findingPolicy).toBe('blocked');
      const confirmedObservation = observation(confirmed);
      expect(evaluateAdmission(base, { base: observations.base, candidate: confirmedObservation }, {
        base: expected(observations.base), candidate: expected(confirmedObservation)
      }, new Map([['secrets', confirmed.adapter]]))).toMatchObject({
        decision: 'blocked', reason: 'confirmed-unremediated-exposure'
      });
      headScan.scans[0]!.findingsPassed = true;
      await expect(bindSecretSourceAssessment(headOptions)).rejects.toThrow('unissued-or-mutated-assessment');

      const nextCommit = await fixture.commit({ ...adoptedFiles, 'README.txt': 'Ordinary post-adoption fixture change.\n' });
      const nextScan = await scan(nextCommit, headCommit);
      const adopted = await loadAdoptedBase(fixture.root, {
        repository: 'voyager163/liftoff', baseRef: 'develop', baseCommit: headCommit, headCommit: nextCommit, now: new Date()
      });
      const after = await bindSecretSourceAssessment(options(adopted, 'candidate', nextScan));
      expect(after.findingPolicy).toBe('passed');
      expect(after.findings).toEqual(before.findings);
      expect(after.verdict.authorityCommit).toBe(headCommit);
      expect(after.publicationQualified).toBe(false);
      const normalObservation = observation(after);
      expect(evaluateAdmission(adopted, { base: null, candidate: normalObservation }, {
        base: null, candidate: expected(normalObservation)
      }, new Map([['secrets', after.adapter]]))).toMatchObject({
        decision: 'normal-admitted', findingPolicy: 'passed', publicationQualified: false
      });
      expect(JSON.stringify(after)).not.toContain('NONFUNCTIONAL_TEXT_NOT_A_PKCS12_CONTAINER');
      expect(JSON.stringify(after)).not.toContain('fixture with spaces.p12');

      const artifact = Buffer.from('Inert release identity fixture, not an actual npm package.');
      const releaseCandidate: NpmCandidate = {
        schemaVersion: 1, kind: 'npm-release-candidate',
        source: { commit: nextCommit, tree: 'a'.repeat(40), inputsDigest: digest, dirty: false },
        artifact: { name: '@msn-control/liftoff', version: '0.12.3', filename: 'msn-control-liftoff-0.12.3.tgz',
          size: artifact.length, ...artifactHashes(artifact) },
        releaseTag: 'v0.12.3', distTag: 'latest', createdAt: new Date().toISOString()
      };
      const releaseBase = await loadAdoptedBase(fixture.root, {
        repository: 'voyager163/liftoff', baseRef: 'main',
        baseCommit: nextCommit, headCommit: nextCommit, now: new Date()
      });
      const releaseIdentity: EvidenceIdentity = {
        repository: 'voyager163/liftoff', event: 'workflow_dispatch', sourceSha: nextCommit,
        baseSha: nextCommit, workflowSha: nextCommit, runId: '303', attempt: 1,
        policyDigest: adoptedBaseIdentity(releaseBase).policyDigest,
        inventoryDigest: canonicalDigest({ sourceCommit: nextCommit, refs: { 'refs/heads/fixture': nextCommit } }),
        configurationDigest: canonicalDigest({ detector: scanner, rules: baseMetadata.rules })
      };
      const releaseScan = await scan(nextCommit, undefined, releaseIdentity);
      const releaseOptions = options(releaseBase, 'base', releaseScan);
      const releaseInput = { ...releaseOptions, identity: releaseIdentity };
      const payload = await prepareReleaseSecretPayload(releaseInput, releaseCandidate, releaseIdentity);
      expect(payload).toMatchObject({
        kind: 'fresh-adopted-source-secrets-evidence', sourceCommit: nextCommit,
        adoptedPolicyCommit: nextCommit, observedFindings: 1, blockedFindings: 0,
        currentTreeComplete: true, declaredHistoryComplete: true,
        admissionEvidenceUsed: false, publicationAuthorized: false
      });
      for (const invalid of [
        { ...releaseInput, now: new Date(Date.now() + 86_400_001) },
        { ...releaseInput, identity: { ...releaseIdentity, attempt: 2 } },
        { ...releaseInput, verifiedFacts: [{ ...facts[0]!, confirmedUnremediated: true }] },
        { ...releaseInput, verifiedFacts: [] }
      ]) await expect(prepareReleaseSecretPayload(invalid, releaseCandidate, releaseIdentity)).rejects.toThrow();
      await expect(prepareReleaseSecretPayload(releaseInput, {
        ...releaseCandidate, source: { ...releaseCandidate.source, dirty: true }
      }, releaseIdentity)).rejects.toThrow('unqualified-release-source-or-attempt');
      await expect(prepareReleaseSecretPayload(releaseInput, {
        ...releaseCandidate, createdAt: new Date(Date.now() + 1).toISOString()
      }, releaseIdentity)).rejects.toThrow('unqualified-release-source-or-attempt');
      await expect(prepareReleaseSecretPayload(headOptions, releaseCandidate, headOptions.identity))
        .rejects.toThrow('unqualified-release-source-or-attempt');
      const retagged = { ...releaseIdentity, runId: '404' };
      await expect(prepareReleaseSecretPayload({ ...releaseInput, identity: retagged }, releaseCandidate, retagged))
        .rejects.toThrow('execution-identity-mismatch');
      const unboundScan = await assessDeclaredSecretSource({
        repository: fixture.root, workspaceParent: parent, tool, upstreamProfile,
        scope: { sourceCommit: nextCommit, refs: { 'refs/heads/fixture': nextCommit } }
      });
      await expect(prepareReleaseSecretPayload({
        ...releaseInput, result: unboundScan, expectedReportDigest: readIssuedSecretSource(unboundScan).reportDigest
      }, releaseCandidate, releaseIdentity)).rejects.toThrow('execution-identity-mismatch');

      // A separate clean-base PR adds then removes only the inert path sentinel.
      // Current-tree success must not replace the introduced-history verdict.
      const { 'fixture with spaces.p12': unusedFixture, ...cleanFiles } = files;
      void unusedFixture;
      const cleanBase = await fixture.commit(cleanFiles);
      await fixture.commit(files);
      const removedHead = await fixture.commit(cleanFiles);
      const removedScan = await scan(removedHead, cleanBase);
      expect(removedScan.scans.map(scan => scan.findingCount)).toEqual([0, 2, 1]);
      const removalBase = await loadAdoptedBase(fixture.root, {
        repository: 'voyager163/liftoff', baseRef: 'develop',
        baseCommit: cleanBase, headCommit: removedHead, now: new Date()
      });
      const removedResult = await bindSecretSourceAssessment({
        ...options(removalBase, 'candidate', removedScan), verifiedFacts: []
      });
      expect(removedResult.findingPolicy).toBe('blocked');
      expect(removedResult.coverage.introducedCommits).toBe(2);
      const removedObservation = observation(removedResult);
      expect(evaluateAdmission(removalBase, { base: null, candidate: removedObservation }, {
        base: null, candidate: expected(removedObservation)
      }, new Map([['secrets', removedResult.adapter]]))).toMatchObject({
        decision: 'blocked', findingPolicy: 'blocked'
      });
    } finally { try { await tool?.cleanup(); } finally { await fixture.cleanup(); } }
  }, 240_000
);
