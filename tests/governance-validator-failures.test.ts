import { describe, expect, it } from 'vitest';
import {
  buildFineGrainedPatCredentialPolicy, buildGitHubAppCredentialPolicy, canonicalCredentialRepository, canonicalPhaseContractDigests,
  canonicalPhaseGraph, canonicalPhaseGraphHash, canonicalSha256, currentActivationIdentity, phaseIds,
  validateActivationConfiguration, validateActivationIdentity, validateCredentialPolicy, validateEvidenceHeader,
  validateGovernanceTaskProjectionContract, validateGovernanceTaskProjectionRecord, validateGraphReconciliationRecord,
  validateLiveReadbackProof, validateManagedPhaseGraph, validateManifestActivationForExecution, validateReadableActivationIdentity,
  validateUserActivationState, type EvidenceHeader
} from '../src/governance-activation/index.js';
import { sha256Hex } from '../src/domain/governance/activation/canonical-json.js';
import { historicalV1ActivationIdentity, historicalV2ActivationIdentity } from '../src/domain/governance/policy/identity.js';
import type { LiftoffManifest } from '../src/types.js';
import { fixtureContext, fixtureHeader } from './governance-activation-fixtures.js';
import { coverageState } from './fixtures/governance-coverage/transition-project.js';

// Fixture documents are mutated structurally to prove each refusal; `any` keeps those edits readable.
type Json = any;

const now = '2026-09-04T00:00:00.000Z';
const hex = (seed: string) => canonicalSha256(seed);
const syntheticPat = ['ghp', 'SYNTHETIC0VALIDATOR0VALUE0FOR0TESTS'].join('_');

function mutated<T>(value: T, change: (copy: Json) => void): Json {
  const copy = structuredClone(value) as Json;
  change(copy);
  return copy;
}

