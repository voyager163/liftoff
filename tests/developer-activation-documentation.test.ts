import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { phaseCapabilities } from '../src/domain/governance/activation/capabilities.js';
import { hclComputationPolicy } from '../src/adapters/hcl/parser-child.js';
import { modernActivationSourceContracts } from '../src/domain/governance/policy/identity.js';
import { currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import { localVerificationTransactionSchemaVersion } from '../src/domain/project/reviewed-update-artifacts.js';
import { localExecutionPolicy, openSpecReadOnlyExecutionPolicy, openSpecArchivedExecutionPolicy } from '../src/domain/governance/activation/modern-local-runtime.js';
import { openSpecDistributionPolicy } from '../src/domain/governance/activation/installed-tool-distribution.js';
import { openSpecReadSetPolicy, openSpecArchivedReadSetPolicy } from '../src/domain/governance/activation/modern-openspec-execution.js';
import { openSpecInitializationPolicy } from '../src/domain/governance/activation/modern-openspec-obligations.js';
import { localCompletionPolicy, specKitCompletionPolicy, nativeCompletionPath } from '../src/domain/governance/activation/modern-local-completion.js';

const developer = readFileSync(path.join(process.cwd(), 'DEVELOPER.md'), 'utf8').replace(/\r\n/g, '\n');
const completeness = developer.split('## Activation completeness and separate follow-up plan')[1]?.split('\n## ')[0] ?? '';
const phases = Object.entries(phaseCapabilities);
const byExecutor = (executor: string) => phases.filter(([, capability]) => capability.executor === executor).map(([id]) => id);

describe('developer activation-completeness guidance', () => {
  it('separates archived current-validation proof from historical execution and public routing',()=>{
    const section=developer.split('#### Private archived OpenSpec revalidation')[1]?.split('\n### ')[0]??'';
    for(const phrase of [
      '`prepareModernArchivedOpenSpecExecution', 'private preview schema5', '`archivedOpenSpecInputs`',
      'consent schema4', '`archivedOpenSpecInputDigest`', 'result schema4',
      'active schemas3/4 still reject', 'generic OpenSpec schema2 remains blocked',
      '`validate <capability> --type spec --strict --json --no-interactive`',
      '`validate --all --strict --json --no-interactive --concurrency 1`',
      '`validate --archived --strict --json --no-interactive --concurrency 1`',
      'not historical task', 'does not authorize cloud-agent setup', 'not a sandbox',
      'not changes to Purpose or requirement bodies', 'Raw source bytes remain bound',
      'Original transition/preparation identities', 'Source-only',
      'Fresh OpenSpec synchronization/archive', 'public v8', 'routing remain separate'
    ])expect(section).toContain(phrase);
    expect(section).toContain(`${openSpecArchivedReadSetPolicy.subjects}-subject ceiling`);
    expect(section).toContain(`1-${openSpecArchivedReadSetPolicy.tasks} nonempty completed tasks`);
    expect(section).toContain(`${openSpecArchivedReadSetPolicy.inputDescriptorBytes/1024}-KiB descriptor`);
    expect(section).toContain(`${openSpecArchivedExecutionPolicy.jsonProofBytes/1024}-KiB JSON`);
    expect(openSpecArchivedExecutionPolicy.basePolicy).toBe(localExecutionPolicy);
    expect(openSpecReadSetPolicy.scope).toContain('empty-archive');
  });

  it('states the actual executor counts from the release-owned capability table', () => {
    expect(completeness).toContain(`Of its ${phases.length} declared phases, ${byExecutor('built-in').length} have built-in handler paths, ` +
      `${byExecutor('injected-only').length} require an injected\nGitHub ruleset adapter`);
    expect(completeness).toContain(`and ${byExecutor('unavailable').length}\nfall back to an explicit missing-production-adapter blocker`);
  });

  it('lists exactly the phases without a production executor', () => {
    const listed = completeness.split('The missing production phase handlers are')[1]?.split('.\n')[0] ?? '';
    expect([...listed.matchAll(/`([a-z0-9-]+)`/g)].map((match) => match[1]).sort()).toEqual(byExecutor('unavailable').sort());
    for (const phase of byExecutor('injected-only')) expect(completeness).toContain(`\`${phase}\``);
  });

  it('describes approval and execution denial instead of a missing approval command', () => {
    expect(developer).not.toContain('no public approval-persistence');
    for (const phrase of [
      '`liftoff governance approve` persists exact approval envelopes, but it refuses a\nphase whose capability is unavailable or blocked',
      '`governance apply-next --execute` likewise stops before\nany saved plan, intent, or producer effect',
      '`provider-ready` and `state-path-selected` no longer report\nsynthetic verified success'
    ]) {
      expect(completeness).toContain(phrase);
    }
    for (const phase of ['provider-ready', 'state-path-selected'] as const) expect(phaseCapabilities[phase].executor).toBe('unavailable');
  });

  it('keeps credential readiness unavailable until independent readback exists', () => {
    expect(phaseCapabilities['credential-ready'].blocker).toMatch(/Independent credential readback/);
    expect(completeness).toContain('`credential-ready` and the public\n`governance credential-enroll` path remain unavailable pending independent\ncredential readback');
    expect(completeness).toContain('Implement secure credential enrollment with independent readback before\n   `credential-ready` can be approved or executed');
  });

  it('distinguishes private modern observation from execution and public migration', () => {
    const local = developer.split('### Private modern local verification')[1]?.split('\n## ')[0] ?? '';
    for (const phrase of [
      '`inspectModernLocalVerification`', '`planModernLocalVerification`', '`reinspectModernLocalVerification`',
      '`execution: "not-authorized"`', 'Caller-supplied ASTs', 'public v8 migration remains gated',
      'installed activation payloads and retained source\nhistory remain blocked',
      'not a total-RSS cap, an OS sandbox or arbitrary process-tree control',
      'Manual skips external-framework checks; governance `none` alone does not'
    ]) expect(local).toContain(phrase);
    const runtime = hclComputationPolicy.qualifiedRuntime;
    expect(local).toContain(`${runtime.platform}/${runtime.arch}/Node${runtime.node}`);
    expect(local).toContain(`${hclComputationPolicy.childDeadlineMs / 1000} seconds per child`);
    expect(local).toContain(`${hclComputationPolicy.derivationDeadlineMs / 1000} seconds per derivation`);
  });

  it('separates published defaults, exact private source contracts and protected state work', () => {
    const manifests = readFileSync(path.join(process.cwd(), 'docs/configuration-and-manifests.md'), 'utf8');
    const state = readFileSync(path.join(process.cwd(), 'src/application/state-migration/README.md'), 'utf8');
    const sources = modernActivationSourceContracts();
    expect(sources).toHaveLength(6);
    for (const source of sources) {
      const identity = source.identity;
      expect(manifests).toContain(`\`${identity.liftoffVersion}\``);
      expect(manifests).toContain(`| Manifest | ${identity.manifestArtifactVersion} |`);
      expect(manifests).toContain(`| Activation contract / state / evidence header / approval envelope | ${identity.activationContractVersion} |`);
      expect(manifests).toContain(`| Phase graph / saved transition plan | ${source.savedPlanSchemaVersion} |`);
      expect(manifests).toContain(`| Compatibility metadata | ${source.compatibilityMetadataSchemaVersion} |`);
    }
    expect(manifests).toContain(`activation-contract version\n  ${currentActivationIdentity.activationContractVersion}`);
    for (const phrase of [
      'Public generation still writes v7; public v8 migration remains gated',
      '`createManifestV8Reader`', '`createManifestV8Candidate`',
      '`adoptionObservations`', 'not the deferred activation',
      'source-metadata2/task-projection producer', 'retention due times',
      'not downgrade them'
    ]) expect(manifests).toContain(phrase);
    for (const phrase of [
      'private API, not an enabled public existing-deployment migration',
      'planning-only', 'cannot authorize any state operation',
      'same recorded operation', 'does not authorize arbitrary brownfield state access'
    ]) expect(state).toContain(phrase);
  });

  it('documents installed preflight and project-attributed publication without claiming execution', () => {
    const section = developer.split('### Installed preflight and durable local publication primitives')[1]?.split('\n## ')[0] ?? '';
    for (const phrase of [
      '`inspectModernInstalledActivation`', '`validateCapturedModernInstalledActivation`',
      '`inspectModernLocalRuntime`', '`planModernLocalRuntime`', '`reinspectModernLocalRuntime`',
      '`applyLocalVerificationTransaction`', '`recoverLocalVerificationTransaction`',
      '`LocalVerificationTransactionAuthorityStore`', 'exact canonical project root',
      'Record-format acceptance is not', 'separate publication consent',
      'Stale locks are not automatically reaped',
      '`publication: "codec-unavailable-not-authorized"`',
      'private prerequisites, not a wired execution/publication journey'
    ]) expect(section).toContain(phrase);
    expect(section).toContain(`outer journal schema ${localVerificationTransactionSchemaVersion}`);
  });

  it('keeps active maintenance, original target preservation and execution readiness separate', () => {
    const manifests = readFileSync(path.join(process.cwd(), 'docs/configuration-and-manifests.md'), 'utf8');
    const state = readFileSync(path.join(process.cwd(), 'src/application/state-migration/README.md'), 'utf8');
    for (const phrase of [
      '`active-core-manifest-maintenance-only`', '`inspectModernMaintenanceSource`',
      'source data, not installed\nexecution readiness', 'captured JSON collection membership',
      'original transition', 'preparation, successor anchor', 'Exact existing\nmaterial can be reused, never overwritten',
      'No-op/core-only maintenance creates no copy', 'An existing reference is preserved, not chained',
      'Public routing and modern finite local revalidation remain unwired'
    ]) expect(developer).toContain(phrase);
    for (const document of [developer, manifests, state]) {
      expect(document).toContain('`activationTargetHistory`');
      expect(document).toContain('.liftoff/activation-target-history/');
    }
    expect(manifests).toContain('Active maintenance returns `committed-incomplete`, not\nrevalidated success');
    expect(state).toContain('cannot reconstruct\nmissing originals from an audit, retag proof, authorize state access');
  });

  it('separates actual private execution consent from publication and readiness', () => {
    const section = developer.split('### Private modern local execution and consent')[1]?.split('\n## ')[0] ?? '';
    for (const phrase of [
      '`prepareModernLocalExecution`', '`approveModernLocalExecution`',
      '`executeModernLocalExecution`', '`inspectModernLocalExecution`',
      '`LocalExecutionRecordStore`', '`operationKind: "local-execution"`',
      'one-shot claim', 'before dispatch', 'process-tree settlement',
      'not a sandbox', 'network preparation is rejected even with',
      'No\ncaller-selected subset', 'Uncertainty retains the workspace',
      '`workflowFinalization`', '`publishLocalRecords`', 'second approval of observed',
      'independent\npostcommit readback', 'Public migration stays gated'
    ]) expect(section).toContain(phrase);
    expect(section).toContain(`${localExecutionPolicy.checks} checks`);
    expect(section).toContain(`${localExecutionPolicy.checkTimeoutMs / 1000} seconds`);
    expect(section).toContain(`${localExecutionPolicy.checkOutputBytes / 1024} KiB output per check`);
    expect(section).toContain(`${localExecutionPolicy.preparationTimeoutMs / 1000} seconds`);
    expect(section).toContain(`${localExecutionPolicy.operationTimeoutMs / 1000} seconds per operation`);
    expect(section).toContain(`${localExecutionPolicy.approvalLifetimeMs / 60000} minutes`);
  });

  it('documents private Manual completion, exact recovery attribution and uncertain cleanup', () => {
    const section = developer.split('### Private local completion and attributed recovery')[1]?.split('\n## ')[0] ?? '';
    for (const phrase of [
      '`prepareModernLocalFinalization`', '`approveModernLocalFinalization`',
      '`finalizeModernLocalCompletion`', '`approveModernLocalPublication`',
      '`publishModernLocalCompletion`', '`inspectModernLocalCompletion`',
      '`recoverModernLocalCompletion`', 'second exact-byte consent',
      'original pre-execution baseline plan and state hash are preserved',
      'Governance-none produces only', 'never activation state, identity or approval4',
      '`expectedTransaction`', 'checked under the same mutation lock',
      'before rollback, journal cleanup or seal removal',
      'replacement or disappeared', '`committed-cleanup-pending`',
      'not deployment readiness', 'Manual and fixed Spec Kit bootstrap completion only',
      'source-metadata2/task projection', 'Manual retains schema1', 'Spec Kit uses private schema2',
      '`workflowWrites: true`', '`completedSpecKitTasks`', 'workflow-original artifact',
      'planned in-process `framework-source` check', 'no `specify` probe or initializer',
      'CRLF/LF', 'no\ntask operation or target', '`fileChanges`', '`inputBindings`',
      'not official initializer provenance'
    ]) expect(section).toContain(phrase);
    expect(section).toContain(`\`${nativeCompletionPath.join('/')}\``);
    expect(section).toContain(`${localCompletionPolicy.recordBytes / 1024}-KiB records`);
    expect(section).toContain(`${localCompletionPolicy.artifacts} artifacts/mutations`);
    expect(localCompletionPolicy.artifacts).toBe(localCompletionPolicy.mutations);
    expect(section).toContain(`${localCompletionPolicy.approvalLifetimeMs / 60000}-minute approvals`);
    expect(section).toContain(`\`${specKitCompletionPolicy.taskPath.join('/')}\``);
    expect(section).toContain(`${specKitCompletionPolicy.taskIds[0]}-${specKitCompletionPolicy.taskIds.at(-1)} checkbox characters`);
    expect(specKitCompletionPolicy.artifacts).toBe(localCompletionPolicy.artifacts);
    expect(specKitCompletionPolicy.recordBytes).toBe(localCompletionPolicy.recordBytes);
  });

  it('documents complete OpenSpec identity without granting workflow execution', () => {
    const section = developer.split('#### OpenSpec distribution identity and blocked previews')[1]?.split('\n### ')[0] ?? '';
    for (const phrase of [
      'Two matching bounded passes', 'Current use reconstructs the inventory',
      'not publisher authentication', 'not sufficient', 'atomic filesystem lease',
      'private schema2', '`openspec-workflow-inputs-unqualified`',
      'Legacy OpenSpec schema1', 'matching finished progress',
      'Manual and\nSpec Kit execution schema1 remain unchanged', '64-KiB preview limit'
    ]) expect(section).toContain(phrase);
    expect(section).toContain(`${openSpecDistributionPolicy.files} files`);
    expect(section).toContain(`${openSpecDistributionPolicy.directories} directories`);
    expect(section).toContain(`${openSpecDistributionPolicy.symlinks} symlinks`);
    expect(section).toContain(`${openSpecDistributionPolicy.totalBytes / 1024 / 1024} MiB total`);
    const contributing = readFileSync(path.join(process.cwd(), 'CONTRIBUTING.md'), 'utf8');
    for (const phrase of [
      '#### OpenSpec identity qualification', 'OB1_VERSION_REMAINING=2 OB1_SUPPORT_REMAINING=10',
      'tests/installed-tool-distribution.test.ts tests/modern-openspec-tool-identity.test.ts',
      'budgets alone never enables them', 'before\nnative fixtures or tool lookup',
      'Do not count the two skipped cases as qualified'
    ]) expect(contributing).toContain(phrase);
  });

  it('separates private OpenSpec read-only execution from initialization and finalization', () => {
    const section = developer.split('#### Private OpenSpec read-only execution')[1]?.split('\n### ')[0] ?? '';
    for (const phrase of [
      '`prepareModernOpenSpecExecution(root, { kind: \'verify-openspec-local\', preparation })`',
      'private schema3', '`openSpecInputs`', 'consent schema2', '`openSpecInputDigest`',
      'result schema2', 'exact validated machine\nJSON', 'fresh exact consent before CAS',
      'directory presence and\nmembership', 'Unrelated nonoverlapping active',
      'Custom schemas', 'store metadata', 'nonempty archives', 'overlapping\nactive capabilities',
      'unknown members and ambiguous subjects reject before tools',
      '`validate --all --strict --json --no-interactive --concurrency 1`',
      'original\ntask descriptions and checkboxes', 'warning-free\ntotals',
      'fresh owned empty HOME/config/data/cache', 'not a sandbox',
      'preinitialized\ncontracts, not official initializer provenance',
      'initialization task stays unchecked', 'no\n`tofu init`, task writes',
      'OpenSpec finalization remains unavailable'
    ]) expect(section).toContain(phrase);
    expect(section).toContain(`${openSpecReadSetPolicy.inputDescriptorBytes / 1024} KiB`);
    expect(section).toContain(`${openSpecReadOnlyExecutionPolicy.jsonProofBytes / 1024} KiB`);
    const contributing = readFileSync(path.join(process.cwd(), 'CONTRIBUTING.md'), 'utf8');
    for (const phrase of [
      '#### OpenSpec execution qualification', 'LIFTOFF_OPENSPEC_B_TESTS=1',
      'tests/modern-openspec-execution.test.ts', 'six native cases unrun',
      'not metadata alone', 'not native execution', 'Serialize tool-intensive runs',
      'when settlement is unknown'
    ]) expect(contributing).toContain(phrase);
  });

  it('bounds private OpenSpec initialization without claiming finalization or generated Azure completion', () => {
    const section = developer.split('#### Private OpenSpec initialized-baseline execution')[1]?.split('\n### ')[0] ?? '';
    for (const phrase of [
      '`prepareModernOpenSpecInitializedBaseline(root, { kind: \'verify-openspec-initialized\', preparation })`',
      'private schema4', '`approveModernOpenSpecInitializedBaseline`', 'consent schema3',
      '`dependencyPreparation: true`', '`dependencyNetwork: false`',
      '`generatedBaselineReviewed: true`', '`domainBehaviorDeferred: true`',
      'Result schema3', '`initialization-obligations-observed`',
      'unknown, missing or duplicate tasks', 'checkbox states and CRLF are preserved',
      'provider-free, no-module,\nno-resource', 'same fresh owned empty directory',
      'immutable CLI configuration', 'inherited\nenvironment settings are cleared',
      'Both writer and reader enforce', 'not a\nsandbox or an atomic filesystem lease',
      'No original project\nis initialized', 'task `3.1` is not completed',
      'full generated Azure', 'public routing remain\nunavailable'
    ]) expect(section).toContain(phrase);
    expect(section).toContain(openSpecInitializationPolicy.markerProvenance);
    expect(section).toContain(`\`tofu ${openSpecInitializationPolicy.initArgs.join(' ')}\``);
    expect(section).toContain(`${openSpecInitializationPolicy.descriptorBytes / 1024} KiB and ${openSpecInitializationPolicy.roots} roots`);
    expect(section).toContain(`${openSpecInitializationPolicy.dataFiles} files and ${openSpecInitializationPolicy.dataDirectories} directories`);
    expect(section).toContain(`${openSpecInitializationPolicy.dataFiles + openSpecInitializationPolicy.dataDirectories}-entry bound`);
    expect(section).toContain(`Files are at most ${openSpecInitializationPolicy.dataFileBytes / 1024} KiB`);
    expect(section).toContain(`total file bytes at most ${openSpecInitializationPolicy.dataBytes / 1024} KiB`);
    expect(section).toContain(`relative depth at most ${openSpecInitializationPolicy.dataDepth}`);
    const contributing = readFileSync(path.join(process.cwd(), 'CONTRIBUTING.md'), 'utf8');
    for (const phrase of [
      '#### OpenSpec initialization qualification', 'LIFTOFF_OI_TESTS=1',
      'tests/modern-openspec-obligations.test.ts tests/modern-openspec-initialization.test.ts',
      'forced\n`portable` leaves them unrun even if that flag is set',
      'Synthetic\nreceipt controls are not initializer or native-output provenance',
      '`init --tools github-copilot --profile custom --no-copilot-cloud`',
      'it is not proof of a real interrupted native', 'exact source bytes',
      'A prior native run is not fresh qualification of a later correction'
    ]) expect(contributing).toContain(phrase);
  });
});
