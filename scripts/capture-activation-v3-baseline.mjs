import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';

const baseline = '70d10881b46d873118d825735696f39b6d35ebe0';
const cache = new Map();
const sourceDigests = {};
const readerFiles = new Map();
function baselineSource(file) {
  if (!file.startsWith('src/domain/governance/') &&
      !['src/domain/project/paths.ts', 'src/domain/project/errors.ts'].includes(file)) {
    throw new Error(`Unexpected baseline dependency ${file}.`);
  }
  const source = execFileSync('git', ['show', `${baseline}:${file}`], { encoding: 'utf8' });
  sourceDigests[file] = createHash('sha256').update(source).digest('hex');
  return source;
}
function moduleUrl(file) {
  if (cache.has(file)) return cache.get(file);
  const source = baselineSource(file);
  const javascript = stripTypeScriptTypes(source).replace(/(from\s+['"])(\.[^'"]+)(['"])/g, (_, prefix, reference, suffix) => {
    const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(file), reference.replace(/\.js$/, '.ts')));
    return `${prefix}${moduleUrl(dependency)}${suffix}`;
  });
  const url = `data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`;
  cache.set(file, url);
  return url;
}

function collectReader(file) {
  if (readerFiles.has(file)) return;
  const javascript = stripTypeScriptTypes(baselineSource(file));
  readerFiles.set(file, javascript);
  for (const [, reference] of javascript.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
    collectReader(path.posix.normalize(path.posix.join(path.posix.dirname(file), reference.replace(/\.js$/, '.ts'))));
  }
}

if (process.argv.includes('--readers-only')) {
  collectReader('src/domain/governance/activation/validators.ts');
  collectReader('src/domain/governance/activation/operations.ts');
  const root = 'assets/governance/single-maintainer-gitflow/activation-v3-reader';
  const files = [];
  for (const [source, javascript] of readerFiles) {
    const relative = source.replace(/^src\//, '').replace(/\.ts$/, '.js');
    await mkdir(path.posix.dirname(`${root}/${relative}`), { recursive: true });
    await writeFile(`${root}/${relative}`, javascript, { flag: 'wx' });
    files.push({ path: relative, digest: createHash('sha256').update(javascript).digest('hex') });
  }

  await writeFile(`${root}/index.json`, `${JSON.stringify({ baseline, sourceDigests, files }, null, 2)}\n`, { flag: 'wx' });
  console.log(`Captured ${files.length} pure historical reader modules; no execution adapters are included.`);
  process.exit(0);
}

const graph = await import(moduleUrl('src/domain/governance/activation/graph.ts'));
const inputs = await import(moduleUrl('src/domain/governance/activation/inputs.ts'));
if (graph.currentActivationIdentity.liftoffVersion !== '0.12.0' ||
    graph.currentActivationIdentity.activationContractVersion !== 3 ||
    graph.canonicalPhaseGraphHash !== '2e214353fe73edeea246dac49aa5126c3d1e50afb3e12801940b661afb853703') {
  throw new Error('The immutable source no longer resolves to the released v3 identity.');
}
const snapshot = {
  schemaVersion: 2,
  project: { name: 'released-v3' },
  files: [
    { path: 'README.md', digest: 'a'.repeat(64) },
    { path: '.github/workflows/checks.yml', digest: 'b'.repeat(64) }
  ],
  git: { head: 'c'.repeat(40), branch: 'develop', pushUrls: ['https://github.com/example/released-v3.git'] },
  baselineSha: 'd'.repeat(64)
};
const phases = {};
const configuration = {
  schemaVersion: 1, phases: {},
  azure: {
    subscriptionId: '11111111-1111-4111-8111-111111111111',
    tenantId: '22222222-2222-4222-8222-222222222222',
    region: 'eastus'
  }
};
const fixtures = {
  baseline, sourceDigests,
  identity: graph.currentActivationIdentity,
  graphHash: graph.canonicalPhaseGraphHash,
  phaseContractDigests: graph.canonicalPhaseContractDigests,
  snapshot,
  configuration,
  inputDigests: Object.fromEntries(['seed-valid', 'committed', 'pushed', 'phase-0-complete'].map((id) => [
    id, {
      absent: inputs.phaseInputDigest(id, snapshot),
      empty: inputs.phaseInputDigest(id, snapshot, { phases, activationInputs: { schemaVersion: 1, phases: {} } }),
      azure: inputs.phaseInputDigest(id, snapshot, { phases, activationInputs: configuration })
    }
  ]))
};
const assetRoot = 'assets/governance/single-maintainer-gitflow';
const fixtureRoot = 'tests/fixtures/activation-history';
await mkdir(assetRoot, { recursive: true });
await mkdir(fixtureRoot, { recursive: true });
await writeFile(`${assetRoot}/activation-v3-graph.json`, `${JSON.stringify(graph.canonicalPhaseGraph, null, 2)}\n`, { flag: 'wx' });
await writeFile(`${fixtureRoot}/v3-baseline.json`, `${JSON.stringify(fixtures, null, 2)}\n`, { flag: 'wx' });
console.log(`Captured ${baseline}: ${graph.canonicalPhaseGraphHash}`);
