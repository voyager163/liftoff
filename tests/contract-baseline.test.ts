import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as args from '../src/args.js';
import * as commands from '../src/commands.js';
import * as planner from '../src/planner.js';
import * as templates from '../src/templates.js';
import * as fileSystem from '../src/file-system.js';
import * as identity from '../src/domain/governance/policy/identity.js';
import * as graph from '../src/domain/governance/activation/graph.js';
import * as compatibility from '../src/governance-activation/compatibility.js';
import {
  ContractBaselineError,
  assertCaptureDestination,
  assertWriterObservations,
  baselineComparison,
  baselineInventory,
  canonicalGraphHash,
  captureActivation,
  captureArtifacts,
  captureGovernanceHistory,
  captureJson,
  captureText,
  captureWriterGovernance,
  comparisonPlatforms,
  comparisonUnrunPlatforms,
  contractBaselineParts,
  contractBaselineRevision,
  contractChangesParts,
  existingManifestFixtures,
  historicalWriters,
  interpretManifest,
  publishedBaseline,
  maskPointers,
  normalizeHostText,
  sha256,
  stableDigest,
  volatilePointers
} from '../scripts/contract-baseline.mjs';

// Pinned so that re-capturing the baseline is a visible, reviewed test change.
// The one pre-acceptance metadata correction records the original digest.
const provenanceSha256 = '28c4eb160dfe35530f4ac36d1dfa67a96571fee2f38177de65a5f9e91f7b9c12';
const capturedProvenanceSha256 = 'fc51a9a14122c3b60ba04a2aa0ff42daedb3948cb0b0d3ee0d7c7a4db1515cac';

