import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectProjectInventory } from '../src/application/assessment/inventory.js';
import { projectInventoryBounds } from '../src/application/assessment/inventory-types.js';
import {
  ApplicationFiles, ApplicationInspectionError, ApplicationInventoryLimitError
} from '../src/application/repair/application-files.js';
import { applicationBounds } from '../src/application/repair/application-types.js';
import {
  projectDependencyDialect, projectInventoryExclusion, projectInventoryRoles
} from '../src/domain/assessment/inventory.js';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(files: Record<string, string | Buffer> = {}) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'liftoff-assessment-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, ...name.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

const pkg = JSON.stringify({ dependencies: { fastify: '^5.12.5', vue: '^3.5.0' }, scripts: { install: 'throw private-code' } });

describe('bounded whole-project inventory', () => {
  it('covers custom application paths, declarations, controls, infrastructure and documentation without reading their payloads', async () => {
    const files = {
      '.git/HEAD': 'not read',
      'services/custom api/package.json': pkg,
      'services/custom api/main.ts': 'throw new Error("must not execute");',
      'services/python/pyproject.toml': '[project]\ndependencies = ["fastapi>=0.1", "pydantic-ai"]\n',
      'services/go/go.mod': 'module example.test/service\nrequire github.com/danielgtaylor/huma/v2 v2.0.0\n',
      'services/custom api/package-lock.json': 'private-lock-content',
      '.github/workflows/check.yml': 'private-ci-content',
      '.github/skills/custom/SKILL.md': 'private-agent-content',
      '.claude/settings.json': '{"env":{"TOKEN":"private-agent-token"}}',
      'openspec/config.yaml': 'private-framework-content',
      '.specify/memory/constitution.md': 'private-framework-content',
      'infra/main.tf': 'private-infrastructure-content',
      'infra/.terraform.lock.hcl': 'private-provider-lock',
      'README.md': 'private-documentation-content',
      'docs/architecture.md': 'private-documentation-content',
      'liftoff.manifest.json': 'not interpreted by this inventory'
    };
    const root = await fixture(files);
    const read = vi.spyOn(ApplicationFiles.prototype, 'read');
    const report = await inspectProjectInventory(root);
    expect(report.complete).toBe(true);
    expect(report.readOnly).toBe(true);
    expect(report.rootMarkers).toEqual({ git: 'directory-marker', liftoff: 'file-marker' });
    expect(report.dependencies.map(item => [item.pathParts.join('/'), item.names])).toEqual([
      ['services/custom api/package.json', ['fastify', 'vue']],
      ['services/go/go.mod', ['github.com/danielgtaylor/huma/v2']],
      ['services/python/pyproject.toml', ['fastapi', 'pydantic-ai']]
    ]);
    expect(read.mock.calls.map(([parts]) => parts.join('/'))).toEqual(report.dependencies.map(item => item.pathParts.join('/')));
    for (const role of ['application', 'dependency', 'dependency-lock', 'workflow', 'agent', 'ci', 'infrastructure', 'documentation', 'project-metadata'] as const) {
      expect(report.entries.some(entry => entry.roles.includes(role)), role).toBe(true);
    }
    expect(JSON.stringify(report)).not.toMatch(/private-(?:code|lock|ci|agent|framework|infrastructure|provider|documentation)/);
    for (const [name, content] of Object.entries(files)) expect(await readFile(path.join(root, name), 'utf8')).toBe(content);
    const { inspectionDigest, ...body } = report;
    expect(inspectionDigest).toBe(canonicalSha256(body));
    expect(await inspectProjectInventory(root)).toEqual(report);
  });

  it('keeps worktree pointers and nested Git/Liftoff projects unobserved without resolving their contents', async () => {
    const root = await fixture({
      '.git': 'gitdir: /outside/private-worktree',
      'package.json': pkg,
      'nested-git/.git': 'gitdir: /outside/credentials',
      'nested-git/package.json': 'malformed',
      'nested-liftoff/liftoff.manifest.json': 'malformed',
      'nested-liftoff/package.json': 'malformed'
    });
    const read = vi.spyOn(ApplicationFiles.prototype, 'read');
    const report = await inspectProjectInventory(root);
    expect(report.rootMarkers).toEqual({ git: 'file-marker', liftoff: 'absent' });
    expect(report.exclusions.filter(item => item.reason === 'nested-project').map(item => item.pathParts)).toEqual([
      ['nested-git'], ['nested-liftoff']
    ]);
    expect(read.mock.calls.map(([parts]) => parts)).toEqual([['package.json']]);
    expect(report.entries.some(item => item.pathParts.length > 1)).toBe(false);
  });

  it('accepts an explicitly selected non-Git root and inventories independent monorepo packages without assigning active bindings', async () => {
    const root = await fixture({ 'apps/a/package.json': pkg, 'apps/b/package.json': pkg });
    const report = await inspectProjectInventory(root);
    expect(report.rootMarkers).toEqual({ git: 'absent', liftoff: 'absent' });
    expect(report.dependencies).toHaveLength(2);
    expect(report.coverage.applicationContents).toBe('not-observed');
    expect(report.coverage.references).toBe('not-observed');
    expect(report).not.toHaveProperty('activeLayout');
    expect(report).not.toHaveProperty('compliant');
  });

  it('never reads credentials/state/output payloads or executable/setup/control dependencies', async () => {
    const root = await fixture({
      '.env': 'SECRET', '.env.example': 'SECRET', 'backend/.npmrc': 'SECRET',
      'infra/terraform.tfstate': 'SECRET', 'infra/env.tfvars': 'SECRET', 'infra/plan.tfplan': 'SECRET',
      'backend/state/db.sqlite3': 'SECRET', 'credentials/package.json': 'SECRET',
      '.liftoff/telemetry.json': 'SECRET', 'node_modules/owned/package.json': 'SECRET',
      'dist/package.json': 'SECRET', '.azure/package.json': 'SECRET',
      '.claude/skills/package.json': 'SECRET', '.github/skills/test/package.json': 'SECRET',
      'openspec/package.json': 'SECRET', 'setup.py': 'raise Exception("SECRET")',
      'backend/package.json': pkg, 'backend/main.py': 'raise Exception("SECRET")'
    });
    const read = vi.spyOn(ApplicationFiles.prototype, 'read');
    const report = await inspectProjectInventory(root);
    expect(read.mock.calls.map(([parts]) => parts)).toEqual([['backend', 'package.json']]);
    expect(report.exclusions.map(item => item.reason)).toContain('state-or-credential');
    expect(JSON.stringify(report)).not.toContain('SECRET');
  });

  it('does not select an outer project when the explicit inner root is missing or invalid', async () => {
    const root = await fixture({ 'liftoff.manifest.json': '{}', 'package.json': pkg, 'plain-file': 'x' });
    await expect(inspectProjectInventory(path.join(root, 'missing'))).rejects.toBeInstanceOf(ApplicationInspectionError);
    await expect(inspectProjectInventory(path.join(root, 'plain-file'))).rejects.toBeInstanceOf(ApplicationInspectionError);
  });

  it.each(['.git', 'liftoff.manifest.json'])('rejects unsafe boundary %s rather than treating it as ordinary content', async name => {
    const root = await fixture();
    const outside = await fixture({ 'package.json': pkg });
    await symlink(outside, path.join(root, name), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(inspectProjectInventory(root)).rejects.toThrow('unsafe or aliased project boundary');
  });

  it('rejects linked roots, linked ancestors and nonexcluded directory links/junctions', async () => {
    const root = await fixture({ 'real/package.json': pkg });
    await symlink(path.join(root, 'real'), path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(inspectProjectInventory(path.join(root, 'alias'))).rejects.toBeInstanceOf(ApplicationInspectionError);
    await mkdir(path.join(root, 'real', 'inner'));
    await expect(inspectProjectInventory(path.join(root, 'alias', 'inner'))).rejects.toBeInstanceOf(ApplicationInspectionError);
    await expect(inspectProjectInventory(root)).rejects.toThrow('unsafe link, junction');
  });

  it('does not traverse excluded directory links/junctions', async () => {
    const root = await fixture({ 'package.json': pkg });
    const outside = await fixture({ 'package.json': 'private' });
    await symlink(outside, path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    expect((await inspectProjectInventory(root)).dependencies).toHaveLength(1);
  });

  it('rejects hard-linked dependency declarations without reading them', async () => {
    const root = await fixture({ 'package.json': pkg });
    await link(path.join(root, 'package.json'), path.join(root, 'copy.json'));
    await expect(inspectProjectInventory(root)).rejects.toThrow('singly linked regular files');
  });

  it('rejects a case-aliased project boundary on every filesystem', async () => {
    const root = await fixture({ 'Liftoff.manifest.json': '{}' });
    await expect(inspectProjectInventory(root)).rejects.toThrow('unsafe or aliased project boundary');
  });

  it.runIf(process.platform !== 'win32')('rejects special directory and declaration modes', async () => {
    const root = await fixture({ 'package.json': pkg });
    await chmod(root, 0o1700);
    await expect(inspectProjectInventory(root)).rejects.toThrow('special directory modes');
    await chmod(root, 0o700);
    await chmod(path.join(root, 'package.json'), 0o1600);
    await expect(inspectProjectInventory(root)).rejects.toThrow('special file modes');
  });

  it('rejects observed membership changes instead of returning success-shaped evidence', async () => {
    const root = await fixture({ 'package.json': pkg });
    const original = ApplicationFiles.prototype.read;
    vi.spyOn(ApplicationFiles.prototype, 'read').mockImplementationOnce(async function (this: ApplicationFiles, parts, limit) {
      const snapshot = await original.call(this, parts, limit);
      await writeFile(path.join(root, 'late.ts'), 'late');
      return snapshot;
    });
    await expect(inspectProjectInventory(root)).rejects.toThrow('scope changed');
  });

  it('rejects a declaration that disappears after directory observation', async () => {
    const root = await fixture({ 'package.json': pkg });
    const original = ApplicationFiles.prototype.read;
    vi.spyOn(ApplicationFiles.prototype, 'read').mockImplementationOnce(async function (this: ApplicationFiles, parts, limit) {
      await rm(path.join(root, 'package.json'));
      return original.call(this, parts, limit);
    });
    await expect(inspectProjectInventory(root)).rejects.toThrow('declaration disappeared');
  });

  it.each([
    ['package.json', 'not json'],
    ['package.json', '[]'],
    ['package.json', '{"dependencies":{"fastify":true}}'],
    ['package.json', '{"dependencies":{"https://user:SECRET@host/": "1"}}'],
    ['pyproject.toml', '[project'],
    ['go.mod', 'binary\0SECRET']
  ])('reports uninterpretable %s without exposing private content', async (name, contents) => {
    const root = await fixture({ [name]: contents });
    const report = await inspectProjectInventory(root);
    expect(report.complete).toBe(false);
    expect(report.dependencies[0]?.availability).toBe('uninterpretable');
    expect(report.dependencies[0]?.names).toEqual([]);
    expect(JSON.stringify(report)).not.toContain('SECRET');
  });

  it('reports invalid UTF-8 instead of lossy dependency names', async () => {
    const root = await fixture({ 'package.json': Buffer.from([0xff]) });
    expect((await inspectProjectInventory(root)).dependencies[0]?.availability).toBe('uninterpretable');
  });

  it('reads portable case variants exactly and extracts only static Python declarations', async () => {
    const root = await fixture({
      'a/Package.json': pkg,
      'b/requirements.txt': 'fastapi==0.1\n# ignored\n',
      'c/setup.cfg': '[options]\ninstall_requires =\n fastapi\n pydantic-ai\n'
    });
    const report = await inspectProjectInventory(root);
    expect(report.dependencies.map(item => item.names)).toEqual([
      ['fastify', 'vue'], ['fastapi'], ['fastapi', 'pydantic-ai']
    ]);
  });

  it.each(['-r SECRET-file', '--index-url https://user:SECRET@host/', 'fastapi==1 \\\n --hash=SECRET'])(
    'does not follow or silently ignore indirect/installer requirement scope', async directive => {
      const root = await fixture({ 'requirements.txt': `fastapi==1\n${directive}\n` });
      const read = vi.spyOn(ApplicationFiles.prototype, 'read');
      const report = await inspectProjectInventory(root);
      expect(report.complete).toBe(false);
      expect(report.dependencies[0]?.availability).toBe('uninterpretable');
      expect(report.dependencies[0]?.names).toEqual([]);
      expect(read.mock.calls.map(([parts]) => parts)).toEqual([['requirements.txt']]);
      expect(JSON.stringify(report)).not.toContain('SECRET');
    }
  );

  it('retains an explicit bounded gap at the actual per-directory entry threshold', async () => {
    const root = await fixture();
    for (let i = 0; i <= projectInventoryBounds.directoryEntries; i++) {
      await writeFile(path.join(root, `f${i}.ts`), '');
    }
    const report = await inspectProjectInventory(root);
    expect(report.complete).toBe(false);
    expect(report.entries).toEqual([]);
    expect(report.directories).toEqual([]);
    expect(report.rootMarkers).toEqual({ git: 'not-observed', liftoff: 'not-observed' });
    expect(report.coverage.limits).toEqual([{ pathParts: [], bound: 'directoryEntries' }]);
  });

  it('limits the actual file count deterministically', async () => {
    const root = await fixture();
    for (let i = 0; i <= projectInventoryBounds.files; i++) {
      const folder = path.join(root, `d${Math.floor(i / 200)}`);
      await mkdir(folder, { recursive: true });
      await writeFile(path.join(folder, `f${String(i).padStart(4, '0')}.ts`), '');
    }
    const report = await inspectProjectInventory(root);
    expect(report.entries.filter(item => item.kind === 'file')).toHaveLength(projectInventoryBounds.files);
    expect(report.coverage.limits).toEqual([{ pathParts: ['d2', 'f0512.ts'], bound: 'files' }]);
    expect(await inspectProjectInventory(root)).toEqual(report);
  });

  it('limits actual directory counts and does not expose partially enumerated directories', async () => {
    const root = await fixture();
    for (let i = 0; i < 270; i++) {
      await mkdir(path.join(root, `d${String(Math.floor(i / 30)).padStart(2, '0')}`, `n${String(i % 30).padStart(2, '0')}`), { recursive: true });
    }
    const report = await inspectProjectInventory(root);
    expect(report.directories).toHaveLength(projectInventoryBounds.directories);
    expect(report.coverage.limits[0]?.bound).toBe('directories');
  });

  it('limits path depth rather than traversing unbounded trees', async () => {
    const root = await fixture();
    await mkdir(path.join(root, ...Array.from({ length: 13 }, () => 'nested')), { recursive: true });
    const report = await inspectProjectInventory(root);
    expect(report.complete).toBe(false);
    expect(report.coverage.limits[0]?.bound).toBe('depth');
    expect(report.coverage.limits[0]?.pathParts).toHaveLength(13);
  });

  it('limits path bytes independently of depth', async () => {
    const root = await fixture();
    // macOS's absolute-path limit is smaller than this portable relative-path bound.
    vi.spyOn(ApplicationFiles.prototype, 'inventory').mockImplementation(async parts => ({
      pathParts: [...parts], exists: true, mode: 0o700,
      entries: [{ name: 'a'.repeat(210), kind: 'directory' as const }]
    }));
    expect((await inspectProjectInventory(root)).coverage.limits[0]?.bound).toBe('pathBytes');
  });

  it('limits metadata entry counts including excluded entries without payload reads', async () => {
    const root = await fixture();
    const inventory = vi.spyOn(ApplicationFiles.prototype, 'inventory').mockImplementation(async (parts, maximumEntries = 256) => {
      const entries = parts.length ? Array.from({ length: 256 }, (_, index) => ({ name: `.env.${index}`, kind: 'file' as const })) :
        Array.from({ length: 17 }, (_, index) => ({ name: `d${index}`, kind: 'directory' as const }));
      if (entries.length > maximumEntries) throw new ApplicationInventoryLimitError('entries', 'test remaining metadata entry bound');
      return { pathParts: [...parts], exists: true, mode: 0o700, entries };
    });
    const read = vi.spyOn(ApplicationFiles.prototype, 'read');
    const report = await inspectProjectInventory(root);
    expect(report.complete).toBe(false);
    expect(report.coverage.limits[0]?.bound).toBe('entries');
    expect(read).not.toHaveBeenCalled();
    expect(inventory.mock.calls.at(-1)?.[1]).toBe(239);
    expect(report.exclusions.length + report.entries.length).toBeLessThanOrEqual(projectInventoryBounds.entries);
  });

  it('charges nested boundary enumeration to the same overall metadata budget', async () => {
    const root = await fixture();
    const inventory = vi.spyOn(ApplicationFiles.prototype, 'inventory').mockImplementation(async (parts, maximumEntries = 256) => {
      const entries = parts.length ?
        [{ name: '.git', kind: 'directory' as const }, ...Array.from({ length: 255 }, (_, index) => ({ name: `f${index}`, kind: 'file' as const }))] :
        Array.from({ length: 17 }, (_, index) => ({ name: `nested${index}`, kind: 'directory' as const }));
      if (entries.length > maximumEntries) throw new ApplicationInventoryLimitError('entries', 'test remaining metadata entry bound');
      return { pathParts: [...parts], exists: true, mode: 0o700, entries };
    });
    const report = await inspectProjectInventory(root);
    expect(report.complete).toBe(false);
    expect(report.exclusions.filter(item => item.reason === 'nested-project')).toHaveLength(15);
    expect(inventory.mock.calls.at(-1)?.[1]).toBe(239);
    expect(report.coverage.limits[0]?.bound).toBe('entries');
  });

  it('limits dependency bytes without mistaking a rejected read for an absent destination', async () => {
    const root = await fixture({ 'package.json': Buffer.alloc(projectInventoryBounds.fileBytes + 1, 0x20) });
    const report = await inspectProjectInventory(root);
    expect(report.coverage.limits).toEqual([{ pathParts: ['package.json'], bound: 'fileBytes' }]);
    expect(report.dependencies[0]?.availability).toBe('not-observed');
    expect(report.dependencies[0]?.digest).toBe(null);
  });

  it('limits the actual combined read budget independently of per-file bounds', async () => {
    const root = await fixture();
    const prefix = '{"description":"', suffix = '"}';
    const contents = prefix + 'x'.repeat(projectInventoryBounds.fileBytes - prefix.length - suffix.length) + suffix;
    for (let i = 0; i < 9; i++) {
      await mkdir(path.join(root, `d${i}`));
      await writeFile(path.join(root, `d${i}`, 'package.json'), contents);
    }
    const report = await inspectProjectInventory(root);
    expect(report.dependencies.filter(item => item.availability === 'observed')).toHaveLength(8);
    expect(report.coverage.limits).toEqual([{ pathParts: ['d8', 'package.json'], bound: 'totalBytes' }]);
  });

  it('limits extracted dependency names rather than truncating them into conformance', async () => {
    const root = await fixture({ 'package.json': JSON.stringify({
      dependencies: Object.fromEntries(Array.from({ length: projectInventoryBounds.dependencyNames + 1 }, (_, i) => [`p${i}`, '1']))
    }) });
    const report = await inspectProjectInventory(root);
    expect(report.complete).toBe(false);
    expect(report.dependencies[0]?.availability).toBe('not-observed');
    expect(report.dependencies[0]?.names).toEqual([]);
    expect(report.coverage.limits[0]?.bound).toBe('dependencyNames');
  });
});

describe('static inventory policy and compatibility', () => {
  it('keeps reused primitive budgets exact', () => {
    for (const key of ['files', 'directories', 'directoryEntries', 'depth', 'pathBytes', 'fileBytes', 'totalBytes'] as const) {
      expect(projectInventoryBounds[key]).toBe(applicationBounds[key]);
    }
    const error = new ApplicationInventoryLimitError('files', 'exact old repair message');
    expect(error).toBeInstanceOf(ApplicationInspectionError);
    expect(error.message).toBe('exact old repair message');
    expect(error.limit).toBe('files');
  });

  it.each([-1, 257, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects an invalid or expanded primitive budget %s', async maximum => {
    const root = await fixture();
    await expect(new ApplicationFiles(root).inventory([], maximum)).rejects.toThrow('entry limit must remain within');
  });

  it('enforces a reduced real enumeration budget before collecting excess metadata', async () => {
    const root = await fixture({ 'a.ts': '', 'b.ts': '' });
    const reader = new ApplicationFiles(root);
    await expect(reader.inventory([], 1)).rejects.toMatchObject({ limit: 'entries' });
    expect(reader.directoryInventory[0]?.entries).toHaveLength(1);
  });

  it.each([
    ['.git', 'version-control'], ['.hg', 'version-control'], ['.svn', 'version-control'],
    ['SECRETS', 'state-or-credential'], ['.ENV.local', 'state-or-credential'],
    ['settings.env', 'state-or-credential'], ['key.pem', 'state-or-credential'],
    ['tokens.private', 'state-or-credential'], ['build', 'dependency-or-output'], ['.venv', 'dependency-or-output']
  ])('excludes %s before reading any payload', (name, reason) => {
    expect(projectInventoryExclusion(['app', name])).toBe(reason);
  });

  it.each([
    ['infra/main.tf', 'infrastructure'], ['custom/azure.bicep', 'infrastructure'],
    ['.terraform.lock.hcl', 'infrastructure'], ['README.md', 'documentation'],
    ['.github/workflows/test.yaml', 'ci'], ['azure-pipelines.yml', 'ci'], ['.gitlab-ci.yml', 'ci'],
    ['CLAUDE.md', 'agent'], ['AGENTS.md', 'agent'], ['.agents/skills/custom/SKILL.md', 'agent'],
    ['Dockerfile', 'build-configuration'], ['compose.yaml', 'build-configuration'],
    ['tsconfig.custom.json', 'build-configuration'], ['vitest.config.ts', 'build-configuration'],
    ['backend/server.ts', 'application'], ['backend/main.go', 'application'],
    ['frontend/App.vue', 'application'], ['uv.lock', 'dependency-lock'], ['unknown', 'other']
  ])('observes %s as %s without claiming compliance', (filename, role) => {
    expect(projectInventoryRoles(filename.split('/'), false)).toContain(role);
  });

  it('does not interpret executable setup or control-tree package metadata', () => {
    expect(projectDependencyDialect(['setup.py'])).toBe(null);
    expect(projectDependencyDialect(['.claude', 'package.json'])).toBe(null);
    expect(projectDependencyDialect(['some-source.ts'])).toBe(null);
    expect(projectInventoryRoles(['backend'], true)).toEqual(['other']);
  });
});