describe('activation input and identity refusals', () => {
  it('normalizes a complete public input set and refuses unsafe repository, budget, and credential-shaped values', () => {
    expect(validateActivationConfiguration({
      schemaVersion: 1,
      phases: { 'credential-ready': { token: { generatedBy: 'github-app', strategy: 'installation-token', ttlSeconds: 3600 }, owners: ['acme'] } },
      repository: { name: 'acme/widget', defaultBranch: 'develop', visibility: 'private', create: true },
      budget: { currency: 'EUR', fixedMonthlyCents: 1200, usageMonthlyCents: 0 }
    })).toEqual({
      schemaVersion: 1,
      phases: { 'credential-ready': { token: { generatedBy: 'github-app', strategy: 'installation-token', ttlSeconds: 3600 }, owners: ['acme'] } },
      repository: { name: 'acme/widget', defaultBranch: 'develop', visibility: 'private', create: true },
      budget: { currency: 'EUR', fixedMonthlyCents: 1200, usageMonthlyCents: 0 }
    });
    const deep: Json = {};
    let cursor = deep;
    for (let depth = 0; depth < 22; depth += 1) cursor = cursor.next = {};
    const refusals: Array<[unknown, RegExp]> = [
      [{ repository: { name: 'acme' } }, /repository\.name must be owner\/repository/u],
      [{ repository: { name: 'acme/widget/extra' } }, /repository\.name must be owner\/repository/u],
      ...['feature//x', 'x/', 'x.lock', '../x', 'a..b', '-x'].map((defaultBranch): [unknown, RegExp] =>
        [{ repository: { name: 'acme/widget', defaultBranch } }, /defaultBranch must be a safe Git branch name/u]),
      [{ repository: { name: 'acme/widget', visibility: 'internal' } }, /^activationInputs\.repository\.visibility must be "private" or "public"\.$/u],
      [{ repository: { name: 'acme/widget', create: 'yes' } }, /create must be a boolean/u],
      [{ repository: { name: 'acme/widget', owner: 'acme' } }, /^activationInputs\.repository contains an unsupported field; allowed fields: name, defaultBranch, visibility, create\.$/u],
      [{ budget: { currency: 'usd', fixedMonthlyCents: 0, usageMonthlyCents: 0 } }, /three-letter uppercase ISO currency/u],
      [{ budget: { currency: 'USD', fixedMonthlyCents: -1, usageMonthlyCents: 0 } }, /non-negative safe integer/u],
      [{ budget: { currency: 'USD', fixedMonthlyCents: 1.5, usageMonthlyCents: 0 } }, /must be a safe integer/u],
      [{ phases: { 'phase-0-complete': { remote: 'https://user:secret@github.com/acme/widget.git' } } }, /credential material/u],
      [{ phases: { 'phase-0-complete': { callback: 'https://example.test/hook?sig=abc' } } }, /credential material/u],
      [{ phases: { 'phase-0-complete': { notes: [`use ${syntheticPat}`] } } }, /credential material/u],
      [{ phases: { 'phase-0-complete': { key: '-----BEGIN RSA PRIVATE KEY-----' } } }, /credential material/u],
      [{ phases: { 'phase-0-complete': { clientSecret: 'value' } } }, /clientSecret is not permitted in public activation inputs/u],
      [{ phases: { 'credential-ready': { token: { generatedBy: 'github-app', strategy: 'installation-token', ttlSeconds: 3601 } } } }, /token is not permitted/u],
      [{ phases: { 'credential-ready': { token: { generatedBy: 'github-app', strategy: 'pat', ttlSeconds: 60 } } } }, /token is not permitted/u],
      [{ phases: { 'phase-0-complete': JSON.parse('{"__proto__":{"polluted":true}}') } }, /__proto__ is not permitted/u],
      [{ phases: { 'phase-0-complete': deep } }, /exceeds the supported JSON nesting depth/u],
      [{ phases: { 'phase-0-complete': { count: Number.NaN } } }, /must be an object/u]
    ];
    for (const [overrides, expected] of refusals) {
      expect(() => validateActivationConfiguration({ schemaVersion: 1, phases: {}, ...(overrides as object) }), JSON.stringify(overrides))
        .toThrow(expected);
    }
    expect(() => validateActivationConfiguration({ schemaVersion: 2, phases: {} })).toThrow(/schemaVersion must be 1/u);
  });

  it('rejects malformed, placeholder, future, and mixed identity tuples before execution', () => {
    const refusals: Array<[unknown, RegExp]> = [
      [{ ...currentActivationIdentity, phaseGraphHash: 'not-a-digest' }, /phaseGraphHash must be a SHA-256 hex digest/u],
      [{ ...currentActivationIdentity, phaseGraphHash: '0'.repeat(64) }, /not present in the explicit compatibility map/u],
      [{ ...currentActivationIdentity, activationContractVersion: 4 }, /activationContractVersion must be 3/u],
      [{ ...currentActivationIdentity, credentialPolicySchemaVersion: 2 }, /credentialPolicySchemaVersion must be 1/u],
      [{ ...historicalV1ActivationIdentity, phaseGraphHash: currentActivationIdentity.phaseGraphHash }, /identity\.\w+ must be /u],
      [{ ...currentActivationIdentity, workflow: 'manual' }, /identity\.workflow is not allowed/u],
      [(({ supersessionSchemaVersion: _omitted, ...rest }) => rest)(currentActivationIdentity), /supersessionSchemaVersion is required/u],
      ['0.12.0', /identity must be an object/u]
    ];
    for (const [identity, expected] of refusals) expect(() => validateActivationIdentity(identity)).toThrow(expected);
    expect(validateActivationIdentity(structuredClone(currentActivationIdentity))).toEqual(currentActivationIdentity);
  });

  it('reads historical identities as untouched copies without granting execution', () => {
    for (const historical of [historicalV1ActivationIdentity, historicalV2ActivationIdentity]) {
      const readable = validateReadableActivationIdentity(historical);
      expect(readable).toEqual(historical);
      expect(readable).not.toBe(historical);
      const manifest = (profile: LiftoffManifest['governance']['profile']) =>
        ({ governance: { profile, activationIdentity: historical } }) as Pick<LiftoffManifest, 'governance'>;
      expect(() => validateManifestActivationForExecution(manifest('single-maintainer-gitflow'))).toThrow(/is diagnostic-only/u);
      expect(() => validateManifestActivationForExecution(manifest('none'))).not.toThrow();
      expect(() => validateManifestActivationForExecution(manifest('unspecified'))).not.toThrow();
    }
    expect(() => validateReadableActivationIdentity({ ...currentActivationIdentity, liftoffVersion: '9.9.9' })).toThrow();
    expect(() => validateManifestActivationForExecution({ governance: { profile: 'single-maintainer-gitflow' } } as Pick<LiftoffManifest, 'governance'>))
      .not.toThrow();
  });
});

