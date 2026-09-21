import { createHash } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assessDeclaredSecretSource, parseDeclaredSecretSource, parseSecretBlobBatch, parseSecretDiffPaths, parseSecretTree
} from '../scripts/repository-security/gitleaks-source.ts';
import {
  declaredSourceMetadataTemplate, derivedMetadataTemplate, fetchPinnedDerivedProfileSource,
  parseDeclaredSourceOutput, type DerivedMetadataRegistry
} from '../scripts/repository-security/gitleaks-derived.ts';
import { createPrivateFixtureGit, createPrivateFixtureWorkspace, installPinnedFixtureGitleaks, parseGitObjectStoreMetadata, type PinnedFixtureTool } from '../scripts/repository-security/gitleaks.ts';

const commit = 'a'.repeat(40), other = 'b'.repeat(40);
const source = { sourceCommit: commit, refs: { 'refs/heads/develop': commit, 'refs/tags/v0.12.3': other } };
const registry: DerivedMetadataRegistry = {
  rules: [{ id: 'nonfunctional-fixture', kind: 'content' }],
  files: Array.from({ length: 24 }, (_, i) => ({ pathParts: [`file with spaces ${i}.txt`], aliases: [`file with spaces ${i}.txt`] })),
  commits: Array.from({ length: 8 }, (_, i) => String(i + 1).repeat(40))
};

