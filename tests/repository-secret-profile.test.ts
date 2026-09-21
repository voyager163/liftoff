import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { prepareAdoptedSecretProfile, prepareSecretProfile, validateSecretDetectorRegistration } from '../scripts/repository-security/secret-profile.ts';
import { loadAdoptedBase } from '../scripts/repository-security/admission.ts';
import { createAdmissionGitFixture } from './fixtures/security-git.js';

const fixture = `
title = "Synthetic source profile"
[allowlist]
paths = ["package-lock.json", "go.sum", "docs/image.svg"]
regexes = ["false"]
[[rules]]
id = "synthetic-rule"
regex = "NONFUNCTIONAL_[A-Z]+"
[[rules.allowlists]]
paths = ["tests/"]
[[rules.allowlists]]
regexes = ["IGNORE_SENTINEL"]
`;
const identity = {
  commit: 'a'.repeat(40), sha256: createHash('sha256').update(fixture).digest('hex'), ruleCount: 1
};

describe('explicit pinned source/history secret detector profile', () => {
  it('removes inherited path and value suppression without replacing detector rules', () => {
    const result = prepareSecretProfile(fixture, identity);
    const parsed = parse(result.config);
    expect(result.rules).toEqual(['synthetic-rule']);
    expect(result.removedAllowlistGroups).toBe(3);
    expect(result.kind).toBe('derived-configuration');
    expect(result.behaviorChanged).toBe(true);
    expect(parsed.allowlist).toBeUndefined();
    expect(result.config).not.toContain('allowlist');
    expect(result.config).toContain('NONFUNCTIONAL_[A-Z]+');
    expect(result.qualified).toBe(false);
    expect(prepareSecretProfile(fixture, identity).configDigest).toBe(result.configDigest);
  });

  it('blocks source drift, dropped/duplicate rules and extended configuration', () => {
    expect(() => prepareSecretProfile(`${fixture}\n`, identity)).toThrow('secret-rule-source-drift');
    expect(() => prepareSecretProfile(fixture, { ...identity, ruleCount: 2 })).toThrow('incomplete-secret-rule-inventory');
    for (const source of [
      `${fixture}\n[[rules]]\nid="synthetic-rule"\nregex="DUPLICATE"\n`,
      `[extend]\nuseDefault=true\n${fixture}`
    ]) {
      expect(() => prepareSecretProfile(source, {
        ...identity, sha256: createHash('sha256').update(source).digest('hex'),
        ruleCount: source.includes('DUPLICATE') ? 2 : 1
      })).toThrow('Security evidence rejected');
    }
  });

  it('retains supported path-only credential-file rules instead of silently dropping a detector', () => {
    const source = `${fixture}\n[[rules]]\nid="pkcs12-file"\npath="fixture[.]p12$"\n`;
    const result = prepareSecretProfile(source, {
      ...identity, sha256: createHash('sha256').update(source).digest('hex'), ruleCount: 2
    });
    expect(result.rules).toEqual(['synthetic-rule', 'pkcs12-file']);
    expect(result.config).toContain('fixture[.]p12$');
  });

  it('records configuration as unqualified and disallows candidate bypass mechanisms', async () => {
    const registration = JSON.parse(await readFile(path.join(process.cwd(), 'security', 'secret-detector.json'), 'utf8'));
    expect(validateSecretDetectorRegistration(registration)).toMatchObject({
      commit: '83d9cd684c87d95d656c1458ef04895a7f1cbd8e', ruleCount: 222
    });
    expect(() => validateSecretDetectorRegistration({ ...registration, candidateInlineAllowComments: true }))
      .toThrow('unapproved-secret-detector-policy');
    expect(() => validateSecretDetectorRegistration({ ...registration, status: 'enforced' }))
      .toThrow('unapproved-secret-detector-policy');
  });

  it('loads detector configuration from independently adopted base bytes, not a candidate override', async () => {
    const repository = await createAdmissionGitFixture();
    try {
      const registration = JSON.parse(await readFile(path.join(process.cwd(), 'security', 'secret-detector.json'), 'utf8'));
      registration.defaultConfig = {
        repository: 'gitleaks/gitleaks', commit: identity.commit, pathParts: ['config', 'gitleaks.toml'],
        gitBlob: 'b'.repeat(40), sha256: identity.sha256, ruleCount: 1
      };
      registration.preparedConfigSha256 = prepareSecretProfile(fixture, identity).configDigest.slice('sha256:'.length);
      const control = {
        schemaVersion: 1, repository: 'voyager163/liftoff',
        policyData: [{ id: 'secrets', adapter: 'secrets', pathParts: ['security', 'data.json'] }],
        controlInputs: [['validator.txt'], ['security', 'secret-detector.json']],
        validatorInputs: [['validator.txt']]
      };
      const files = {
        'validator.txt': 'Controlled fixture validator identity.',
        'security/control-plane.json': JSON.stringify(control),
        'security/data.json': '{"schemaVersion":1,"dispositions":[]}',
        'security/secret-detector.json': JSON.stringify(registration)
      };
      const baseCommit = await repository.commit(files);
      const headCommit = await repository.commit({
        ...files, 'security/secret-detector.json': JSON.stringify({ ...registration, candidateIgnoreFiles: true })
      });
      const base = await loadAdoptedBase(repository.root, {
        repository: 'voyager163/liftoff', baseRef: 'develop', baseCommit, headCommit,
        now: new Date('2026-09-20T12:00:00.000Z')
      });
      const result = await prepareAdoptedSecretProfile(base, fixture);
      expect(result.authority.baseCommit).toBe(baseCommit);
      expect(result.sourceDigest).toBe(`sha256:${identity.sha256}`);
      expect(result.kind).toBe('derived-configuration');
      expect(result.qualified).toBe(false);
    } finally {
      await repository.cleanup();
    }
  });
});