describe('managed phase graph refusals', () => {
  const graphNode = (graph: Json, id: string): Json => graph.phases.find((phase: Json) => phase.id === id);
  const dependency = (anyOf: string[]) => ({ anyOf, accepts: ['verified'], description: 'Mutated fixture dependency.' });
  const cases: Array<[string, (graph: Json) => void, RegExp]> = [
    ['phases object', (graph) => { graph.phases = {}; }, /phaseGraph\.phases must be an array/u],
    ['missing phase', (graph) => { graph.phases.pop(); }, /declare every canonical phase exactly once/u],
    ['duplicate phase', (graph) => { graph.phases[1] = structuredClone(graph.phases[0]); }, /Duplicate phase id seed-valid/u],
    ['reordered phases', (graph) => { [graph.phases[0], graph.phases[1]] = [graph.phases[1], graph.phases[0]]; }, /not in canonical order at index 0/u],
    ['forward dependency', (graph) => { graphNode(graph, 'seed-verified').dependencies = [dependency(['seed-archived'])]; },
      /Reversed dependency order: seed-verified depends on seed-archived/u],
    ['later rollback target', (graph) => { graphNode(graph, 'bootstrap-local').rollback.target = 'runner-ready'; },
      /Rollback target for bootstrap-local must be an earlier phase/u],
    ['required none gate', (graph) => { graphNode(graph, 'seed-valid').approvalGate.required = true; }, /seed-valid cannot require approval gate none/u],
    ['optional authority gate', (graph) => { graphNode(graph, 'committed').approvalGate.required = false; }, /committed has a non-none optional approval gate/u],
    ['missing GitHub readback', (graph) => { graphNode(graph, 'pushed').evidence.liveReadbackProviders = []; },
      /pushed must declare github live readback proof/u],
    ['missing Azure readback', (graph) => { graphNode(graph, 'provider-ready').evidence.liveReadbackProviders = []; },
      /provider-ready must declare azure live readback proof/u],
    ['non-conditional exclusive branch', (graph) => { graphNode(graph, 'existing-private-path').applicability.exclusiveWith = ['seed-valid']; },
      /existing-private-path exclusive phase seed-valid must be conditional/u],
    ['conditional without inapplicable', (graph) => { graphNode(graph, 'existing-private-path').terminalStates = ['verified', 'failed']; },
      /existing-private-path conditional phase must permit inapplicable terminal state/u],
    ['bootstrap without provider readiness', (graph) => { graphNode(graph, 'bootstrap-local').dependencies = [dependency(['state-path-selected'])]; },
      /bootstrap-local must depend on provider-ready/u],
    ['backend proof without runner', (graph) => { graphNode(graph, 'private-backend-proof').dependencies = [dependency(['bootstrap-local'])]; },
      /private-backend-proof must depend on runner-ready/u],
    ['import without backend proof', (graph) => { graphNode(graph, 'remote-import-verified').dependencies = [dependency(['runner-ready'])]; },
      /remote-import-verified must depend on private-backend-proof/u],
    ['remote readiness without import', (graph) => { graphNode(graph, 'remote-ready').dependencies = [dependency(['private-backend-proof'])]; },
      /remote-ready must depend on remote-import-verified/u],
    ['unreachable final disposal', (graph) => { graphNode(graph, 'bootstrap-state-disposed').dependencies = []; },
      /seed-valid cannot reach terminal bootstrap-state-disposed/u],
    ['dependency object', (graph) => { graphNode(graph, 'seed-valid').dependencies = {}; }, /dependencies must be an array/u],
    ['empty anyOf', (graph) => { graphNode(graph, 'seed-verified').dependencies[0].anyOf = []; }, /anyOf must not be empty/u],
    ['empty accepts', (graph) => { graphNode(graph, 'seed-verified').dependencies[0].accepts = []; }, /accepts must not be empty/u],
    ['empty terminal states', (graph) => { graphNode(graph, 'seed-valid').terminalStates = []; }, /terminalStates must not be empty/u],
    ['duplicate readback provider', (graph) => { graphNode(graph, 'pushed').evidence.liveReadbackProviders = ['github', 'github']; },
      /liveReadbackProviders must not contain duplicates/u],
    ['empty local mutations', (graph) => { graphNode(graph, 'seed-valid').allowedMutations.local = []; }, /allowedMutations\.local must not be empty/u],
    ['none mixed with remote reads', (graph) => { graphNode(graph, 'seed-valid').allowedMutations.remote = ['none', 'github-read']; },
      /remote cannot combine none with other mutations/u],
    ['unsupported discriminator', (graph) => { graphNode(graph, 'existing-private-path').applicability.discriminator = 'contributor-count'; },
      /discriminator contains unsupported value/u],
    ['incomplete conditional applicability', (graph) => { graphNode(graph, 'existing-private-path').applicability = { kind: 'conditional' }; },
      /applicability\.discriminator is required/u],
    ['stale evidence header schema', (graph) => { graphNode(graph, 'seed-valid').evidence.headerSchemaVersion = 2; }, /headerSchemaVersion must be 3/u],
    ['unknown invalidation input', (graph) => { graphNode(graph, 'seed-valid').invalidationInputs = ['contributor-count']; },
      /invalidationInputs contains unsupported value/u],
    ['unknown rollback kind', (graph) => { graphNode(graph, 'seed-valid').rollback.kind = 'force-reset'; }, /rollback\.kind contains unsupported value/u],
    ['stale approval envelope schema', (graph) => { graphNode(graph, 'committed').approvalGate.envelopeSchemaVersion = 2; },
      /envelopeSchemaVersion must be 3/u],
    ['future package version', (graph) => { graph.versions.liftoffVersion = '0.13.0'; }, /versions\.liftoffVersion must be "0\.12\.0"/u],
    ['unknown graph field', (graph) => { graph.plugins = []; }, /phaseGraph\.plugins is not allowed/u]
  ];

  it.each(cases)('rejects a managed graph with %s', (_label, change, expected) => {
    expect(() => validateManagedPhaseGraph(mutated(canonicalPhaseGraph, change))).toThrow(expected);
  });
});

