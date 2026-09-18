import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileTree, journalCases } from './journal-producer.mjs';

const releases = [
  { release: 'v0.11.2', commit: '7ae307a0269f31cc4737336b8d445ade336e2ff0' },
  { release: 'v0.12.2', commit: '06cb0b065022663e5dafb3a295e14f6a0d221ab7' },
  { release: 'v0.12.3', commit: '70d10881b46d873118d825735696f39b6d35ebe0' }
];
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const destination = path.resolve(process.argv[2] ?? path.join(scriptRoot, 'corpus-v2'));
const relative = path.relative(process.cwd(), destination);
if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
  throw new Error('Capture destination must be a new directory beneath the checkout.');
}
await mkdir(destination, { mode: 0o700 });
const work = path.join(destination, '.capture-work');
await mkdir(work, { mode: 0o700 });
await mkdir(path.join(destination, 'blobs'), { mode: 0o700 });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const emitted = new Set();
const usedSources = new Map(releases.map(({ release }) => [release, new Set()]));
const journalSources = new Map(releases.map(({ release }) => [release, new Set()]));

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: process.cwd(), timeout: 60_000, maxBuffer: 64 * 1024 * 1024, ...options
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${executable} failed: ${result.error ?? result.stderr?.toString()}`);
  }
  return result.stdout;
}

async function blob(bytes) {
  const digest = sha256(bytes);
  if (!emitted.has(digest)) {
    emitted.add(digest);
    await writeFile(path.join(destination, 'blobs', digest), bytes, { flag: 'wx', mode: 0o600 });
  }
  return { sha256: digest, byteLength: bytes.length };
}

async function files(entries) {
  return Promise.all(entries.map(async ({ path: filePath, bytes, mode }) => ({
    path: filePath, mode, ...await blob(Buffer.from(bytes, 'base64'))
  })));
}

async function sourceAssets(root, prefix = 'assets') {
  const result = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const name = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await sourceAssets(root, name));
    else if (entry.isFile()) result.push(name);
    else throw new Error(`Non-regular archive asset: ${name}`);
  }
  return result;
}

try {
  for (const release of releases) {
    const peeled = command('git', ['rev-parse', `${release.release}^{commit}`]).toString().trim();
    if (peeled !== release.commit) throw new Error(`Immutable release commit differs: ${release.release}`);
    release.tagObject = command('git', ['rev-parse', release.release]).toString().trim();
    const root = path.join(work, release.release);
    await mkdir(root, { mode: 0o700 });
    const fixturePaths = release.release === 'v0.12.3'
      ? ['tests/fixtures/activation-v1', 'tests/fixtures/activation-v2', 'tests/governance-activation-fixtures.ts']
      : [];
    const archive = command('git', ['archive', release.commit, 'src', 'assets', 'package.json', 'LICENSE', ...fixturePaths]);
    command('tar', ['-x', '-C', root], { input: archive });
    for (const name of ['package.json', 'LICENSE', ...await sourceAssets(root)]) usedSources.get(release.release).add(name);
  }
  const activationDirectory = path.join(work, 'activation');
  await mkdir(activationDirectory, { mode: 0o700 });
  command(process.execPath, [path.join(scriptRoot, 'activation-producer.mjs'), JSON.stringify({
    baselineRoot: path.join(work, 'v0.12.3'), ancestorRoot: path.join(work, 'v0.11.2'),
    destination: activationDirectory
  })]);
  const activation = JSON.parse(await readFile(path.join(activationDirectory, 'activation-capture.json'), 'utf8'));
  const cases = [];
  for (const entry of activation.cases) {
    cases.push({
      ...entry, family: 'activation', files: await files(entry.files),
      ...(entry.externalAuthority ? { externalAuthority: await files(entry.externalAuthority) } : {})
    });
  }
  for (const [release, paths] of Object.entries(activation.sourceFiles)) {
    paths.forEach((name) => usedSources.get(release).add(name));
  }
  for (const writer of journalCases) {
    for (const checkpoint of [{ phase: 'after-mutation', index: 2 }, { phase: 'committed' }]) {
      const id = `${writer.id}-${checkpoint.phase === 'committed' ? 'committed' : 'interrupted'}`;
      const workspace = path.join(work, id);
      await mkdir(workspace, { mode: 0o700 });
      const child = spawnSync(process.execPath, [path.join(scriptRoot, 'journal-producer.mjs'), JSON.stringify({
        sourceRoot: path.join(work, writer.release), workspace, caseId: writer.id, checkpoint
      })], { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000 });
      if (child.error || child.status !== 73) throw new Error(`Released journal capture failed: ${id}: ${child.error ?? child.stderr}`);
      const handoverBytes = await readFile(path.join(workspace, 'handover.json'));
      const handover = JSON.parse(handoverBytes.toString('utf8'));
      const projectFiles = await fileTree(handover.root);
      const journalPath = `.liftoff/reviewed-${writer.kind}-transaction.json`;
      const journal = projectFiles.find((file) => file.path === journalPath);
      if (!journal) throw new Error(`Missing released journal: ${id}`);
      const header = JSON.parse(Buffer.from(journal.bytes, 'base64').toString('utf8').split('\n')[0]);
      if (header.projectRoot !== handover.root || header.schemaVersion !== writer.schemaVersion ||
          Object.hasOwn(header, 'transactionKind') !== writer.explicitKind) {
        throw new Error(`Released journal contract differs: ${id}`);
      }
      const lock = await readFile(handover.lock);
      if (JSON.parse(lock.toString('utf8')).pid !== child.pid) throw new Error('Released journal owner is not the terminated producer.');
      cases.push({
        id, family: 'journal', writerId: writer.id, release: writer.release, kind: writer.kind,
        schemaVersion: writer.schemaVersion, explicitKind: writer.explicitKind,
        ...(writer.recipe ? { recipe: writer.recipe } : {}),
        checkpoint, root: handover.root, home: handover.home,
        authority: {
          release: writer.release, kind: 'released-writer-and-private-seal-store-output',
          entrypoints: [
            'src/adapters/filesystem/reviewed-update-transaction.ts#applyReviewedUpdateTransaction',
            'src/adapters/filesystem/update-previews.ts#createUpdateTransactionApprovalStore'
          ],
          limitations: 'Original root, nonce, owner and external seals are immutable static evidence. Do not relocate, rebase, reseal or recover this static capture as another project.'
        },
        files: await files(projectFiles),
        externalSeals: await files(await fileTree(handover.home)),
        owner: { path: handover.lock, mode: (await lstat(handover.lock)).mode & 0o7777, ...await blob(lock) },
        handover: await blob(handoverBytes), journalPath
      });
      const dependencies = JSON.parse(await readFile(path.join(workspace, 'loaded-source.json'), 'utf8'));
      for (const name of [...dependencies, 'assets/supported-stack.json', 'assets/governance/single-maintainer-gitflow/policy.md', 'LICENSE']) {
        usedSources.get(writer.release).add(name);
        journalSources.get(writer.release).add(name);
      }
    }
  }
  const sources = [];
  for (const release of releases) {
    const tree = new Map(command('git', ['ls-tree', '-r', release.commit]).toString().trim().split('\n').map((line) => {
      const match = /^(\d+) blob ([a-f0-9]{40})\t(.+)$/.exec(line);
      return match ? [match[3], { mode: Number.parseInt(match[1], 8) & 0o777, gitBlob: match[2] }] : [line, null];
    }));
    const entries = [];
    for (const name of [...usedSources.get(release.release)].sort()) {
      const git = tree.get(name);
      if (!git) throw new Error(`Unversioned source cannot enter the corpus: ${release.release}:${name}`);
      const bytes = await readFile(path.join(work, release.release, ...name.split('/')));
      const gitBlob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      if (gitBlob !== git.gitBlob) throw new Error(`Archive bytes differ from their source commit: ${name}`);
      entries.push({ path: name, ...git, ...await blob(bytes) });
    }
    sources.push({ ...release, files: entries, journalExecutionFiles: [...journalSources.get(release.release)].sort() });
  }
  const index = {
    schemaVersion: 1,
    implementationBaseline: { release: 'v0.12.3', commit: releases[2].commit },
    capture: {
      platform: process.platform, node: process.version,
      source: 'git archive of verified annotated-tag peeled commits; TypeScript transformed in memory by existing rolldown/utils',
      goldenBytes: 'Unmodified emitted buffers; content-addressed deduplication changes neither bytes nor file identities. Modes record the capture filesystem, not Git checkout permission bits.',
      authority: 'Offline source characterization only; no native, installed-artifact, provider, publication or release qualification.',
      replay: 'Static root-bound journals are refusal fixtures outside their original roots. Positive recovery separately invokes the captured released source in a fresh private project and hands its unmodified bytes/seals to current readers at that SAME root.',
      regeneration: 'Run node tests/fixtures/released-baseline/capture.mjs <NEW checkout-relative directory>. UUIDs, owner PIDs and absolute roots are intentionally not deterministic. Never overwrite this corpus or normalize new output to match it.'
    },
    sources, cases,
    counts: { cases: cases.length, blobs: emitted.size, sourceFiles: sources.reduce((sum, source) => sum + source.files.length, 0) }
  };
  const indexBytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`);
  await writeFile(path.join(destination, 'index.json'), indexBytes, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ path: path.relative(process.cwd(), destination), indexSha256: sha256(indexBytes), ...index.counts }));
} finally {
  await rm(work, { recursive: true, force: true });
}
