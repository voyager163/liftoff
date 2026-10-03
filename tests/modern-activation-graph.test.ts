import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { modernActivationSourceContracts } from '../src/domain/governance/policy/identity.js';
import { canonicalJson } from '../src/domain/governance/activation/canonical-json.js';
import { modernPhaseContractDigests } from '../src/domain/governance/activation/modern-graph.js';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function independentlyCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(independentlyCanonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${independentlyCanonical(Reflect.get(value, key))}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

describe('actual static modern source policies and graphs, not execution qualification', () => {
  it('derives six distinct canonical graph hashes and two exact policy byte hashes', () => {
    const sources = modernActivationSourceContracts();
    expect(sources.map(source => [source.identity.profile, source.identity.workflow])).toEqual([
      ['single-maintainer-gitflow', 'openspec'], ['single-maintainer-gitflow', 'spec-kit'], ['single-maintainer-gitflow', 'manual'],
      ['team-gitflow', 'openspec'], ['team-gitflow', 'spec-kit'], ['team-gitflow', 'manual']
    ]);
    expect(new Set(sources.map(source => source.identity.phaseGraphHash)).size).toBe(6);
    expect(new Set(sources.map(source => source.identity.policyDigest)).size).toBe(2);
    for (const source of sources) {
      const bytes = readFileSync(path.join(...source.policyPathParts));
      expect(source.identity.policyDigest).toBe(`sha256:${hash(bytes)}`);
      const canonical = independentlyCanonical(source.graph) + '\n';
      expect(canonical).toBe(canonicalJson(source.graph));
      expect(source.identity.phaseGraphHash).toBe(hash(canonical));
      expect(source.identity).toMatchObject({
        liftoffVersion: '0.13.0-dev.0', manifestArtifactVersion: 8, activationContractVersion: 4,
        phaseGraphSchemaVersion: 3, activationStateSchemaVersion: 4, evidenceHeaderSchemaVersion: 4,
        approvalEnvelopeSchemaVersion: 4, supersessionSchemaVersion: 2, credentialPolicySchemaVersion: 2
      });
      expect(Object.keys(source.identity)).toHaveLength(14);
      expect(source).toMatchObject({ savedPlanSchemaVersion: 3, compatibilityMetadataSchemaVersion: 5 });
      expect(source.graph.versions.policyVersion).toBe(source.identity.policyVersion);
      expect(source.graph.profileContract.policyDigest).toBe(source.identity.policyDigest);
      expect(source.graph.workflowContract.workflow).toBe(source.identity.workflow);
    }
    console.info('C1_STATIC_SOURCE_ROWS ' + JSON.stringify(sources.map(({ graph: _graph, ...source }) => source)));
    console.info('C1_STATIC_SOURCE_CONTRACTS ' + JSON.stringify(sources));
  });

  it.each(modernActivationSourceContracts())('contains a complete, closed and acyclic $identity.profile/$identity.workflow graph', source => {
    const graph = source.graph, ids = new Set(graph.phases.map(phase => phase.id));
    expect(graph.phases).toHaveLength(29);
    expect(ids.size).toBe(29);
    expect(graph.completionGroups.local).toEqual(['local-inputs-valid', 'local-baseline-verified', 'local-complete']);
    expect(Object.values(graph.completionGroups).flat().sort()).toEqual([...ids].sort());
    const done = new Set<string>();
    function visit(id: string, active: Set<string>) {
      if (done.has(id)) return;
      expect(active.has(id), `cycle at ${id}`).toBe(false);
      const node = graph.phases.find(phase => phase.id === id);
      expect(node).toBeDefined();
      for (const dependency of node!.dependencies) for (const predecessor of dependency.anyOf) {
        expect(ids.has(predecessor)).toBe(true); visit(predecessor, new Set([...active, id]));
      }
      if (node!.rollback.target !== null) expect(ids.has(node!.rollback.target)).toBe(true);
      done.add(id);
    }
    for (const phase of graph.phases) {
      visit(phase.id, new Set());
      expect(phase.evidence.headerSchemaVersion).toBe(4);
      expect(phase.approvalGate.envelopeSchemaVersion).toBe(4);
      expect(['seed-valid', 'seed-verified', 'seed-archived']).not.toContain(phase.id);
    }
    expect(graph.phases.find(phase => phase.id === 'committed')!.dependencies[0].anyOf).toEqual(['local-complete']);
    expect(graph.phases.find(phase => phase.id === 'rulesets-applied')!.dependencies[0].anyOf).toEqual(['enforcement-approved']);
    expect(graph.profileContract.preExistingDeploymentState).toBe('planning-only');
    expect(Object.keys(modernPhaseContractDigests(graph))).toHaveLength(29);
  });

  it('gives Manual a genuine no-framework completion path and Spec Kit no OpenSpec archive', () => {
    for (const source of modernActivationSourceContracts()) {
      const local = source.graph.phases.filter(phase => source.graph.completionGroups.local.includes(phase.id));
      if (source.identity.workflow === 'manual') {
        expect(source.graph.workflowContract).toMatchObject({ framework: 'not-required', completion: 'native-receipt',
          frameworkValidation: 'not-required', frameworkFinalization: 'not-required', agents: 'optional' });
        expect(local.flatMap(phase => phase.allowedMutations.local)).not.toContain('write-seed-tasks');
        expect(local.flatMap(phase => phase.allowedMutations.local)).not.toContain('write-openspec-seed');
        expect(source.graph.phases.find(phase => phase.id === 'activation-approved')!.allowedMutations.local).toContain('write-operational-plan');
      } else if (source.identity.workflow === 'spec-kit') {
        expect(source.graph.workflowContract.completion).toBe('validate-finalize');
        expect(local.flatMap(phase => phase.allowedMutations.local)).not.toContain('write-openspec-seed');
        expect(local.find(phase => phase.id === 'local-complete')!.allowedMutations.local).toContain('write-spec-kit-seed');
        expect(local.find(phase => phase.id === 'local-complete')!.label).not.toContain('archive');
      } else expect(source.graph.workflowContract.completion).toBe('validate-sync-archive');
    }
  });

  it('binds profile/workflow to every phase contract without manufacturing reviewer or provider proof', () => {
    const sources = modernActivationSourceContracts();
    const single = sources[0], team = sources[3], manual = sources[2];
    expect(single.graph.profileContract.pullRequestReview).toEqual({ kind: 'automated-only', humanApprovals: 0 });
    expect(team.graph.profileContract.pullRequestReview).toEqual({ kind: 'independent-human', humanApprovals: 1,
      excludeAuthor: true, excludeBots: true, invalidateOnRelevantChanges: true, currentHeadRequired: true });
    for (const source of sources) {
      expect(source.graph.profileContract).toMatchObject({ deploymentReviewers: 'not-required', existingCodeowners: 'preserve',
        strongerProtections: 'review-before-reduction', backMerge: 'protected-pr-and-exact-head-checks' });
    }
    for (const id of single.graph.phases.map(phase => phase.id)) {
      expect(modernPhaseContractDigests(single.graph)[id]).not.toBe(modernPhaseContractDigests(team.graph)[id]);
      expect(modernPhaseContractDigests(single.graph)[id]).not.toBe(modernPhaseContractDigests(manual.graph)[id]);
    }
  });

  it('keeps normative policy contents distinct and preserves shared safety controls', () => {
    const sources = modernActivationSourceContracts();
    const single = readFileSync(path.join(...sources[0].policyPathParts), 'utf8');
    const team = readFileSync(path.join(...sources[3].policyPathParts), 'utf8');
    expect(single).toContain('required_approving_review_count: 0');
    expect(team).toContain('required_approving_review_count: 1');
    expect(team).not.toContain('required_approving_review_count: 0');
    expect(team).not.toContain('There is no reviewer on these repositories');
    for (const text of [single, team]) for (const requirement of [
      'GITHUB_TOKEN', 'rulesets idempotently last', '30 days read-only after verified remote import',
      'Active LTS only', 'Provision nothing that no code uses', 'ZRS in every environment',
      'planning-only in this release', 'Preserve existing stronger protections and CODEOWNERS',
      'native local completion receipt', 'without claiming an OpenSpec archive', 'STOP FOR EXPLICIT USER APPROVAL'
    ]) expect(text).toContain(requirement);
  });

  it('returns independent deeply frozen source data and hashes change on actual source mutation', () => {
    const first = modernActivationSourceContracts(), second = modernActivationSourceContracts();
    expect(first).not.toBe(second); expect(first[0].graph).not.toBe(second[0].graph);
    expect(() => Reflect.set(first[0].graph.phases[0], 'label', 'changed')).not.toThrow();
    expect(first[0].graph.phases[0].label).not.toBe('changed');
    expect(Object.isFrozen(first[0].graph.phases[0].dependencies)).toBe(true);
    const changed = structuredClone(first[0].graph);
    Reflect.set(changed.profileContract, 'strongerProtections', 'reduce-without-review');
    expect(hash(independentlyCanonical(changed) + '\n')).not.toBe(first[0].identity.phaseGraphHash);
    const bytes = readFileSync(path.join(...first[0].policyPathParts));
    expect(`sha256:${hash(Buffer.concat([bytes, Buffer.from('changed')]))}`).not.toBe(first[0].identity.policyDigest);
  });
});