describe('evidence header and live readback refusals', () => {
  const header = fixtureHeader('phase-0-complete');
  const after = hex('observed after input');

  function proof(overrides: Json = {}) {
    return {
      schemaVersion: 3, repositoryId: header.repositoryId, identity: header.identity, phaseGraphHash: header.phaseGraphHash,
      phaseId: header.phaseId, baselineSha: header.baselineSha, inputDigest: header.inputDigest, transition: header.transition,
      observedAt: now, provider: 'github', resourceType: 'repository', resourceId: '/repos/owner/repo',
      sourceDigest: hex('source'), readbackDigest: hex('source'), matches: true, ...overrides
    };
  }

  it('accepts a bound Git transition and refuses stale or unreviewed input bindings', () => {
    const gitBinding = {
      before: { head: 'a'.repeat(40), branch: 'develop', pushUrls: [] },
      after: { head: 'b'.repeat(40), branch: null, pushUrls: ['git@github.com:owner/repo.git'] }
    };
    const bound = validateEvidenceHeader({
      ...header, inputDigest: after, remoteBindingDigest: hex('remote'),
      inputBindings: { beforeDigest: header.transition.inputDigest, afterDigest: after, files: [], git: gitBinding }
    });
    expect(bound.inputBindings?.git).toEqual(gitBinding);
    const unchangedFile = { pathParts: ['README.md'], beforeHash: hex('same'), afterHash: hex('same') };
    const refusals: Array<[Partial<EvidenceHeader> | Json, RegExp]> = [
      [{ phaseGraphHash: hex('other graph') }, /phaseGraphHash must match evidenceHeader\.identity\.phaseGraphHash/u],
      [{ transition: fixtureContext('pushed').transition }, /transition\.phaseId must match evidenceHeader\.phaseId/u],
      [{ transition: { ...header.transition, baselineSha: hex('stale baseline') } }, /transition\.baselineSha must match/u],
      [{ inputDigest: after }, /transition\.inputDigest must match evidenceHeader\.inputDigest/u],
      [{ inputDigest: after, inputBindings: { beforeDigest: header.transition.inputDigest, afterDigest: after, files: [unchangedFile] } },
        /Changed phase inputs require a concrete reviewed file or Git transition binding/u],
      [{ inputDigest: after, inputBindings: { beforeDigest: header.transition.inputDigest, afterDigest: after, files: [unchangedFile, unchangedFile] } },
        /contains duplicate value README\.md/u],
      [{ inputDigest: after, inputBindings: { beforeDigest: header.transition.inputDigest, afterDigest: after, files: {} } }, /files must be an array/u],
      [{ inputDigest: after, inputBindings: { beforeDigest: header.transition.inputDigest, afterDigest: after, files: [],
        git: { ...gitBinding, before: { ...gitBinding.before, head: 'abc123' } } } }, /head must be an actual Git object ID/u],
      [{ inputDigest: after, inputBindings: { beforeDigest: header.transition.inputDigest, afterDigest: after, files: [],
        git: { ...gitBinding, after: { ...gitBinding.after, pushUrls: ['https://x-access-token:value@github.com/owner/repo.git'] } } } },
        /pushUrls must contain credential-free supported GitHub destinations/u],
      [{ inputDigest: after, inputBindings: { beforeDigest: header.transition.inputDigest, afterDigest: after, files: [],
        git: { ...gitBinding, after: { ...gitBinding.after, pushUrls: ['https://gitlab.example/owner/repo.git'] } } } },
        /pushUrls must contain credential-free supported GitHub destinations/u],
      [{ result: 'approved' }, /result contains unsupported value "approved"/u],
      [{ remoteBindingDigest: 'unbound' }, /remoteBindingDigest must be a SHA-256 hex digest/u],
      [{ identity: historicalV2ActivationIdentity }, /Historical activation v\d+ is diagnostic-only/u],
      [{ identity: { ...currentActivationIdentity, evidenceHeaderSchemaVersion: 4 } }, /evidenceHeaderSchemaVersion must be 3/u],
      [{ schemaVersion: 2 }, /evidenceHeader\.schemaVersion must be 3/u],
      [{ producedAt: 'yesterday' }, /producedAt must be a valid ISO timestamp/u]
    ];
    for (const [overrides, expected] of refusals) {
      expect(() => validateEvidenceHeader({ ...header, ...overrides }), JSON.stringify(Object.keys(overrides))).toThrow(expected);
    }
  });

  it('binds live readback to the same identity, transition, and provider contract', () => {
    expect(validateLiveReadbackProof(proof())).toEqual(proof());
    const refusals: Array<[Json, RegExp]> = [
      [{ phaseGraphHash: hex('other graph') }, /liveReadbackProof\.phaseGraphHash must match/u],
      [{ transition: fixtureContext('pushed').transition }, /liveReadbackProof\.transition\.phaseId must match/u],
      [{ transition: { ...header.transition, baselineSha: hex('stale') } }, /liveReadbackProof\.transition\.baselineSha must match/u],
      [{ transition: { ...header.transition, inputDigest: hex('changed input') } }, /liveReadbackProof\.transition\.inputDigest must match/u],
      [{ provider: 'aws' }, /provider contains unsupported value "aws"/u],
      [{ matches: 'true' }, /matches must be a boolean/u],
      [{ observedAt: 'recently' }, /observedAt must be a valid ISO timestamp/u],
      [{ readbackDigest: 'mismatch' }, /readbackDigest must be a SHA-256 hex digest/u],
      [{ identity: historicalV1ActivationIdentity }, /Historical activation v\d+ is diagnostic-only/u],
      [{ credential: 'withheld' }, /liveReadbackProof\.credential is not allowed/u]
    ];
    for (const [overrides, expected] of refusals) expect(() => validateLiveReadbackProof(proof(overrides))).toThrow(expected);
  });
});