const modules = { args, commands, planner, templates, fileSystem, identity, graph, compatibility };
// Existing fixtures may be checked out with CRLF on Windows; compare their Git content.
const lfSha256 = (file: string) => sha256(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
const directory = path.join(process.cwd(), ...contractBaselineParts);
const frozen = (file: string) => JSON.parse(readFileSync(path.join(directory, ...file.split('/')), 'utf8'));
const review = JSON.parse(readFileSync(path.join(process.cwd(), ...contractChangesParts), 'utf8'));
const hostVerified = (comparisonPlatforms as readonly string[]).includes(process.platform);

type Change = {
  surface: string; key: string; task: string; reason: string; baselineSha256: string; currentSha256: string;
  addedVolatilePointers?: string[];
};

// Current behavior must equal the frozen capture, or carry an exact reviewed
// record naming both digests; a record that no longer applies is stale.
function expectFrozen(surface: string, key: string, current: unknown, baseline: unknown) {
  const verdict = baselineComparison(surface, key, current, baseline, review.changes);
  expect(['unchanged', 'recorded-change'], `${surface} ${key}: ${JSON.stringify(verdict)} (record intentional changes in ${contractChangesParts.join('/')})`)
    .toContain(verdict.status);
}

describe('frozen 0.12.3 contract baseline provenance', () => {
  it('is the unmodified capture of the baseline commit and the published package', () => {
    const provenance = frozen('provenance.json');
    expect(sha256(readFileSync(path.join(directory, 'provenance.json')))).toBe(provenanceSha256);
    expect(baselineInventory(directory)).toEqual(provenance.files);
    expect(provenance.checkout).toMatchObject({ revision: contractBaselineRevision, packageVersion: '0.12.3' });
    expect(provenance.published).toMatchObject(publishedBaseline);
    expect(provenance.comparison).toEqual({
      surfaces: 'identical', differences: [], manifestReaders: 'identical', manifestReaderDifferences: []
    });
    expect(provenance.historicalWriters.map((writer: { version: string; integrity: string }) => [writer.version, writer.integrity]))
      .toEqual(historicalWriters.map((writer: { version: string; integrity: string }) => [writer.version, writer.integrity]));
  });

  it('records only the host that actually ran the capture as observed', () => {
    const { capture, metadataCorrections } = frozen('provenance.json');
    expect(capture.platform).toBe('darwin/arm64');
    expect(capture.observedPlatforms).toEqual([capture.platform]);
    expect(capture.comparisonPlatforms).toEqual([...comparisonPlatforms]);
    expect(capture.unrunPlatforms).toEqual(comparisonUnrunPlatforms('darwin'));
    expect(capture).not.toHaveProperty('verifiedPlatforms');
    expect(metadataCorrections).toEqual([expect.objectContaining({
      previousProvenanceSha256: capturedProvenanceSha256, observationBytesChanged: false
    })]);
  });

  it('gives every published writer an explicit governance observation that matches the frozen history', () => {
    const provenance = frozen('provenance.json');
    const writers = frozen('history.json').governanceWriters;
    expect(() => assertWriterObservations(provenance.historicalWriters.map((writer: { version: string; governance: string }) =>
      ({ version: writer.version, governance: { status: writer.governance } })))).not.toThrow();
    const rendered = provenance.historicalWriters.filter((writer: { governance: string }) => writer.governance === 'rendered');
    expect(rendered.map((writer: { version: string }) => writer.version)).toEqual(Object.keys(writers));
    expect(provenance.historicalWriters.filter((writer: { governance: string }) => writer.governance === 'none')
      .map((writer: { version: string }) => writer.version)).toEqual(['0.3.4', '0.4.1', '0.7.0']);
  });

  it('keeps every change record, known defect and intended rejection explicit', () => {
    expect(review.baseline).toBe(contractBaselineParts.at(-1));
    for (const change of review.changes as Change[]) {
      expect(change).toEqual(expect.objectContaining({
        surface: expect.any(String), key: expect.any(String), task: expect.any(String), reason: expect.any(String),
        baselineSha256: expect.stringMatching(/^[0-9a-f]{64}$/), currentSha256: expect.stringMatching(/^[0-9a-f]{64}$/)
      }));
    }
    for (const entry of [...review.knownDefects, ...review.intendedRejections]) {
      expect(entry.surface).toBe('manifest-readers');
      expect(entry.files.length).toBeGreaterThan(0);
    }
  });
});

describe('frozen public CLI surfaces', () => {
  it.skipIf(!hostVerified)('keeps help, reference and rejected-syntax output unchanged', async () => {
    const current = await captureText(modules);
    const baseline = frozen('cli-text.json');
    expect(Object.keys(current)).toEqual(Object.keys(baseline));
    for (const key of Object.keys(baseline)) expectFrozen('cli-text', key, current[key], baseline[key]);
  }, 60_000);

  it.skipIf(!hostVerified)('keeps JSON results unchanged apart from recorded volatile values', async () => {
    const current: Record<string, { volatile: string[]; json: { schemaVersion?: number } }> = await captureJson(modules);
    const baseline = frozen('cli-json.json');
    expect(Object.keys(current)).toEqual(Object.keys(baseline));
    for (const [key, value] of Object.entries(baseline) as [string, { volatile: string[]; json: { schemaVersion?: number } }][]) {
      const newlyVolatile = current[key].volatile.filter((pointer: string) => !value.volatile.includes(pointer));
      const change = (review.changes as Change[]).find(entry => entry.surface === 'cli-json' && entry.key === key);
      if (change?.addedVolatilePointers) {
        expect(key).toBe('update --check --json');
        expect(change.task).toBe('3.7');
        expect(value.json.schemaVersion).toBe(3);
        expect(current[key].json.schemaVersion).toBe(4);
      }
      expect(newlyVolatile, `${key} gained unreviewed nondeterministic values`).toEqual(change?.addedVolatilePointers ?? []);
      expectFrozen('cli-json', key, current[key], value);
    }
  }, 60_000);

  it('keeps every rendered artifact for the representative plans byte-identical', () => {
    const current: Record<string, unknown> = captureArtifacts(modules);
    const baseline = frozen('rendered-artifacts.json');
    expect(Object.keys(current)).toEqual(Object.keys(baseline));
    for (const key of Object.keys(baseline)) expectFrozen('rendered-artifacts', key, current[key], baseline[key]);
  });
});

describe('frozen historical manifests and identities', () => {
  it('preserves the original historical fixture bytes', () => {
    const readers = frozen('manifest-readers.json');
    for (const file of existingManifestFixtures) {
      expect(lfSha256(path.join(process.cwd(), ...file.split('/'))), file).toBe(readers.existingFixtures[file]);
    }
    expect(readers.capturedManifests.map((entry: { writer: string }) => entry.writer))
      .toEqual(historicalWriters.flatMap((writer: { version: string }) => [writer.version, writer.version]));
  });

  it('interprets every authentic v2-v7 manifest exactly as the 0.12.3 readers did', () => {
    const readers = frozen('manifest-readers.json');
    const files = [
      ...readers.capturedManifests.map((entry: { file: string }) => ({ key: entry.file, file: path.join(directory, ...entry.file.split('/')) })),
      ...existingManifestFixtures.map((file: string) => ({ key: file, file: path.join(process.cwd(), ...file.split('/')) }))
    ];
    const versions = new Set<number>();
    for (const { key, file } of files) {
      const text = readFileSync(file, 'utf8');
      versions.add(JSON.parse(text).artifactVersion);
      expectFrozen('manifest-readers', key, interpretManifest(modules, text), readers.interpretations[key]);
    }
    expect([...versions].sort()).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it('labels each observed rejection as a known defect or an intended rejection, never as silent support', () => {
    const readers = frozen('manifest-readers.json');
    const classified = new Map<string, string>();
    for (const entry of review.knownDefects) for (const file of entry.files) classified.set(file, `defect:${entry.id}`);
    for (const entry of review.intendedRejections) for (const file of entry.files) classified.set(file, `intended:${entry.id}`);
    const rejected = Object.entries(readers.interpretations as Record<string, { ok: boolean; error?: string }>)
      .filter(([, value]) => !value.ok);
    expect(rejected.map(([file]) => file).sort()).toEqual([...classified.keys()].sort());
    for (const [file, value] of rejected) {
      const entry = [...review.knownDefects, ...review.intendedRejections].find((item) => item.files.includes(file));
      expect(value.error, file).toBe(entry.observed);
    }
    const defect = review.knownDefects.find((entry: { id: string }) => entry.id === 'historical-v5-v6-governed-manifest-rejected');
    expect(defect.owner).toBe('task 3.2');
    const writers = frozen('history.json').governanceWriters;
    for (const artifact of defect.firstAppearance.artifacts) {
      expect(Object.keys(writers[defect.firstAppearance.lastPublishedWithout].artifacts)).not.toContain(artifact);
      expect(Object.keys(writers[defect.firstAppearance.firstPublishedWith].artifacts)).toContain(artifact);
    }
    for (const file of defect.files) {
      const manifest = JSON.parse(readFileSync(path.join(directory, ...file.split('/')), 'utf8'));
      expect([5, 6]).toContain(manifest.artifactVersion);
      expect(manifest.governance).toMatchObject({ profile: 'single-maintainer-gitflow', state: 'handoff-generated' });
    }
  });

  it('keeps the released activation identities and their original graph hashes', () => {
    const baseline = frozen('activation-identities.json');
    expectFrozen('activation-identities', 'all', captureActivation(modules), baseline);
    const history = frozen('history.json');
    const byContract = Object.fromEntries(Object.values(history.governanceWriters as Record<string, { activationContractVersion?: number; phaseGraphCanonicalSha256: string }>)
      .filter((writer) => writer.activationContractVersion).map((writer) => [writer.activationContractVersion, writer.phaseGraphCanonicalSha256]));
    expect(byContract).toEqual({
      1: baseline.historical[0].phaseGraphHash,
      2: baseline.historical[1].phaseGraphHash,
      3: baseline.current.phaseGraphHash
    });
    const asset = path.join(process.cwd(), 'assets', 'governance', 'single-maintainer-gitflow', 'activation-v2-graph.json');
    const bytes = readFileSync(asset);
    expect({ sha256: sha256(bytes), canonicalSha256: canonicalGraphHash(JSON.parse(bytes.toString('utf8'))) })
      .toEqual({ sha256: history.packagedHistoricalGraph.sha256, canonicalSha256: baseline.historical[1].phaseGraphHash });
    expectFrozen('governance-history', 'checkout', captureGovernanceHistory(modules), history.checkoutGovernance);
  });
});

describe('fail-closed baseline comparison', () => {
  const baseline = { exitCode: 0, stdout: 'Liftoff 0.12.3\n' };
  const current = { exitCode: 0, stdout: 'Liftoff 0.13.0\n' };
  const record = {
    surface: 'cli-text', key: '--version', task: '3.5', reason: 'Reviewed version change',
    baselineSha256: stableDigest(baseline), currentSha256: stableDigest(current)
  };

  it('accepts only unchanged output or one exact reviewed record', () => {
    expect(baselineComparison('cli-text', '--version', baseline, baseline, []).status).toBe('unchanged');
    expect(baselineComparison('cli-text', '--version', current, baseline, [record]).status).toBe('recorded-change');
  });

  it.each([
    ['an unrecorded change', current, [], 'unrecorded-change'],
    ['a stale record after behavior returns', baseline, [record], 'stale-record'],
    ['a record for different bytes', { ...current, stdout: 'Liftoff 0.14.0\n' }, [record], 'mismatched-record'],
    ['a record without a task', current, [{ ...record, task: '' }], 'mismatched-record'],
    ['duplicate records', current, [record, record], 'ambiguous-record']
  ])('rejects %s', (_label, value, changes, status) => {
    expect(baselineComparison('cli-text', '--version', value, baseline, changes).status).toBe(status);
  });

  it('masks only values that differ between isolated captures and rejects unstable structure', () => {
    const left = { id: 'fixed', digest: 'a'.repeat(64), items: [{ path: '<project>/x' }] };
    const right = { id: 'fixed', digest: 'b'.repeat(64), items: [{ path: '<project>/x' }] };
    expect(volatilePointers(left, right)).toEqual(['/digest']);
    expect(maskPointers(left, ['/digest'])).toEqual({ ...left, digest: '<volatile>' });
    expect(() => volatilePointers({ items: [1] }, { items: [1, 2] })).toThrow(ContractBaselineError);
    expect(() => volatilePointers({ a: 1 }, { b: 1 })).toThrow(ContractBaselineError);
  });

  it('normalizes host roots, separators and timestamps without touching other content', () => {
    const root = path.join(process.cwd(), '.cache', 'contract host root');
    const windowsLike = `${root}\\nested\\file.json`;
    expect(normalizeHostText(`at ${root}/a/b.json on 2026-09-24T15:56:31.441Z`, [[root, '<project>']]))
      .toBe('at <project>/a/b.json on <timestamp>');
    expect(normalizeHostText(windowsLike, [[root, '<project>']])).toBe('<project>/nested/file.json');
    expect(normalizeHostText('seed-valid-20260924T155631690Z.json', [])).toBe('seed-valid-<timestamp>.json');
    expect(normalizeHostText('unrelated /usr/bin text', [[root, '<project>']])).toBe('unrelated /usr/bin text');
  });

  it('refuses to overwrite the frozen baseline directory', () => {
    expect(() => assertCaptureDestination(directory)).toThrow(/Refusing to overwrite the frozen contract baseline/);
    expect(() => assertCaptureDestination(path.join(directory, 'absent-capture-destination'))).not.toThrow();
  });
});

describe('explicit historical writer observations', () => {
  const base = { planner: { buildProjectPlan: () => ({}) } };

  it('reports a producer failure instead of dropping the writer', () => {
    const failing = { ...base, templates: { buildArtifacts: () => { throw new Error('synthetic producer failure'); } } };
    expect(captureWriterGovernance(failing)).toEqual({ status: 'failed', error: 'synthetic producer failure' });
    expect(() => assertWriterObservations([{ version: '9.9.9', governance: captureWriterGovernance(failing) }]))
      .toThrow('Published 9.9.9 governance capture failed: synthetic producer failure');
  });

  it('distinguishes a writer that predates governance from one that rendered it', () => {
    const none = { ...base, templates: { buildArtifacts: () => [{ logicalName: 'manifest', pathParts: ['liftoff.manifest.json'], content: '{}' }] } };
    expect(captureWriterGovernance(none)).toEqual({ status: 'none' });
    const rendered = { ...base, templates: { buildArtifacts: () => [{
      logicalName: 'repository-governance-policy', pathParts: ['.liftoff', 'governance', 'policy.md'], content: 'policy\n'
    }] } };
    expect(captureWriterGovernance(rendered)).toEqual({
      status: 'rendered', phaseGraphCanonicalSha256: null,
      artifacts: { 'repository-governance-policy': { path: '.liftoff/governance/policy.md', contentSha256: sha256('policy\n') } }
    });
    expect(() => assertWriterObservations([{ version: '0.0.1', governance: undefined }])).toThrow('no explicit governance observation');
  });
});