describe('declared-source Gitleaks metadata boundary', () => {
  it('separates raw Git record framing from file names without trimming path bytes', () => {
    const header = `:100644 100644 ${commit} ${other} M`;
    expect(parseSecretDiffPaths(`\n${header}\0folder with spaces/file.txt\0`)).toEqual([
      ['folder with spaces', 'file.txt']
    ]);
    for (const value of [
      `${header}\0\nconcealed.txt\0`, `${header}\0../escape\0`, `${header}\0`,
      `${header.replace(' M', ' R100')}\0old\0new\0`, 'NONFUNCTIONAL_RAW_METADATA_SENTINEL'
    ]) expect(() => parseSecretDiffPaths(value)).toThrow();
  });

  it('classifies only exact successful Git garbage metadata without surfacing its path or accepting alternates', () => {
    const output = Buffer.from('count: 1\nsize: 1\nin-pack: 0\npacks: 0\nsize-pack: 0\nprune-packable: 0\ngarbage: 1\nsize-garbage: 0\n');
    const warning = Buffer.from('warning: garbage found: NONFUNCTIONAL_PRIVATE_PATH_SENTINEL\n');
    expect(parseGitObjectStoreMetadata(output, warning)).toEqual({
      garbageEntries: 1, garbageWarnings: 1, alternateObjectStores: false
    });
    expect(JSON.stringify(parseGitObjectStoreMetadata(output, warning))).not.toContain('NONFUNCTIONAL_PRIVATE_PATH_SENTINEL');
    for (const errors of [
      Buffer.from(''), Buffer.from('fatal: NONFUNCTIONAL_PRIVATE_PATH_SENTINEL'),
      Buffer.concat([warning, warning]), Buffer.from('warning: unknown: NONFUNCTIONAL_PRIVATE_PATH_SENTINEL')
    ]) expect(() => parseGitObjectStoreMetadata(output, errors)).toThrow('unsafe-stderr');
    expect(() => parseGitObjectStoreMetadata(Buffer.concat([output, Buffer.from('alternate: NONFUNCTIONAL_PRIVATE_PATH_SENTINEL\n')]), warning))
      .toThrow('unsafe-stderr');
  });

  it('keeps large inventories separate from the deliberately smaller fixture contract', () => {
    expect(() => derivedMetadataTemplate(registry)).toThrow('invalid-registry');
    const template = declaredSourceMetadataTemplate(registry, 'history');
    expect(template).toContain('{{$fileIndex := -1}}');
    expect(template).toContain('{{$fileIndex = 23}}');
    expect(template).toContain('{{$commitIndex = 7}}');
    expect(template).not.toContain('{{.File}}');
    expect(template).not.toContain('{{.Match}}');
    expect(template).not.toContain('{{.Secret}}');
    expect(template).not.toContain('{{.Author}}');
    const rows = Buffer.from('[[0,23,7,1,1,1,8,1]]');
    expect(parseDeclaredSourceOutput(rows, 42, registry)[0]).toMatchObject({ fileIndex: 23, commitIndex: 7 });
  });

  it('preserves the same logical finding with Windows and POSIX native path aliases', () => {
    const parts = ['folder with spaces', 'fixture.txt'];
    const output = Buffer.from('[[0,0,0,1,1,1,8,1]]');
    for (const alias of [
      path.win32.join('C:\\private scanner', ...parts), path.posix.join('/private scanner', ...parts)
    ]) {
      const local: DerivedMetadataRegistry = { ...registry, files: [{ pathParts: parts, aliases: [alias] }], commits: [commit] };
      expect(declaredSourceMetadataTemplate(local, 'current-tree')).toContain(JSON.stringify(alias));
      expect(parseDeclaredSourceOutput(output, 42, local)[0]).toMatchObject({ fileIndex: 0, commitIndex: 0 });
    }
  });

  it.each([
    'NONFUNCTIONAL_SOURCE_SCAN_SENTINEL',
    '{"Secret":"NONFUNCTIONAL_SOURCE_SCAN_SENTINEL"}',
    '[[0,23,7,1,1,1,8,"NONFUNCTIONAL_SOURCE_SCAN_SENTINEL"]]',
    '[[0,23,7,1,1,1,8,0]]',
    '[[0,24,7,1,1,1,8,1]]',
    '[[0,23,8,1,1,1,8,1]]'
  ])('rejects raw or unregistered scanner output without exposing it %#', value => {
    let failure: unknown;
    try { parseDeclaredSourceOutput(Buffer.from(value), 42, registry); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).not.toContain('NONFUNCTIONAL_SOURCE_SCAN_SENTINEL');
    expect(failure).not.toHaveProperty('cause');
  });

  it('binds exact refs and rejects candidate authority, invalid refs and missing selected commits', () => {
    expect(parseDeclaredSecretSource(source)).toEqual(source);
    for (const invalid of [
      { ...source, approved: true }, { ...source, refs: {} },
      { ...source, refs: { 'refs/heads/../main': commit } },
      { ...source, refs: { '--all': commit } },
      { ...source, refs: { 'refs/heads/main': other } }
    ]) expect(() => parseDeclaredSecretSource(invalid)).toThrow();
  });

  it('captures only portable regular tree entries and refuses suppression controls before invocation', () => {
    expect(parseSecretTree(`100644 blob ${commit}\tfolder with spaces/file.txt\0`)).toEqual([
      { pathParts: ['folder with spaces', 'file.txt'], object: commit, mode: '100644' }
    ]);
    for (const value of [
      '', `120000 blob ${commit}\tsymlink\0`, `160000 commit ${commit}\tsubmodule\0`,
      `100644 blob ${commit}\t../escape\0`, `100644 blob ${commit}\tC:\\escape\0`,
      `100644 blob ${commit}\t.gitleaksignore\0`, `100644 blob ${commit}\tnested/.GITLEAKSIGNORE\0`,
      `100644 blob ${commit}\tfile\0` + `100644 blob ${other}\tFILE\0`
    ]) expect(() => parseSecretTree(value)).toThrow();
    expect(parseSecretTree(`100644 blob ${commit}\t.gitleaks.toml\0`)[0]!.pathParts).toEqual(['.gitleaks.toml']);
  });

  it('uses exact Git blob framing and hashes without interpreting or logging binary content', () => {
    const bytes = Buffer.from([0, 255, 10, 65, 10]);
    const hash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    const batch = Buffer.concat([Buffer.from(`${hash} blob ${bytes.length}\n`), bytes, Buffer.from('\n')]);
    expect(Buffer.from(parseSecretBlobBatch(batch, [hash])[0]!)).toEqual(bytes);
    for (const invalid of [
      batch.subarray(0, -1), Buffer.concat([batch, Buffer.from('\n')]),
      Buffer.from(`${hash} blob 999999999\n`), Buffer.from(`${hash} missing\n`)
    ]) expect(() => parseSecretBlobBatch(invalid, [hash])).toThrow();
    expect(() => parseSecretBlobBatch(batch, [commit])).toThrow();
    const changed = Buffer.from(batch); changed[changed.length - 2] ^= 1;
    expect(() => parseSecretBlobBatch(changed, [hash])).toThrow('blob-identity-mismatch');
  });
});