describe('persisted activation state refusals', () => {
  const operation = {
    provider: 'azure', actionId: 'azure.provider.ensure-ready', operationId: 'op-1',
    resourceId: '/subscriptions/00000000-0000-4000-8000-000000000001/providers/Microsoft.Resources',
    startedAt: now, observedAt: '2026-09-04T00:05:00.000Z', status: 'running'
  };
  const snapshotId = hex('snapshot');
  const successorHistory = {
    schemaVersion: 1, snapshotId, journalPathParts: ['governance', 'migration-state.json'],
    historyIndexPathParts: ['governance', 'history', snapshotId, 'index.json'], historyIndexDigest: hex('index'),
    sourceActiveChange: { id: 'governance-demo', kind: 'openspec' }
  };
  const bootstrapState = {
    status: 'retained', remoteImportEvidenceId: 'remote-import-verified-1', remoteImportEvidenceDigest: hex('import'),
    retainedAt: now, disposeAfter: '2026-10-04T00:00:00.000Z',
    encryptedStatePathParts: [['infrastructure', 'bootstrap.tfstate.enc']], encryptionKeyPathParts: [['infrastructure', 'bootstrap.key']]
  };

  function state(change: (copy: Json) => void = () => undefined): Json {
    return mutated(coverageState(), change);
  }

  it('preserves optional history, outputs, retention, and resumable operation records exactly', () => {
    const complete = state((copy) => {
      copy.applicability.cloudStateRequired = true;
      copy.applicability.privateRunnerRequired = false;
      copy.phases['provider-ready'].operation = {
        ...operation, pollUrl: 'https://management.azure.com/subscriptions/x/operations/1', planDigest: hex('plan')
      };
      copy.phases['provider-ready'].executionPlanDigest = hex('plan');
      copy.phaseOutputs = { 'phase-0-complete': {
        values: { repository: 'owner/repo', repositoryId: 7, private: true, deleted: null },
        resources: [{ provider: 'github', resourceType: 'repository', resourceId: '/repos/owner/repo' }]
      } };
      copy.successorHistory = successorHistory;
      copy.bootstrapState = { ...bootstrapState, status: 'disposed', disposedAt: '2026-10-05T00:00:00.000Z',
        deletionEvidenceId: 'bootstrap-state-disposed-1', incompleteCleanup: ['infrastructure/bootstrap.key'] };
      copy.baselineAnchor = hex('anchor');
      copy.activationInputs = { schemaVersion: 1, phases: {} };
    });
    const validated = validateUserActivationState(complete);
    expect(validated).toEqual(complete);
    expect(validated.successorHistory?.sourceActiveChange).toEqual({ id: 'governance-demo', kind: 'openspec' });
  });

  it('rejects unanchored, rebound, incomplete, or credential-bearing state before any transition reads it', () => {
    const refusals: Array<[string, (copy: Json) => void, RegExp]> = [
      ['unbound anchor', (copy) => { copy.repository.id = 'unbound'; }, /explicitly established immutable local execution anchor/u],
      ['rebound remote', (copy) => { copy.remoteBinding.pushUrl = 'https://github.com/other/repo.git'; },
        /remoteBinding must match one credential-free GitHub push destination/u],
      ['credential remote', (copy) => { copy.remoteBinding.pushUrl = 'https://user:value@github.com/owner/repo.git'; },
        /remoteBinding must match one credential-free GitHub push destination/u],
      ['missing phase', (copy) => { delete copy.phases['provider-ready']; }, /activationState\.phases\.provider-ready is required/u],
      ['unknown phase', (copy) => { copy.phases['team-review'] = copy.phases['seed-valid']; }, /team-review is not a canonical phase/u],
      ['evidence object', (copy) => { copy.phases['seed-valid'].evidence = {}; }, /evidence, approvals, and blockers must be arrays/u],
      ['nested output', (copy) => { copy.phaseOutputs = { 'phase-0-complete': { values: { nested: { id: 1 } }, resources: [] } }; },
        /values\.nested must be a public primitive value/u],
      ['output resources object', (copy) => { copy.phaseOutputs = { 'phase-0-complete': { values: {}, resources: {} } }; },
        /resources must be an array/u],
      ['unsupported output provider', (copy) => { copy.phaseOutputs = { 'phase-0-complete': { values: {},
        resources: [{ provider: 'aws', resourceType: 'bucket', resourceId: 'b' }] } }; }, /provider contains unsupported value "aws"/u],
      ['credential output', (copy) => { copy.phaseOutputs = { 'phase-0-complete': { values: { value: syntheticPat }, resources: [] } }; },
        /credential material/u],
      ['unknown output phase', (copy) => { copy.phaseOutputs = { 'team-review': { values: {}, resources: [] } }; },
        /phaseOutputs contains unsupported value "team-review"/u],
      ['short retention', (copy) => { copy.bootstrapState = { ...bootstrapState, disposeAfter: '2026-10-03T00:00:00.000Z' }; },
        /disposeAfter must be exactly 30 days after retainedAt/u],
      ['disposed without timestamp', (copy) => { copy.bootstrapState = { ...bootstrapState, status: 'disposed' }; },
        /disposedAt is required when status is disposed/u],
      ['foreign journal', (copy) => { copy.successorHistory = { ...successorHistory, journalPathParts: ['governance', 'journal.json'] }; },
        /exact registered migration journal and snapshot index/u],
      ['mismatched snapshot index', (copy) => { copy.successorHistory = { ...successorHistory,
        historyIndexPathParts: ['governance', 'history', hex('other snapshot'), 'index.json'] }; },
        /exact registered migration journal and snapshot index/u],
      ['insecure poll URL', (copy) => { copy.phases['provider-ready'].operation = { ...operation, pollUrl: 'http://management.azure.com/x' }; },
        /pollUrl must be a credential-free supported provider URL/u],
      ['foreign poll host', (copy) => { copy.phases['provider-ready'].operation = { ...operation, pollUrl: 'https://poll.example/x' }; },
        /pollUrl must be a credential-free supported provider URL/u],
      ['poll URL port', (copy) => { copy.phases['provider-ready'].operation = { ...operation, pollUrl: 'https://api.github.com:8443/x' }; },
        /pollUrl must be a credential-free supported provider URL/u],
      ['poll URL credentials', (copy) => { copy.phases['provider-ready'].operation = { ...operation, pollUrl: 'https://user:pw@api.github.com/x' }; },
        /credential material/u],
      ['observed before start', (copy) => { copy.phases['provider-ready'].operation = { ...operation, observedAt: '2026-09-03T23:59:00.000Z' }; },
        /observedAt must not precede startedAt/u],
      ['unknown operation status', (copy) => { copy.phases['provider-ready'].operation = { ...operation, status: 'queued' }; },
        /status contains unsupported value "queued"/u],
      ['invalid checkpoint digest', (copy) => { copy.phases['provider-ready'].operation = { ...operation, planDigest: 'plan-1' }; },
        /planDigest must be a SHA-256 hex digest/u],
      ['unsupported provider operation', (copy) => { copy.phases['provider-ready'].operation = { ...operation, provider: 'aws' }; },
        /provider contains unsupported value "aws"/u]
    ];
    for (const [label, change, expected] of refusals) {
      expect(() => validateUserActivationState(state(change)), label).toThrow(expected);
    }
  });
});

