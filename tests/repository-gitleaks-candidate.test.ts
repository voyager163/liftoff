import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { assessCandidateSecrets } from '../scripts/repository-security/gitleaks-candidate.ts';
import { fetchPinnedDerivedProfileSource } from '../scripts/repository-security/gitleaks-derived.ts';
import { installPinnedFixtureGitleaks, type PinnedFixtureTool } from '../scripts/repository-security/gitleaks.ts';
import { createAdmissionGitFixture } from './fixtures/security-git.js';

it.runIf(process.env.LIFTOFF_REAL_GITLEAKS_CANDIDATE === '1')(
  'assesses uncommitted bytes with stable identity without granting authority to candidate ignore rules',
  async () => {
    const parent = process.env.LIFTOFF_SECURITY_WORKSPACE_PARENT;
    if (!parent) throw new Error('Registered external parent required.');
    const fixture = await createAdmissionGitFixture();
    let tool: PinnedFixtureTool | undefined;
    try {
      const files = { '.gitignore': 'ignored/\nnode_modules/\n', 'source.txt': 'Plain nonfunctional baseline.\n' };
      const head = await fixture.commit(files);
      tool = await installPinnedFixtureGitleaks(process.cwd(), parent);
      const upstreamProfile = await fetchPinnedDerivedProfileSource();
      const options = {
        repository: fixture.root, expectedHead: head, workspaceParent: parent, tool, upstreamProfile
      };
      const baseline = await assessCandidateSecrets(options);
      expect(baseline).toMatchObject({ inputFiles: 2, findingsPassed: true, historyAssessed: false });
      await writeFile(path.join(fixture.root, 'uncommitted fixture.p12'), 'NONFUNCTIONAL_NOT_A_KEY_CONTAINER\n');
      await mkdir(path.join(fixture.root, 'ignored'));
      await writeFile(path.join(fixture.root, 'ignored', 'outside-declared-scope.p12'), 'NONFUNCTIONAL_NOT_A_KEY_CONTAINER\n');
      const detected = await assessCandidateSecrets(options), repeated = await assessCandidateSecrets(options);
      expect(detected).toMatchObject({
        identityKind: 'stable-content-snapshot-not-git-commit', headAnchor: head,
        inputFiles: 3, assessmentComplete: true, findingsPassed: false, historyAssessed: false,
        dispositionAuthority: false, hostedQualification: false, cleanup: 'completed'
      });
      expect(detected.findings).toHaveLength(1);
      expect(detected.findings[0]).toMatchObject({ rule: 'pkcs12-file', kind: 'path-only', state: 'unresolved', blocking: true });
      expect(detected.findings[0]).not.toHaveProperty('commit');
      expect(detected.snapshotDigest).not.toBe(baseline.snapshotDigest);
      expect(repeated.snapshotDigest).toBe(detected.snapshotDigest);
      expect(repeated.findings).toEqual(detected.findings);
      expect(JSON.stringify(detected)).not.toContain('NONFUNCTIONAL_NOT_A_KEY_CONTAINER');
      expect(JSON.stringify(detected)).not.toContain('uncommitted fixture.p12');
      await writeFile(path.join(fixture.root, '.gitignore'), `${files['.gitignore']}*.p12\n`);
      await expect(assessCandidateSecrets(options)).rejects.toThrow('candidate-ignore-policy-change');
      await writeFile(path.join(fixture.root, '.gitignore'), files['.gitignore']);
      await writeFile(path.join(fixture.root, '.gitleaksignore'), 'NONFUNCTIONAL_SUPPRESSION\n');
      await expect(assessCandidateSecrets(options)).rejects.toThrow('candidate-suppression');
      await unlink(path.join(fixture.root, '.gitleaksignore'));
      await unlink(path.join(fixture.root, 'source.txt'));
      expect(await assessCandidateSecrets(options)).toMatchObject({ inputFiles: 2, deletedTrackedFiles: 1, findingsPassed: false });
    } finally { try { await tool?.cleanup(); } finally { await fixture.cleanup(); } }
  }, 240_000
);
