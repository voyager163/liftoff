import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyReviewedUpdateTransaction, inspectReviewedUpdateTransaction, recoverReviewedUpdateTransaction,
  type ReviewedUpdateApprovalStore, type ReviewedUpdateTransactionCheckpoint
} from '../src/adapters/filesystem/reviewed-update-transaction.js';
import { canonicalJson, canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import { canonicalPhaseGraph, currentActivationIdentity } from '../src/domain/governance/activation/graph.js';
import {
  finalizeActivationHistoryMigration, inspectActivationMigrationHistory, planActivationHistoryMigration,
  verifyActivationHistoryBeforeReplacement
} from '../src/governance-activation/migration-history.js';
import { captureHistoryFile } from '../src/governance-activation/historical-state.js';
import { writeHistoricalV2Fixture } from './fixtures/activation-v2/fixture.js';
import { buildProjectPlan } from '../src/application/project/planning.js';
import { generatedManifestStandards, preserveManifestProvenance } from '../src/application/project/manifest-provenance.js';
import { parseManifest } from '../src/application/project/manifest.js';
import { buildRepositoryGovernanceArtifacts } from '../src/application/repository-governance/artifacts.js';
import { rawHistoryDigest } from '../src/governance-activation/history-contracts.js';

const roots = new Set<string>();
const fingerprint = canonicalSha256({ approved: 'explicit local successor transaction' });
afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

function approvalStore(): ReviewedUpdateApprovalStore {
  const seals = new Set<string>();
  return {
    async write(plan, transaction) { seals.add(`${plan}:${transaction}`); },
    async verify(plan, transaction) { return seals.has(`${plan}:${transaction}`); },
    async remove(plan, transaction) { seals.delete(`${plan}:${transaction}`); }
  };
}

async function fixture() {
  const root = path.resolve('tests', `.activation-successor-transaction-${process.pid}-${randomUUID()}`);
  roots.add(root);
  await mkdir(root, { recursive: true });
  const source = await writeHistoricalV2Fixture(root);
  const plan = await planActivationHistoryMigration(root);
  if (plan.status !== 'eligible') throw new Error(JSON.stringify(plan));
  const finalized = finalizeActivationHistoryMigration(plan, fingerprint, new Date('2026-09-12T00:00:00.000Z'));
  const targetPlan = buildProjectPlan({
    projectName: source.manifest.project.name, projectType: 'standard', apiStack: 'node-fastify',
    cloud: 'azure', region: 'eastus', environments: ['dev', 'staging', 'prod'],
    specWorkflow: 'openspec', agents: ['github-copilot'], includeFrontend: false
  }, { requireProjectName: true });
  const core = buildRepositoryGovernanceArtifacts(targetPlan);
  const preserved = preserveManifestProvenance(parseManifest(source.manifest), source.files.get('liftoff.manifest.json')!);
  const manifest = {
    ...source.manifest, artifactVersion: 8, liftoffVersion: '0.13.0',
    standards: generatedManifestStandards(targetPlan), provenance: preserved.provenance,
    governance: { ...source.manifest.governance, policyVersion: currentActivationIdentity.policyVersion, activationIdentity: currentActivationIdentity },
    managedArtifacts: core.map((artifact) => ({
      logicalName: artifact.logicalName, category: artifact.category, pathParts: artifact.pathParts,
      contentHash: `sha256:${rawHistoryDigest(Buffer.from(artifact.content))}`
    }))
  };
  const mutations = [...finalized.mutations, ...core.map((artifact) => ({
    type: 'write' as const, pathParts: [...artifact.pathParts], content: artifact.content
  })), ...(preserved.history ? [preserved.history] : []),
  { type: 'write' as const, pathParts: ['liftoff.manifest.json'], content: canonicalJson(manifest) }];
  const store = approvalStore();
  return {
    root, source, plan, finalized, mutations, store,
    options: {
      planFingerprint: fingerprint, approvalStore: store, preconditions: finalized.preconditions,
      onBeforeMutation: (mutation: { pathParts: readonly string[] }) => verifyActivationHistoryBeforeReplacement(root, plan, mutation)
    }
  };
}

async function snapshot(root: string) {
  const files = new Map<string, Buffer>();
  async function walk(parts: string[]) {
    for (const entry of await readdir(path.join(root, ...parts), { withFileTypes: true })) {
      const child = [...parts, entry.name];
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) files.set(child.join('/'), await readFile(path.join(root, ...child)));
    }
  }
  await walk([]);
  return files;
}

