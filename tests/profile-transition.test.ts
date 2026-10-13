import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  projectMutationLockPath
} from '../src/adapters/filesystem/project-lock.js';
import { parseProjectManifest } from '../src/application/project/manifest.js';
import {
  assertProfileTransitionPlanCurrent,
  assertProfileTransitionControlsCurrent,
  prepareProfileTransitionPlan,
  rebuildProfileTransitionCandidate,
  readConfiguredProfileTransitionTarget,
  readProfileTransitionPlan
} from '../src/application/profile-transition/plan.js';
import {
  applyProfileTransitionPlan,
  recoverProfileTransitionPlan
} from '../src/application/profile-transition/execution.js';
import {
  applyProfileTransitionTransaction
} from '../src/adapters/filesystem/reviewed-update-transaction.js';
import {
  createProfileTransitionTransactionAuthorityStore
} from '../src/application/profile-transition/transaction-authority.js';
import {
  freshManifestFixture,
  inventory,
  write
} from './fixtures/manifest-update.js';

const now = new Date('2026-10-09T00:00:00.000Z');

describe('reviewed governance profile transition', () => {
  it('commits only target managed policy and manifest bytes while preserving stronger controls and old proof', async () => {
    const project = await freshManifestFixture(
      'single-maintainer-gitflow',
      'openspec'
    );
    await write(project.root, ['liftoff.config.json'], JSON.stringify({
      governanceProfile: 'team-gitflow'
    }));
    await write(project.root, ['.github', 'CODEOWNERS'], '* @maintainers\n');
    await write(project.root, ['governance', 'rulesets', 'team.json'], JSON.stringify({
      target: 'branch',
      enforcement: 'active',
      bypass_actors: [],
      rules: [{
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 2,
          require_code_owner_review: true,
          require_last_push_approval: true,
          dismiss_stale_reviews_on_push: true
        }
      }]
    }));
    await write(project.root, ['governance', 'activation-state.json'], '{"historical":true}\n');
    await write(project.root, ['governance', 'evidence', 'old.json'], '{"proof":"old"}\n');
    const before = await inventory(project.root);

    expect(await readConfiguredProfileTransitionTarget(project.root))
      .toBe('team-gitflow');
    const preview = await prepareProfileTransitionPlan(
      project.root,
      'team-gitflow',
      { now, storage: project.options }
    );
    expect(preview.plan).toMatchObject({
      source: { profile: 'single-maintainer-gitflow', policyVersion: '7' },
      target: { profile: 'team-gitflow', policyVersion: '1' },
      controls: {
        proposedWeakening: false,
        deploymentSafeguards: 'live-settings-untouched',
        rulesets: [{
          requiredApprovals: 2,
          codeOwnerReview: true,
          lastPushApproval: true,
          dismissStaleReviews: true
        }]
      },
      evidenceBoundary: {
        preserved: true,
        reusableForTarget: false
      },
      execution: {
        providerOperations: false,
        applicationFiles: 'preserved',
        gitHistory: 'preserved',
        workflow: 'preserved'
      }
    });
    expect(preview.plan.controls.codeowners).toHaveLength(1);
    expect(preview.plan.effects.map(effect => effect.pathParts.join('/')))
      .not.toEqual(expect.arrayContaining([
        'application.txt',
        '.github/CODEOWNERS',
        'governance/rulesets/team.json',
        'governance/activation-state.json',
        'governance/evidence/old.json',
        'liftoff.config.json'
      ]));
    expect(await readProfileTransitionPlan(
      project.root,
      preview.plan.fingerprint,
      now,
      project.options
    )).toEqual(preview.plan);
    await assertProfileTransitionPlanCurrent(preview.plan);

    const result = await applyProfileTransitionPlan(preview.plan, {
      now,
      storage: project.options
    });
    expect(result).toMatchObject({
      operation: 'apply',
      status: 'committed',
      committed: true,
      rollbackFailures: [],
      cleanupFailures: [],
      readbackFailures: []
    });
    const manifest = parseProjectManifest(JSON.parse(await readFile(
      path.join(project.root, 'liftoff.manifest.json'),
      'utf8'
    )));
    expect(manifest.governance).toMatchObject({
      profile: 'team-gitflow',
      policyVersion: '1'
    });
    expect(manifest.project).toEqual(project.current.project);
    expect(manifest.framework).toEqual(project.current.framework);
    expect(await readConfiguredProfileTransitionTarget(project.root)).toBeNull();
    const after = await inventory(project.root);
    for (const preserved of [
      'application.txt',
      '.github/CODEOWNERS',
      'governance/rulesets/team.json',
      'governance/activation-state.json',
      'governance/evidence/old.json',
      'liftoff.config.json'
    ]) {
      expect(after[preserved]).toEqual(before[preserved]);
    }
    expect(await recoverProfileTransitionPlan(
      project.root,
      preview.plan.fingerprint,
      { now, storage: project.options }
    )).toMatchObject({
      operation: 'recover',
      status: 'absent',
      committed: false
    });
  });

  it('rejects configuration changes after approval without writing project files', async () => {
    const project = await freshManifestFixture(
      'single-maintainer-gitflow',
      'openspec'
    );
    await write(project.root, ['liftoff.config.json'], JSON.stringify({
      governanceProfile: 'team-gitflow'
    }));
    const preview = await prepareProfileTransitionPlan(
      project.root,
      'team-gitflow',
      { now, storage: project.options }
    );
    await write(project.root, ['liftoff.config.json'], JSON.stringify({
      governanceProfile: 'none'
    }));
    const changed = await inventory(project.root);
    await expect(assertProfileTransitionPlanCurrent(preview.plan))
      .rejects.toThrow(/configured governance profile|inputs changed/iu);
    await expect(applyProfileTransitionPlan(preview.plan, {
      now,
      storage: project.options
    })).rejects.toThrow();
    expect(await inventory(project.root)).toEqual(changed);
  });

  it.each(['codeowners', 'ruleset-membership'] as const)(
    'rolls back when reviewed %s controls change before commit',
    async changedControl => {
      const project = await freshManifestFixture(
        'single-maintainer-gitflow',
        'openspec'
      );
      await write(project.root, ['liftoff.config.json'], JSON.stringify({
        governanceProfile: 'team-gitflow'
      }));
      await write(project.root, ['.github', 'CODEOWNERS'], '* @maintainers\n');
      await write(
        project.root,
        ['governance', 'rulesets', 'primary.json'],
        JSON.stringify({
          rules: [{
            type: 'pull_request',
            parameters: {
              required_approving_review_count: 2,
              dismiss_stale_reviews_on_push: true
            }
          }]
        })
      );
      const preview = await prepareProfileTransitionPlan(
        project.root,
        'team-gitflow',
        { now, storage: project.options }
      );
      const candidate = await rebuildProfileTransitionCandidate(preview.plan);
      await expect(applyProfileTransitionTransaction(
        project.root,
        candidate.mutations,
        {
          planFingerprint: preview.plan.fingerprint,
          authorityStore: createProfileTransitionTransactionAuthorityStore(
            project.root,
            project.options
          ),
          preconditions: candidate.preconditions,
          expectedCandidateBinding:
            preview.plan.execution.transactionCandidateBinding,
          validateCurrentInputs: async stage => {
            if (stage === 'before-commit') {
              await assertProfileTransitionControlsCurrent(preview.plan);
            } else {
              await assertProfileTransitionPlanCurrent(preview.plan);
            }
          },
          onCheckpoint: async checkpoint => {
            if (checkpoint.phase !== 'before-commit') return;
            if (changedControl === 'codeowners') {
              await write(
                project.root,
                ['.github', 'CODEOWNERS'],
                '* @different-maintainers\n'
              );
            } else {
              await write(
                project.root,
                ['governance', 'rulesets', 'new.json'],
                '{"rules":[]}\n'
              );
            }
          }
        }
      )).rejects.toThrow(
        /Governance controls changed after profile-transition review.*All attributable changes were rolled back/iu
      );
      const manifest = parseProjectManifest(JSON.parse(await readFile(
        path.join(project.root, 'liftoff.manifest.json'),
        'utf8'
      )));
      expect(manifest.governance.profile).toBe(
        'single-maintainer-gitflow'
      );
    }
  );

  it.each([
    ['single-maintainer-gitflow', '7'],
    ['none', null]
  ] as const)(
    'transitions Team GitFlow to %s while preserving source-only managed bytes as orphans',
    async (targetProfile, policyVersion) => {
      const project = await freshManifestFixture('team-gitflow', 'openspec');
      await write(project.root, ['liftoff.config.json'], JSON.stringify({
        governanceProfile: targetProfile
      }));
      const before = await inventory(project.root);
      const preview = await prepareProfileTransitionPlan(
        project.root,
        targetProfile,
        { now, storage: project.options }
      );
      expect(preview.plan).toMatchObject({
        source: { profile: 'team-gitflow', policyVersion: '1' },
        target: { profile: targetProfile, policyVersion },
        evidenceBoundary: {
          preserved: true,
          reusableForTarget: false
        }
      });
      const orphans = preview.plan.effects.filter(
        effect => effect.operation === 'preserve-orphan'
      );
      if (targetProfile === 'none') {
        expect(orphans.length).toBeGreaterThan(0);
      }

      const result = await applyProfileTransitionPlan(preview.plan, {
        now,
        storage: project.options
      });
      expect(result).toMatchObject({
        status: 'committed',
        committed: true,
        rollbackFailures: [],
        cleanupFailures: [],
        readbackFailures: []
      });
      const manifest = parseProjectManifest(JSON.parse(await readFile(
        path.join(project.root, 'liftoff.manifest.json'),
        'utf8'
      )));
      expect(manifest.governance.profile).toBe(targetProfile);
      expect(manifest.governance.profile === 'none'
        ? null
        : manifest.governance.policyVersion).toBe(policyVersion);
      const managedNames = new Set(
        manifest.managedArtifacts.map(entry => entry.logicalName)
      );
      const after = await inventory(project.root);
      for (const orphan of orphans) {
        const artifactPath = orphan.pathParts.join('/');
        expect(after[artifactPath]).toEqual(before[artifactPath]);
        expect(managedNames.has(orphan.logicalName)).toBe(false);
      }
      expect(after['application.txt']).toEqual(before['application.txt']);
      expect(after['liftoff.config.json']).toEqual(before['liftoff.config.json']);
    }
  );

  it('requires separately approved deactivation before selecting none', async () => {
    const project = await freshManifestFixture('team-gitflow', 'openspec');
    await write(project.root, ['liftoff.config.json'], JSON.stringify({
      governanceProfile: 'none'
    }));
    await write(
      project.root,
      ['governance', 'activation-state.json'],
      '{"schemaVersion":4}\n'
    );
    const before = await inventory(project.root);
    await expect(prepareProfileTransitionPlan(
      project.root,
      'none',
      { now, storage: project.options }
    )).rejects.toThrow(/deactivated.*separately approved/iu);
    expect(await inventory(project.root)).toEqual(before);
  });

  it('rolls back an exact interrupted profile transition without minting a new plan', async () => {
    const project = await freshManifestFixture(
      'single-maintainer-gitflow',
      'openspec'
    );
    await write(project.root, ['liftoff.config.json'], JSON.stringify({
      governanceProfile: 'team-gitflow'
    }));
    const preview = await prepareProfileTransitionPlan(
      project.root,
      'team-gitflow',
      { now, storage: project.options }
    );
    const before = await inventory(project.root);
    const loaderUrl = new URL(
      './fixtures/source-typescript-loader.mjs',
      import.meta.url
    ).href;
    const transactionUrl = new URL(
      '../src/adapters/filesystem/reviewed-update-transaction.ts',
      import.meta.url
    ).href;
    const planUrl = new URL(
      '../src/application/profile-transition/plan.ts',
      import.meta.url
    ).href;
    const authorityUrl = new URL(
      '../src/application/profile-transition/transaction-authority.ts',
      import.meta.url
    ).href;
    const child = spawnSync(process.execPath, [
      '--import',
      loaderUrl,
      '--input-type=module',
      '-e',
      `
        const { applyProfileTransitionTransaction } =
          await import(${JSON.stringify(transactionUrl)});
        const { assertProfileTransitionPlanCurrent, rebuildProfileTransitionCandidate } =
          await import(${JSON.stringify(planUrl)});
        const { createProfileTransitionTransactionAuthorityStore } =
          await import(${JSON.stringify(authorityUrl)});
        const plan = ${JSON.stringify(preview.plan)};
        const storage = {
          homedir: ${JSON.stringify(project.home)},
          env: {},
          clock: () => new Date(${JSON.stringify(now.toISOString())})
        };
        const candidate = await rebuildProfileTransitionCandidate(plan);
        await applyProfileTransitionTransaction(
          plan.projectRoot,
          candidate.mutations,
          {
            planFingerprint: plan.fingerprint,
            authorityStore:
              createProfileTransitionTransactionAuthorityStore(plan.projectRoot, storage),
            preconditions: candidate.preconditions,
            expectedCandidateBinding: plan.execution.transactionCandidateBinding,
            validateCurrentInputs: async () =>
              assertProfileTransitionPlanCurrent(plan),
            onCheckpoint: async checkpoint => {
              if (checkpoint.phase === 'after-mutation' && checkpoint.index === 0) {
                process.exit(73);
              }
            }
          }
        );
        process.exitCode = 9;
      `
    ], {
      encoding: 'utf8',
      timeout: 20_000,
      cwd: process.cwd()
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(73);
    const lock = await projectMutationLockPath(project.root);
    expect(JSON.parse(await readFile(lock, 'utf8')).pid).toBe(child.pid);
    await rm(lock);

    expect(await recoverProfileTransitionPlan(
      project.root,
      preview.plan.fingerprint,
      { now, storage: project.options }
    )).toMatchObject({
      operation: 'recover',
      status: 'rolled-back',
      committed: false,
      rollbackFailures: [],
      cleanupFailures: [],
      readbackFailures: []
    });
    expect(await inventory(project.root)).toEqual(before);
    expect(await readProfileTransitionPlan(
      project.root,
      preview.plan.fingerprint,
      now,
      project.options
    )).toEqual(preview.plan);
  });
});
