import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  finalizeActivationHistoryMigration, inspectActivationMigrationHistory, planActivationHistoryMigration
} from '../src/governance-activation/migration-history.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { inspectGovernanceTransition } from '../src/application/repository-governance/inspection.js';
import { buildSavedTransitionPlan } from '../src/governance-activation/transition-planning.js';
import { planHistoricalPublicationReadback, executeHistoricalPublicationReadback } from '../src/application/repository-governance/publication-revalidation.js';
import { currentActivationIdentity, canonicalPhaseGraph } from '../src/domain/governance/activation/graph.js';
import type { CommandRunner, RunCommandOptions } from '../src/process-runner.js';
import type { ExternalCommand } from '../src/domain/project/contracts.js';
import type { GitHubActivationTransport, GitHubRequest } from '../src/adapters/github/activation-rest.js';
import { successorFixtureManifest } from './governance-activation-fixtures.js';
import { publicationHead, publicationInputs, publicationRepository, writeHistoricalV3Fixture } from './fixtures/activation-v3/fixture.js';
import type { GovernanceTransitionAdapters } from '../src/governance-activation/transition-ports.js';

const roots = new Set<string>();
const now = new Date('2026-09-12T00:00:00.000Z');
afterEach(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); roots.clear(); });

class PublicationReads implements CommandRunner {
  readonly calls: string[][] = [];
  head = publicationHead;
  branch = 'develop';
  status = ' M liftoff.manifest.json\0 M .liftoff/governance/phase-graph.json\0';
  pushUrl = `https://github.com/${publicationRepository}.git`;
  constructor(readonly root: string) {}
  async run(command: ExternalCommand, _options: RunCommandOptions = {}) {
    expect(command.executable).toBe('git');
    this.calls.push([...command.args]);
    const key = command.args.join(' ');
    const values: Record<string, string> = {
      'rev-parse --show-toplevel': this.root,
      'rev-parse --verify HEAD': this.head,
      'symbolic-ref --quiet --short HEAD': this.branch,
      remote: 'origin',
      'remote get-url --push --all origin': this.pushUrl,
      'status --porcelain=v1 -z --untracked-files=all': this.status
    };
    if (!(key in values)) throw new Error(`Unapproved command in readback regression: git ${key}`);
    return { status: 0, stdout: values[key]!, stderr: '' };
  }
}

class GitHubReads implements GitHubActivationTransport {
  readonly requests: GitHubRequest[] = [];
  head = publicationHead;
  id = 42;
  async request(request: GitHubRequest) {
    expect(request.method).toBe('GET');
    this.requests.push(request);
    return {
      status: 200, headers: {},
      data: request.path.endsWith('/git/ref/heads/develop')
        ? { ref: 'refs/heads/develop', object: { sha: this.head, type: 'commit' } }
        : { id: this.id, full_name: publicationRepository, default_branch: 'develop' }
    };
  }
}

async function migratedFixture() {
  const root = path.resolve('tests', `.publication-v3-${randomUUID()}`);
  roots.add(root);
  const source = await writeHistoricalV3Fixture(root);
  const sourcePlan = await planActivationHistoryMigration(root);
  if (sourcePlan.status !== 'eligible') throw new Error(JSON.stringify(sourcePlan));
  expect(sourcePlan.semanticPlan.laneId).toBe('activation-v3-to-v4');
  const committed = finalizeActivationHistoryMigration(sourcePlan, canonicalSha256({ reviewed: sourcePlan.planDigest }), now);
  for (const mutation of committed.mutations) {
    const target = path.join(root, ...mutation.pathParts);
    if (mutation.type === 'delete') await unlink(target);
    else {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, mutation.content, { mode: mutation.mode });
    }
  }
  await writeFile(path.join(root, 'liftoff.manifest.json'), JSON.stringify(await successorFixtureManifest(root)));
  await mkdir(path.join(root, '.git'));
  const runner = new PublicationReads(root);
  const inspection = await inspectGovernanceTransition(root, { runner, now, scope: 'activation', activationInputs: publicationInputs });
  const transport = new GitHubReads();
  return { root, source, sourcePlan, committed, runner, inspection, transport };
}