describe('governance task projection refusals', () => {
  const metadataText = '{"changeId":"governance-demo"}\n';
  const existing = {
    schemaVersion: 1, derivation: 'validated-current-readiness', source: 'existing', changeId: 'governance-demo', workflowKind: 'openspec',
    taskPathParts: ['openspec', 'changes', 'governance-demo', 'tasks.md'],
    metadataPathParts: ['openspec', 'changes', 'governance-demo', 'liftoff-governance.json'],
    metadataHash: sha256Hex(metadataText), layoutHash: hex('layout')
  };
  const record = {
    schemaVersion: 1, purpose: 'projection-audit-only', phaseId: 'activation-approved', planDigest: hex('plan'), contractDigest: hex('contract'),
    taskPathParts: existing.taskPathParts, metadataHash: existing.metadataHash, layoutHash: existing.layoutHash, status: 'complete',
    observedAt: now, beforeHash: hex('before'), afterHash: hex('after'),
    states: Object.fromEntries(phaseIds.map((id) => [id, 'pending'])), blockers: []
  };

  it('accepts only exact current task and metadata destinations with bound creation sources', () => {
    expect(validateGovernanceTaskProjectionContract(existing)).toEqual(existing);
    const created = { ...existing, source: 'create', template: '- [ ] 1.1 Review\n', metadataText };
    expect(validateGovernanceTaskProjectionContract(created)).toEqual(created);
    const specKit = { ...existing, workflowKind: 'spec-kit', taskPathParts: ['specs', 'governance-demo', 'tasks.md'],
      metadataPathParts: ['specs', 'governance-demo', 'liftoff-governance.json'] };
    expect(validateGovernanceTaskProjectionContract(specKit)).toEqual(specKit);
    const refusals: Array<[Json, RegExp]> = [
      [{ ...existing, derivation: 'agent-summary' }, /requires the bounded current-readiness derivation/u],
      [{ ...existing, changeId: 'bootstrap-demo', taskPathParts: ['openspec', 'changes', 'bootstrap-demo', 'tasks.md'],
        metadataPathParts: ['openspec', 'changes', 'bootstrap-demo', 'liftoff-governance.json'] }, /cannot target seed tasks or an archive/u],
      [{ ...existing, changeId: 'archive' }, /cannot target seed tasks or an archive/u],
      [{ ...existing, taskPathParts: ['openspec', 'changes', 'governance-demo', 'notes.md'] }, /exact current governance task and metadata paths/u],
      [{ ...existing, workflowKind: 'manual' }, /workflowKind contains unsupported value "manual"/u],
      [{ ...existing, source: 'import' }, /source contains unsupported value "import"/u],
      [{ ...created, metadataText: `${metadataText} ` }, /oversized or inconsistently bound creation sources/u],
      [{ ...created, template: 'x'.repeat(262_145) }, /oversized or inconsistently bound creation sources/u],
      [{ ...created, template: `- [ ] 1.1 Store ${syntheticPat}\n` }, /credential material/u],
      [{ ...existing, template: '- [ ] 1.1\n' }, /template is not allowed/u]
    ];
    for (const [contract, expected] of refusals) expect(() => validateGovernanceTaskProjectionContract(contract)).toThrow(expected);
  });

  it('keeps projection records audit-only and distinguishes complete from blocked output', () => {
    expect(validateGovernanceTaskProjectionRecord(record)).toEqual(record);
    const blocked = { ...record, status: 'blocked', states: null, afterHash: null, beforeHash: null, blockers: ['Current task source changed.'] };
    expect(validateGovernanceTaskProjectionRecord(blocked)).toEqual(blocked);
    const specKit = { ...record, taskPathParts: ['specs', 'governance-demo', 'tasks.md'] };
    expect(validateGovernanceTaskProjectionRecord(specKit)).toEqual(specKit);
    const refusals: Array<[Json, RegExp]> = [
      [{ ...record, purpose: 'execution-authority' }, /is not execution authority/u],
      [{ ...record, taskPathParts: ['openspec', 'changes', 'archive', 'tasks.md'] }, /cannot name an unregistered task destination/u],
      [{ ...record, taskPathParts: ['openspec', 'changes', 'bootstrap-demo', 'tasks.md'] }, /cannot name an unregistered task destination/u],
      [{ ...record, taskPathParts: ['specs', '000-liftoff-bootstrap', 'tasks.md'] }, /cannot name an unregistered task destination/u],
      [{ ...record, taskPathParts: ['openspec', 'changes', 'governance-demo', 'design.md'] }, /cannot name an unregistered task destination/u],
      [{ ...record, states: null }, /distinguish completed projection from blocked, uncommitted task output/u],
      [{ ...record, blockers: ['stale'] }, /distinguish completed projection from blocked/u],
      [{ ...blocked, afterHash: hex('after') }, /distinguish completed projection from blocked/u],
      [{ ...blocked, blockers: [] }, /distinguish completed projection from blocked/u],
      [{ ...record, states: { ...record.states, 'seed-valid': 'done' } }, /states\.seed-valid contains unsupported value "done"/u],
      [{ ...record, status: 'partial' }, /status contains unsupported value "partial"/u]
    ];
    for (const [value, expected] of refusals) expect(() => validateGovernanceTaskProjectionRecord(value)).toThrow(expected);
  });
});