describe('recoverable activation successor transaction', () => {
  it.each(['prepared', 'before-mutation', 'staged', 'after-mutation', 'before-commit'] as const)(
    'restores original active records and source bytes after failure at %s',
    async (phase) => {
      const f = await fixture();
      const before = await snapshot(f.root);
      await expect(applyReviewedUpdateTransaction(f.root, f.mutations, {
        ...f.options,
        async onCheckpoint(checkpoint: ReviewedUpdateTransactionCheckpoint) {
          if (checkpoint.phase === phase && (checkpoint.index === undefined || checkpoint.index === f.mutations.length - 2)) {
            throw new Error(`injected ${phase}`);
          }
        }
      })).rejects.toThrow(new RegExp(`injected ${phase}`));
      expect(await snapshot(f.root)).toEqual(before);
      expect(await inspectReviewedUpdateTransaction(f.root, { approvalStore: f.store })).toMatchObject({ status: 'absent' });
      expect(await planActivationHistoryMigration(f.root)).toMatchObject({ status: 'eligible' });
    }
  );

  it('verifies the completed byte inventory before retiring each exact original', async () => {
    const f = await fixture();
    const retired: string[] = [];
    await expect(applyReviewedUpdateTransaction(f.root, f.mutations, {
      ...f.options,
      async onBeforeMutation(mutation, index) {
        await f.options.onBeforeMutation(mutation);
        if (mutation.type === 'delete') {
          expect((await captureHistoryFile(f.root, f.plan.semanticPlan.successor.statePathParts)).content).toEqual(f.source.files.get('governance/activation-state.json'));
          expect(index).toBeGreaterThan(f.plan.index.files.length);
          retired.push(mutation.pathParts.join('/'));
        }
      }
    })).resolves.toMatchObject({ status: 'committed', committed: true, cleanupFailures: [] });
    expect(retired).toEqual(f.plan.requiredRetirements.map((entry) => entry.pathParts.join('/')));
    expect(retired.some((entry) => entry.endsWith('notes.txt'))).toBe(false);
    expect(await inspectActivationMigrationHistory(f.root)).toMatchObject({
      status: 'committed', journal: { laneId: 'activation-v2-to-v4', revalidation: { status: 'pending' } }
    });
  });

  it('rejects retirement if preservation has not completed', async () => {
    const f = await fixture();
    const original = f.plan.requiredRetirements[0];
    await expect(verifyActivationHistoryBeforeReplacement(f.root, f.plan, original)).rejects.toThrow(/must be verified/);
    expect((await captureHistoryFile(f.root, original.pathParts)).content).toBeDefined();
  });

  it('preserves unrelated edits during precommit rollback', async () => {
    const f = await fixture();
    await expect(applyReviewedUpdateTransaction(f.root, f.mutations, {
      ...f.options,
      async onCheckpoint(checkpoint) {
        if (checkpoint.phase === 'before-commit') {
          await writeFile(path.join(f.root, 'backend', 'src', 'index.ts'), 'concurrent user-owned edit\n');
          throw new Error('injected precommit stop');
        }
      }
    })).rejects.toThrow(/injected precommit stop/);
    expect(await readFile(path.join(f.root, 'backend', 'src', 'index.ts'), 'utf8')).toBe('concurrent user-owned edit\n');
    expect(await readFile(path.join(f.root, 'governance', 'activation-state.json'))).toEqual(f.source.files.get('governance/activation-state.json'));
  });

  it('retains committed v4 state through interrupted cleanup and bounded recovery without a new update', async () => {
    const f = await fixture();
    const outcome = await applyReviewedUpdateTransaction(f.root, f.mutations, {
      ...f.options,
      async onCheckpoint(checkpoint) {
        if (checkpoint.phase === 'committed') throw new Error('injected postcommit interruption');
      }
    });
    expect(outcome).toMatchObject({ status: 'committed', committed: true });
    expect(outcome.cleanupFailures.join(' ')).toContain('postcommit interruption');
    expect(await inspectReviewedUpdateTransaction(f.root, { approvalStore: f.store })).toMatchObject({ status: 'committed', committed: true });
    await expect(applyReviewedUpdateTransaction(f.root, f.mutations, f.options)).rejects.toThrow(/existing recovery journal/);
    const stateBefore = await readFile(path.join(f.root, 'governance', 'activation-state.json'));
    expect(await recoverReviewedUpdateTransaction(f.root, { approvalStore: f.store })).toMatchObject({ status: 'committed', committed: true });
    expect(await readFile(path.join(f.root, 'governance', 'activation-state.json'))).toEqual(stateBefore);
    expect(await inspectReviewedUpdateTransaction(f.root, { approvalStore: f.store })).toMatchObject({ status: 'absent' });
    expect(await planActivationHistoryMigration(f.root)).toMatchObject({ status: 'current', history: { status: 'committed' } });
  });
});