it.runIf(process.env.LIFTOFF_REAL_GITLEAKS_SOURCE_FIXTURE === '1')(
  'qualifies selected-object export/current content and added-removed history with only nonfunctional fixtures',
  async () => {
    const parent = process.env.LIFTOFF_SECURITY_WORKSPACE_PARENT;
    if (!parent) throw new Error('Explicit registered external workspace parent required.');
    const owned = await createPrivateFixtureWorkspace(process.cwd(), 'gitleaks', parent);
    let tool: PinnedFixtureTool | undefined;
    try {
      tool = await installPinnedFixtureGitleaks(process.cwd(), parent);
      const git = await createPrivateFixtureGit(owned, '/usr/bin/git');
      for (let i = 0; i < 24; i++) {
        await writeFile(path.join(git.root, `fixture-${i}.txt`), 'Nonfunctional plain fixture data.\n', { flag: 'wx', mode: 0o600 });
      }
      await owned.register();
      await git.git(['add', '--all']);
      await git.git(['commit', '--quiet', '-m', 'Nonfunctional baseline']);
      const base = (await git.git(['rev-parse', 'HEAD'])).trim();
      const file = path.join(git.root, 'not a key container.p12');
      await writeFile(file, 'NONFUNCTIONAL_TEXT_NOT_A_PKCS12_CONTAINER\n', { flag: 'wx', mode: 0o600 });
      await owned.register();
      await git.git(['add', '--all']);
      await git.git(['commit', '--quiet', '-m', 'Nonfunctional path-only detector fixture']);
      const introduced = (await git.git(['rev-parse', 'HEAD'])).trim();
      const upstreamProfile = await fetchPinnedDerivedProfileSource();
      const detected = await assessDeclaredSecretSource({
        repository: git.root, workspaceParent: parent, tool, upstreamProfile,
        scope: { sourceCommit: introduced, refs: { 'refs/heads/fixture-only': introduced } }
      });
      expect(detected.scans.map(scan => scan.findingCount)).toEqual([1, 1]);
      await unlink(file);
      await owned.register();
      await git.git(['add', '--all']);
      await git.git(['commit', '--quiet', '-m', 'Remove nonfunctional detector fixture']);
      const head = (await git.git(['rev-parse', 'HEAD'])).trim();
      const result = await assessDeclaredSecretSource({
        repository: git.root, workspaceParent: parent, tool, upstreamProfile,
        scope: { sourceCommit: head, refs: { 'refs/heads/fixture-only': head } }, introducedBase: base
      });
      expect(result).toMatchObject({
        selectedCommits: 3, cleanup: 'completed', adoptedPolicyAuthority: false, publicationQualified: false
      });
      expect(result.scans.map(scan => [scan.kind, scan.findingCount])).toEqual([
        ['current-tree', 0], ['reachable-history', 1], ['introduced-history', 1]
      ]);
      expect(result.scans[2]).toMatchObject({ baseCommit: base, commits: 2, findingsPassed: false });
      expect(result.scans[1]!.findings[0]).toMatchObject({ rule: 'pkcs12-file', kind: 'path-only', line: null, blocking: true });
      expect(JSON.stringify(result)).not.toContain('NONFUNCTIONAL_TEXT_NOT_A_PKCS12_CONTAINER');
      expect(JSON.stringify(result)).not.toContain('not a key container.p12');
      const shallow = path.join(git.root, '.git', 'shallow');
      await writeFile(shallow, `${head}\n`, { flag: 'wx', mode: 0o600 });
      await owned.register();
      try {
        await expect(assessDeclaredSecretSource({
          repository: git.root, workspaceParent: parent, tool, upstreamProfile,
          scope: { sourceCommit: head, refs: { 'refs/heads/fixture-only': head } }
        })).rejects.toThrow('shallow-history');
      } finally { await unlink(shallow); await owned.register(); }
      await expect(assessDeclaredSecretSource({
        repository: git.root, workspaceParent: parent, tool, upstreamProfile,
        scope: { sourceCommit: head, refs: { 'refs/heads/fixture-only': head, 'refs/heads/missing': base } }
      })).rejects.toThrow('execution-failed');
      await writeFile(path.join(git.root, '.gitleaksignore'), 'NONFUNCTIONAL_SUPPRESSION_PROPOSAL\n', { flag: 'wx', mode: 0o600 });
      await owned.register();
      await git.git(['add', '--all']);
      await git.git(['commit', '--quiet', '-m', 'Nonfunctional suppression rejection fixture']);
      const suppressed = (await git.git(['rev-parse', 'HEAD'])).trim();
      await expect(assessDeclaredSecretSource({
        repository: git.root, workspaceParent: parent, tool, upstreamProfile,
        scope: { sourceCommit: suppressed, refs: { 'refs/heads/fixture-only': suppressed } }
      })).rejects.toThrow('candidate-suppression');
    } finally {
      try { await tool?.cleanup(); } finally {
        await owned.register();
        await owned.cleanup();
      }
    }
  }, 240_000
);
