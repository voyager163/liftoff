import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { createFixtureProject, runCommand } from '../src/commands.js';
import { CaptureStream } from './helpers.js';

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await rm(cleanups.pop()!, { recursive: true, force: true });
  }
});

async function fixtureProject(): Promise<string> {
  const projectRoot = await createFixtureProject({
    projectName: 'Seed App',
    pattern: 'prompt',
    cloud: 'azure',
    region: 'eastus',
    environments: ['dev'],
    specWorkflow: 'openspec',
    includeFrontend: false
  });
  cleanups.push(path.dirname(projectRoot));
  return projectRoot;
}

async function run(args: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const code = await runCommand(parseArgs(args), { cwd, stdout, stderr });
  return { code, out: stdout.text(), err: stderr.text() };
}

const SEED_DIR = ['openspec', 'changes', 'bootstrap-seed-app'];

async function archiveSeedChange(root: string): Promise<void> {
  await mkdir(path.join(root, 'openspec', 'changes', 'archive'), { recursive: true });
  await rename(path.join(root, ...SEED_DIR), path.join(root, 'openspec', 'changes', 'archive', 'done-bootstrap-seed-app'));
}

describe('seed artifact lifecycle', () => {
  it('writes seed files at create but records none of them in the manifest', async () => {
    const root = await fixtureProject();

    await access(path.join(root, ...SEED_DIR, 'proposal.md'));
    await access(path.join(root, ...SEED_DIR, 'tasks.md'));

    const manifest = JSON.parse(await readFile(path.join(root, 'liftoff.manifest.json'), 'utf8'));
    const seedEntries = manifest.artifacts.filter(
      (artifact: { logicalName: string; pathParts: string[] }) =>
        artifact.logicalName.startsWith('openspec-seed') || artifact.pathParts.includes('bootstrap-seed-app')
    );
    expect(seedEntries).toEqual([]);
  });

  it('treats archiving the seeded change as a non-event for update and validate', async () => {
    const root = await fixtureProject();
    await archiveSeedChange(root);

    const check = await run(['update'], root);
    expect(check.code).toBe(0);
    expect(check.out).toContain('No drift');

    const apply = await run(['update', '--apply'], root);
    expect(apply.code).toBe(0);
    await expect(access(path.join(root, ...SEED_DIR))).rejects.toThrow();

    const validate = await run(['validate'], root);
    expect(validate.code).toBe(0);
  });

  it('heals legacy manifests that recorded seed entries', async () => {
    const root = await fixtureProject();
    const manifestPath = path.join(root, 'liftoff.manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

    // simulate a 0.2.0 manifest: seed entries recorded as governance artifacts
    const seedFiles: Array<[string, string]> = [
      ['openspec-seed-change-metadata', '.openspec.yaml'],
      ['openspec-seed-proposal', 'proposal.md'],
      ['openspec-seed-design', 'design.md'],
      ['openspec-seed-tasks', 'tasks.md']
    ];
    for (const [logicalName, fileName] of seedFiles) {
      const bytes = await readFile(path.join(root, ...SEED_DIR, fileName));
      manifest.artifacts.push({
        logicalName,
        category: 'governance',
        pathParts: [...SEED_DIR, fileName],
        contentHash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`
      });
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    await archiveSeedChange(root);

    const check = await run(['update'], root);
    expect(check.code).toBe(0);
    expect(check.out).toContain('No drift');

    const validate = await run(['validate'], root);
    expect(validate.code).toBe(0);

    await run(['update', '--apply'], root);
    const rewritten = JSON.parse(await readFile(manifestPath, 'utf8'));
    expect(
      rewritten.artifacts.filter((artifact: { logicalName: string }) => artifact.logicalName.startsWith('openspec-seed'))
    ).toEqual([]);
  });

  it('keeps the emitted migrate-to-liftoff change invisible after archiving', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'liftoff-seed-migrate-'));
    cleanups.push(parent);
    const source = path.join(parent, 'old-shop');
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'requirements.txt'), 'fastapi==0.111.0\n');

    const migrated = await run(['migrate', source, '--pattern', 'prompt', '--region', 'eastus', '--yes'], parent);
    expect(migrated.code).toBe(0);
    const target = path.join(parent, 'old-shop-liftoff');

    await mkdir(path.join(target, 'openspec', 'changes', 'archive'), { recursive: true });
    await rename(
      path.join(target, 'openspec', 'changes', 'migrate-to-liftoff'),
      path.join(target, 'openspec', 'changes', 'archive', 'done-migrate-to-liftoff')
    );

    const check = await run(['update'], target);
    expect(check.code).toBe(0);
    expect(check.out).toContain('No drift');

    const validate = await run(['validate'], target);
    expect(validate.code).toBe(0);
  });
});