describe('graph reconciliation refusals', () => {
  const otherGraph = hex('successor graph');
  const mappings = phaseIds.map((id) => ({
    phaseId: id, fromContractDigest: canonicalPhaseContractDigests[id], toContractDigest: canonicalPhaseContractDigests[id], preserveEvidence: true
  }));
  const valid = {
    schemaVersion: 3, fromGraphHash: canonicalPhaseGraphHash, toGraphHash: canonicalPhaseGraphHash,
    fromIdentity: currentActivationIdentity, toIdentity: currentActivationIdentity, phaseMappings: mappings,
    reconciledAt: now, producer: 'coverage-fixture'
  };

  it('requires recognized graph identities and one exact mapping for every phase', () => {
    expect(validateGraphReconciliationRecord(valid).phaseMappings).toHaveLength(phaseIds.length);
    const recognized = new Set([canonicalPhaseGraphHash, otherGraph]);
    const refusals: Array<[Json, ReadonlySet<string> | undefined, RegExp]> = [
      [{ ...valid, toGraphHash: otherGraph }, undefined, /toGraphHash is not a recognized graph hash/u],
      [{ ...valid, fromGraphHash: otherGraph }, recognized, /fromIdentity\.phaseGraphHash must match fromGraphHash/u],
      [{ ...valid, toIdentity: { ...currentActivationIdentity, phaseGraphHash: otherGraph } }, recognized,
        /toIdentity\.phaseGraphHash must match toGraphHash/u],
      [{ ...valid, phaseMappings: {} }, undefined, /phaseMappings must be an array/u],
      [{ ...valid, phaseMappings: [...mappings, mappings[0]] }, undefined, /contains duplicate phase seed-valid/u],
      [{ ...valid, phaseMappings: mappings.slice(1) }, undefined, /phaseMappings\.seed-valid is required/u],
      [{ ...valid, phaseMappings: mappings.map((mapping, index) => index === 3 ? { ...mapping, toContractDigest: hex('changed') } : mapping) },
        undefined, /cannot preserve evidence for changed phase committed/u],
      [{ ...valid, fromIdentity: { ...currentActivationIdentity, policyVersion: '5' } }, undefined, /policyVersion must be "6"/u]
    ];
    for (const [value, recognizedHashes, expected] of refusals) {
      expect(() => validateGraphReconciliationRecord(value, recognizedHashes)).toThrow(expected);
    }
  });
});

