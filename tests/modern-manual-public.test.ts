import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import { createCommandOutcome } from '../src/application/command-outcome.js';
import { localExecutionStore } from '../src/application/governance/modern-local-approval.js';
import { CaptureStream, ReadyInitRunner } from './helpers.js';
import { generatedManualFixture, manualScopes, recordManualCommands } from './fixtures/modern-manual-project.js';

const lane = process.env.LIFTOFF_MANUAL_ENGINE_TEST_LANE ?? 'off';
if (!['off', 'native'].includes(lane) || lane === 'native' && (process.env.LIFTOFF_HCL_TEST_LANE === 'portable' ||
    process.platform !== 'darwin' || process.arch !== 'arm64' || process.versions.node !== '24.21.0')) {
  throw new Error('Public Manual qualification requires explicit native network consent and the qualified host.');
}
const nativeIt = it.skipIf(lane !== 'native');

async function invoke(root: string, args: string[], expectedCode = 0) {
  const stdout = new CaptureStream(), stderr = new CaptureStream(), runner = new ReadyInitRunner();
  const outcome = createCommandOutcome();
  const code = await runCommand(parseArgs([...args, '--json']), { cwd: root, stdout, stderr, runner, outcome });
  expect(runner.calls).toEqual([]);
  expect(code, stdout.text() + stderr.text()).toBe(expectedCode);
  expect(outcome.finish(code)).toBe(code ? 'failure' : args.includes('apply-next') && !args.includes('--execute')
    ? 'attention-required' : 'success');
  if (!stdout.text()) throw new Error('Public Manual operation returned no JSON report.');
  return JSON.parse(stdout.text());
}
async function request(directory: string, name: string, value: object) {
  const file = path.join(directory, `${name}.json`);
  await writeFile(file, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  return file;
}

describe('actual generated Manual public CLI completion, separately approved effects', () => {
  nativeIt.each(['none', 'single-maintainer-gitflow'] as const)(
    'completes %s through public commands without an external framework or remote credentials', async profile => {
      const agents = profile === 'none' ? [] : ['github-copilot', 'claude', 'codex'] as const;
      const fixture = await generatedManualFixture({ profile, agents, frontend: true, environments: ['dev', 'staging', 'prod'] });
      const commands = recordManualCommands(), reports: object[] = [];
      try {
        const capabilities = await invoke(fixture.project, ['capabilities']);
        expect(capabilities.schemas.modernLocalVerification.requests).toContain('verify-manual-native');
        expect(commands).toEqual([]);
        const local = async (operation: 'verify' | 'finalize' | 'publish', args: string[], expectedCode = 0) => {
          const report = await invoke(fixture.project, ['governance', ...args, '--scope', 'local', '--local-operation', operation], expectedCode);
          reports.push(report);
          expect(report).toMatchObject({ scope: 'local', activationComplete: false, lifecycleComplete: false, providerOperationsAuthorized: false });
          return report;
        };
        const verificationRequest = await request(fixture.directory, 'verification', {
          kind: 'verify-manual-native', preparation: fixture.preparation
        });
        const plan = await local('verify', ['plan', '--inputs', verificationRequest]);
        expect(plan).toMatchObject({ schemaVersion: 7, status: 'planned', executionRequested: false, localComplete: false,
          preview: { schemaVersion: 6 } });
        expect(plan.preview.tools.some((tool: { id: string }) => ['openspec', 'spec-kit', 'copilot', 'claude', 'codex'].includes(tool.id))).toBe(false);
        const store = localExecutionStore(fixture.project);
        const declined = await request(fixture.directory, 'declined-infrastructure', {
          kind: 'approve-manual-native', scopes: { ...manualScopes, infrastructureNetwork: false }
        });
        expect(await local('verify', ['approve', '--plan', plan.fingerprint, '--inputs', declined], 1))
          .toMatchObject({ status: 'failed', externalMetadataWriteRequested: false });
        expect(await store.read('consent', plan.fingerprint)).toBeNull();
        expect(await store.readState(plan.fingerprint)).toBeNull();
        const consent = await request(fixture.directory, 'verification-consent', { kind: 'approve-manual-native', scopes: manualScopes });
        expect(await local('verify', ['approve', '--plan', plan.fingerprint, '--inputs', consent]))
          .toMatchObject({ status: 'approved', consent: { schemaVersion: 5 }, executionRequested: false, localComplete: false });
        expect(await local('verify', ['apply-next', '--plan', plan.fingerprint]))
          .toMatchObject({ status: 'not-executed', verificationComplete: false });
        expect(await store.readState(plan.fingerprint)).toBeNull();
        const verified = await local('verify', ['apply-next', '--plan', plan.fingerprint, '--execute']);
        expect(verified).toMatchObject({ status: 'checks-verified', verificationComplete: true, localComplete: false,
          verificationScope: 'manual-locked-local-baseline', result: { schemaVersion: 5, complete: true,
            inputsUnchanged: true, cleanupComplete: true, retainedWorkspace: null } });
        expect(verified.result.infrastructure.outputs).toHaveLength(3);
        for (const artifact of fixture.artifacts) {
          expect(await readFile(path.join(fixture.project, ...artifact.pathParts), 'utf8')).toBe(artifact.content);
        }
        const finalizationRequest = await request(fixture.directory, 'finalization', {
          kind: 'finalize-local', executionFingerprint: plan.fingerprint
        });
        const finalization = await local('finalize', ['plan', '--inputs', finalizationRequest]);
        expect(await local('finalize', ['apply-next', '--plan', finalization.fingerprint, '--execute'], 1))
          .toMatchObject({ localComplete: false, projectFileEffectsRequested: false });
        const finalizationConsent = await request(fixture.directory, 'finalization-consent', {
          kind: 'approve-manual-finalization', scopes: {
            finalizeLocal: true, workflowWrites: false, projectCode: false, dependencyPreparation: false,
            dependencyNetwork: false, publishLocalRecords: false
          }
        });
        await local('finalize', ['approve', '--plan', finalization.fingerprint, '--inputs', finalizationConsent]);
        const finalized = await local('finalize', ['apply-next', '--plan', finalization.fingerprint, '--execute']);
        expect(finalized).toMatchObject({ status: 'finalized', localComplete: false, projectFileEffectsRequested: false });
        const publicationKey = finalized.result.publicationFingerprint;
        const reviewRequest = await request(fixture.directory, 'publication-review', {
          kind: 'review-local-publication', publicationFingerprint: publicationKey
        });
        const review = await local('publish', ['plan', '--inputs', reviewRequest]);
        expect(review).toMatchObject({ localComplete: false, projectFileEffectsRequested: false });
        expect(await local('publish', ['apply-next', '--plan', publicationKey, '--execute'], 1))
          .toMatchObject({ localComplete: false, publicationCommitted: null, projectFileEffectsUncertain: true });
        for (const artifact of fixture.artifacts) {
          expect(await readFile(path.join(fixture.project, ...artifact.pathParts), 'utf8')).toBe(artifact.content);
        }
        const publicationConsent = await request(fixture.directory, 'publication-consent', {
          kind: 'approve-local-publication', publishExactLocalBytes: true, finalizationFingerprint: finalization.fingerprint,
          candidateBinding: finalized.result.candidateBinding, targetSetDigest: finalized.result.targetSetDigest
        });
        await local('publish', ['approve', '--plan', publicationKey, '--inputs', publicationConsent]);
        const published = await local('publish', ['apply-next', '--plan', publicationKey, '--execute']);
        expect(published).toMatchObject({ status: 'local-complete-current', localComplete: true,
          publicationCommitted: true, projectFileEffectsUncertain: false });
        const inspected = await invoke(fixture.project, ['governance', 'verify', '--scope', 'local']);
        reports.push(inspected);
        expect(inspected).toMatchObject({ complete: true, scope: 'local' });
        for (const artifact of fixture.artifacts) {
          if (finalized.result.targets.some((target: { pathParts: string[] }) => target.pathParts.join('/') === artifact.pathParts.join('/'))) continue;
          expect(await readFile(path.join(fixture.project, ...artifact.pathParts), 'utf8')).toBe(artifact.content);
        }
        fixture.retained.complete = true;
      } finally {
        console.info('MANUAL_NATIVE_PUBLIC ' + JSON.stringify({ profile, agents, reports, commands }));
      }
    }, 700_000
  );
});