describe('affected v3 publication readback after reviewed v4 successor', () => {
  it('preserves original plans, approvals and receipts and exposes only finite read operations', async () => {
    const fixture = await migratedFixture();
    const history = await inspectActivationMigrationHistory(fixture.root);
    expect(history.status).toBe('committed');
    expect(fixture.inspection.state.identity).toEqual(currentActivationIdentity);
    for (const original of fixture.sourcePlan.index.files) {
      expect(await readFile(path.join(fixture.root, ...original.copyPathParts)))
        .toEqual(fixture.source.files.get(original.originalPathParts.join('/')));
    }
    for (const phase of ['committed', 'pushed'] as const) {
      const plan = await buildSavedTransitionPlan({ inspection: fixture.inspection, phaseId: phase, runner: fixture.runner, now });
      expect(plan!.operations.filter((operation) => operation.adapter === 'git')).toMatchObject([{
        actionId: phase === 'committed' ? 'git.verify-existing-commit' : 'git.verify-existing-push',
        mutationClass: phase === 'committed' ? 'read-worktree' : 'github-read'
      }]);
      expect(plan!.operations.some((operation) => ['git-commit', 'git-push', 'github-write'].includes(operation.mutationClass))).toBe(false);
      expect(plan!.approval.required).toBe(true);
    }
    expect(fixture.transport.requests).toEqual([]);
  });

  it('uses independent exact repository/ref readback without another commit or push', async () => {
    const fixture = await migratedFixture();
    const plan = await buildSavedTransitionPlan({ inspection: fixture.inspection, phaseId: 'pushed', runner: fixture.runner, now });
    const phase = canonicalPhaseGraph.phases.find((phase) => phase.id === 'pushed')!;
    const outcome = await executeHistoricalPublicationReadback({
      inspection: fixture.inspection, plan: plan!, phase, runner: fixture.runner, now,
      adapters: { githubActivation: { transport: fixture.transport } } as GovernanceTransitionAdapters
    });
    expect(outcome).toMatchObject({
      status: 'completed', resultState: 'verified',
      evidencePayload: { head: publicationHead, publicationRevalidation: {
        sourceSnapshotId: fixture.sourcePlan.index.snapshotId, inputAlgorithm: 'phase-consumed-v4', newLocalMetadataPublished: false
      } },
      stateOverride: { remoteBinding: { id: '42', name: publicationRepository } }
    });
    expect(fixture.transport.requests.map((request) => request.path)).toEqual([
      `/repos/${publicationRepository}`, `/repos/${publicationRepository}/git/ref/heads/develop`
    ]);
    expect(fixture.runner.calls.some((args) => ['commit', 'push', 'reset', 'rebase'].includes(args[0]!))).toBe(false);
    expect(outcome!.stateOverride!.repository.id).toBe(fixture.inspection.state.repository.id);
  });

  it.each(['local-head', 'branch', 'repository', 'source', 'workflow'] as const)('refuses changed %s publication facts before remote observation', async (change) => {
    const fixture = await migratedFixture();
    if (change === 'local-head') fixture.runner.head = 'd'.repeat(40);
    if (change === 'branch') fixture.runner.branch = 'main';
    if (change === 'repository') fixture.runner.pushUrl = 'https://github.com/example-org/another.git';
    if (change === 'source') fixture.runner.status += ' M backend/src/index.ts\0';
    if (change === 'workflow') fixture.runner.status += '?? .github/workflows/unpublished.yml\0';
    await expect(planHistoricalPublicationReadback(fixture.inspection, 'pushed', fixture.runner)).rejects.toThrow(/changed|unpublished/);
    expect(fixture.transport.requests).toEqual([]);
  });

  it.each(['remote-head', 'repository-id'] as const)('refuses mismatched %s without rewriting history or publication', async (change) => {
    const fixture = await migratedFixture();
    const plan = await buildSavedTransitionPlan({ inspection: fixture.inspection, phaseId: 'pushed', runner: fixture.runner, now });
    if (change === 'remote-head') fixture.transport.head = 'd'.repeat(40);
    else fixture.transport.id = 43;
    const outcome = await executeHistoricalPublicationReadback({
      inspection: fixture.inspection, plan: plan!, phase: canonicalPhaseGraph.phases.find((phase) => phase.id === 'pushed')!,
      runner: fixture.runner, now, adapters: { githubActivation: { transport: fixture.transport } } as GovernanceTransitionAdapters
    });
    expect(outcome).toMatchObject({ status: 'blocked', completedOperations: [] });
    for (const original of fixture.sourcePlan.index.files) {
      expect(await readFile(path.join(fixture.root, ...original.copyPathParts)))
        .toEqual(fixture.source.files.get(original.originalPathParts.join('/')));
    }
  });
});