describe('credential policy refusals', () => {
  const repository = canonicalCredentialRepository({ id: 'R_1', owner: 'acme', name: 'Widget' });
  const allowedWorkflows = [{ path: '.github/workflows/preflight.yml', jobs: ['runner-preflight'] }];
  const createdAt = new Date(now);
  const pat = buildFineGrainedPatCredentialPolicy({
    repository, allowedWorkflows, createdAt,
    proof: { verifiedAt: now, readbackDigest: hex('pat readback'), readbackProvider: 'adapter-fixture', payloadFree: true }
  });
  const app = buildGitHubAppCredentialPolicy({
    repository, allowedWorkflows, createdAt,
    installation: {
      installationId: 9, appSlug: 'liftoff-preflight', approved: true, verified: true, selection: 'selected-repository',
      repositories: [repository], permissions: { repository: ['metadata:read'], organization: ['hosted-runners:read', 'network-configurations:read'] },
      permissionsVerifiedAt: now, readbackDigest: hex('app readback'), token: { canGenerate: true, ttlSeconds: 3600 }
    }
  });

  it('rejects policies that could forward, rename, over-scope, or outlive the reviewed preflight credential', () => {
    expect(validateCredentialPolicy(pat)).toEqual(pat);
    expect(validateCredentialPolicy(app)).toEqual(app);
    const refusals: Array<[Json, RegExp]> = [
      [{ ...pat, nonForwarding: false }, /nonForwarding must be true/u],
      [{ ...pat, secretName: 'DEPLOY_TOKEN' }, /secretName must be RUNNER_CONFIGURATION_READ_TOKEN/u],
      [{ ...pat, displayNameTemplate: '<repo>-deploy' }, /displayNameTemplate must be/u],
      [{ ...pat, allowedWorkflows: {} }, /allowedWorkflows must be an array/u],
      [{ ...pat, allowedWorkflows: [] }, /allowedWorkflows must contain at least one workflow/u],
      [{ ...pat, owner: 'other-owner' }, /owner must match credentialPolicy\.repository\.owner/u],
      [{ ...pat, displayName: 'widget-deploy' }, /displayName must be derived from the canonical repository name/u],
      [{ ...pat, rotationDueAt: pat.expiresAt }, /rotationDueAt must equal expiresAt minus the rotation lead/u],
      [{ ...pat, proof: { ...pat.proof, payloadFree: false } }, /proof\.payloadFree must be true/u],
      [{ ...pat, proof: { ...pat.proof, readbackProvider: 'user-assertion' } }, /readbackProvider contains unsupported value/u],
      [{ ...pat, app: app.app }, /fine-grained-pat requires PAT metadata and no App metadata/u],
      [{ ...pat, pat: { ...pat.pat, selectedRepositoryOnly: false } }, /selectedRepositoryOnly must be true/u],
      [{ ...pat, pat: { ...pat.pat, createdBy: 'automation' } }, /createdBy must be manual-masked-entry/u],
      [{ ...app, pat: pat.pat }, /github-app requires app metadata and no PAT metadata/u],
      [{ ...app, app: { ...app.app, installationId: 0 } }, /app\.installationId must be positive/u],
      [{ ...app, app: { ...app.app, selection: 'all' } }, /app\.selection must be selected-repository/u],
      [{ ...app, app: { ...app.app, repositoryFullName: 'acme/other' } }, /app\.repositoryFullName must match the policy repository/u],
      [{ ...app, app: { ...app.app, token: { ...app.app!.token, ttlSeconds: 3601 } } }, /ttlSeconds must be between 1 and 3600/u],
      [{ ...pat, allowedWorkflows: [{ path: '.github/workflows/preflight.yml', jobs: [] }] }, /jobs must contain at least one job/u],
      [{ ...pat, allowedWorkflows: [{ path: 'scripts/preflight.yml', jobs: ['x'] }] }, /must be a GitHub Actions workflow path/u],
      [{ ...pat, allowedWorkflows: [...allowedWorkflows, ...allowedWorkflows] }, /duplicate workflow \.github\/workflows\/preflight\.yml/u],
      [{ ...pat, allowedWorkflows: [{ path: '.github/workflows/preflight.yml', jobs: ['a', 'a'] }] }, /contains duplicate value a/u],
      [{ ...pat, identity: historicalV1ActivationIdentity }, /Historical activation v\d+ is diagnostic-only/u]
    ];
    for (const [policy, expected] of refusals) expect(() => validateCredentialPolicy(policy)).toThrow(expected);
  });

});
