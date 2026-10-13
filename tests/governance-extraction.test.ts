import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it, vi } from 'vitest';
import * as commands from '../src/commands.js';
import * as governance from '../src/repository-governance.js';
import * as governanceCommands from '../src/governance-activation/commands.js';
import {
  acceptedPreExtractionSources, acceptedSourceInventory, cliSnapshot, harnessFile, renderingSnapshot, sha256,
  sourceTreeInventory, type Snapshot
} from './fixtures/governance-extraction/harness.js';
import { expectReviewedRendering } from './fixtures/reviewed-rendering.js';
import { CaptureStream } from './helpers.js';

// Pre-extraction behavior for task 2.1 is captured only from the exact accepted source tree
// and then compared byte-for-byte after the responsibility extraction. Later intentional
// behavior requires exact before/after records; the capture and its harness remain frozen.
const captureMode = process.env.GOVERNANCE_EXTRACTION_CAPTURE === '1';
const fixtureFile = path.join(process.cwd(), 'tests', 'fixtures', 'governance-extraction', 'pre-extraction.json');

interface RecordedSnapshot {
  provenance: Snapshot & { platform: string; harness: { file: string; sha256: string } };
  rendering: Snapshot;
  cli: Snapshot;
}

function recordedSnapshot(): RecordedSnapshot {
  return JSON.parse(readFileSync(fixtureFile, 'utf8')) as RecordedSnapshot;
}

interface CliResult {
  exitCode: number | string;
  stdout: { bytes: number; sha256: string; text?: string };
  stderr: { bytes: number; sha256: string; text?: string };
}

interface CliReview {
  surface: string;
  key: string;
  currentSha256: string;
  priorCurrentSha256?: string;
  priorChange?: CliReview;
}

const cliReviews: CliReview[] = JSON.parse(readFileSync(
  new URL('./fixtures/contract-baseline-changes.json', import.meta.url), 'utf8'
)).changes.filter((entry: CliReview) => entry.surface === 'governance-extraction-cli');
const { baselineComparison }: {
  baselineComparison: (surface: string, key: string, current: unknown, baseline: unknown, changes: CliReview[]) => { status: string };
} = createRequire(import.meta.url)('../scripts/contract-baseline.mjs');

async function observedCliSnapshot(): Promise<{ snapshot: Snapshot; stdout: Record<string, string> }> {
  const execute = commands.runCommand;
  const observed: Array<{ normalize: (value: string) => string; stdout: string; stderr: string }> = [];
  const observer = vi.spyOn(commands, 'runCommand').mockImplementation(async (args, context) => {
    try {
      return await execute(args, context);
    } finally {
      if (context?.stdout instanceof CaptureStream && context.stderr instanceof CaptureStream &&
        typeof context.terminal?.normalize === 'function') {
        observed.push({
          normalize: context.terminal.normalize,
          stdout: context.stdout.text(), stderr: context.stderr.text()
        });
      }
    }
  });
  try {
    const snapshot = await cliSnapshot();
    const results = snapshot.results as Record<string, CliResult>;
    const stdout = Object.fromEntries(cliReviews.map(({ key }) => {
      const result = results[key]!;
      const matches = observed.filter((entry) =>
        sha256(entry.normalize(entry.stdout)) === result.stdout.sha256 &&
        sha256(entry.normalize(entry.stderr)) === result.stderr.sha256);
      expect(matches, `${key} exact unchanged harness streams`).toHaveLength(1);
      const text = matches[0]!.normalize(matches[0]!.stdout);
      expect(Buffer.byteLength(text)).toBe(result.stdout.bytes);
      return [key, text];
    }));
    return { snapshot, stdout };
  } finally {
    observer.mockRestore();
  }
}

function withStdout(result: CliResult, text: string): CliResult {
  return {
    ...result,
    stdout: {
      ...result.stdout, bytes: Buffer.byteLength(text), sha256: sha256(text),
      ...(result.stdout.text === undefined ? {} : { text })
    }
  };
}

function leafPaths(value: unknown, segments: string[] = []): Array<{ segments: string[]; value: unknown }> {
  if (value !== null && typeof value === 'object' && Object.keys(value).length) {
    return Object.entries(value).flatMap(([key, child]) => leafPaths(child, [...segments, key]));
  }
  return [{ segments, value }];
}

function setLeaf(value: unknown, segments: string[], replacement: unknown): void {
  let parent = value;
  for (const segment of segments.slice(0, -1)) {
    if (parent === null || typeof parent !== 'object') throw new Error('Invalid measured CLI field path.');
    parent = Reflect.get(parent, segment);
  }
  if (parent === null || typeof parent !== 'object' || !segments.length) throw new Error('Invalid measured CLI field parent.');
  Reflect.set(parent, segments.at(-1)!, replacement);
}

function assertBoundedApplicationCliChanges(key: string, result: CliResult, text: string, baseline: unknown): void {
  const beforeStdout = {
    'status-json': '142e404b828a87fbd400917a06ebf0cec5848a5c7b2cbd66ad447f8b6887cd2a',
    'status-local-json': '43dad724785afb6157eda3655ee58210c9c6deb0b5dd9bc43b94e4dfdb7f9864',
    'resume-json': '3fd084ac975eec47abc18ee612412cba88bf1f0fa8198923e59da0326f499339'
  };
  if (!Object.hasOwn(beforeStdout, key)) return;
  const payload: Record<string, unknown> = JSON.parse(text);
  expect(`${JSON.stringify(payload, null, 2)}\n`).toBe(text);
  const sourceBlocker = 'Application source producers require both qualified protected handover and custody capabilities, '
    + 'current exact approved resources and a protected execution host; production task13/task14 qualification is not available.';
  for (const [index, phase] of [[17, 'application-prerequisites-ready'], [19, 'application-artifact-ready']] as const) {
    expect((payload.phases as Array<{ id: string }>)[index]!.id).toBe(phase);
    for (const [path, after, before] of [
      [['phases', String(index), 'capability', 'executor'], 'injected-only', 'unavailable'],
      [['phases', String(index), 'capability', 'blocker'], sourceBlocker, 'No production executor is available.'],
      [['phases', String(index), 'blockers', '0'], sourceBlocker, 'No production executor is available.']
    ] as const) {
      const actual = path.reduce<unknown>((value, segment) =>
        value !== null && typeof value === 'object' ? Reflect.get(value, segment) : undefined, payload);
      expect(actual, `${key} ${path.join('/')}`).toBe(after);
      setLeaf(payload, [...path], before);
    }
  }
  if (key === 'status-json') {
    expect(payload.blockerFingerprint).toBe('1defc0e6ee6332ee3d0214e92909da917a9ea38b9105658573f016b710aa99aa');
    payload.blockerFingerprint = '1291348f96833faf49cf7a051d0fbebb978187ff8d1ad17f31fb73f1d8bd3b61';
    for (const index of [16, 18]) {
      expect((payload.blockers as Array<{ message: string }>)[index]!.message).toBe(sourceBlocker);
      setLeaf(payload, ['blockers', String(index), 'message'], 'No production executor is available.');
    }
  }
  const recovered = `${JSON.stringify(payload, null, 2)}\n`;
  expect(sha256(recovered), `${key} every other field preserves measured immutable 13.5 output`)
    .toBe(beforeStdout[key as keyof typeof beforeStdout]);
  const review = cliReviews.find((entry) => entry.key === key)!;
  expect(review.priorCurrentSha256).toBe(review.priorChange?.currentSha256);
  expect(baselineComparison('governance-extraction-cli', key, withStdout(result, recovered), baseline, [review.priorChange!]).status)
    .toBe('recorded-change');
}

describe('governance responsibility extraction parity', () => {
  it.runIf(captureMode)('captures pre-extraction behavior once from the accepted source tree', async () => {
    expect(existsSync(fixtureFile), 'the pre-extraction capture is frozen; it cannot be regenerated').toBe(false);
    expect(sourceTreeInventory(), 'capture only from the accepted pre-extraction source tree').toEqual(acceptedSourceInventory);
    for (const [file, expected] of Object.entries(acceptedPreExtractionSources)) {
      expect(sha256(readFileSync(path.join(process.cwd(), file))), `${file} must be the accepted pre-extraction source`).toBe(expected);
    }
    const snapshot = {
      provenance: {
        purpose: 'Task 2.1 governance extraction: behavior captured before any source move; compare only, never regenerate.',
        baseRevision: '8281c46ab99a83b7226a6520a1a9e444e4a04ab8',
        sourceInventory: acceptedSourceInventory,
        sources: acceptedPreExtractionSources,
        harness: { file: harnessFile, sha256: sha256(readFileSync(path.join(process.cwd(), harnessFile))) },
        platform: process.platform,
        node: process.version
      },
      rendering: renderingSnapshot(),
      cli: await cliSnapshot()
    };
    mkdirSync(path.dirname(fixtureFile), { recursive: true });
    writeFileSync(fixtureFile, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx' });
  }, 120_000);

  it.skipIf(captureMode)('compares only with the exact harness that captured the pre-extraction behavior', () => {
    const { harness } = recordedSnapshot().provenance;
    expect(harness.file).toBe(harnessFile);
    expect(sha256(readFileSync(path.join(process.cwd(), harnessFile))),
      'the capture harness is frozen; recapture from the accepted source tree instead of editing it').toBe(harness.sha256);
  });

  it.skipIf(captureMode)('renders governance artifacts, context, guidance, policy and validation outcomes byte-identically', () => {
    const recorded = recordedSnapshot().rendering;
    const current = renderingSnapshot();
    expect(Object.keys(current)).toEqual(Object.keys(recorded));
    for (const key of Object.keys(recorded)) {
      expectReviewedRendering('governance-extraction', key, current[key], recorded[key]);
    }
  });

  it.skipIf(captureMode || process.platform !== 'darwin')('keeps governance CLI output, errors and exit codes identical', async () => {
    const recorded = recordedSnapshot();
    expect(recorded.provenance.platform).toBe(process.platform);
    const { snapshot: current, stdout } = await observedCliSnapshot();
    expect(current.previewCreated).toBe(recorded.cli.previewCreated);
    const recordedResults = recorded.cli.results as Record<string, unknown>;
    const currentResults = current.results as Record<string, unknown>;
    expect(Object.keys(currentResults)).toEqual(Object.keys(recordedResults));
    for (const key of Object.keys(recordedResults)) {
      expectReviewedRendering('governance-extraction-cli', key, currentResults[key], recordedResults[key]);
    }
    expect(cliReviews.map(({ key }) => key).sort()).toEqual(
      ['status-json', 'status-local-json', 'resume-json', 'plan-json', 'status-human', 'verify-json'].sort());
    for (const { key } of cliReviews) {
      const result = currentResults[key] as CliResult;
      const text = stdout[key]!;
      assertBoundedApplicationCliChanges(key, result, text, recordedResults[key]);
      const verdict = (candidate: CliResult) => baselineComparison(
        'governance-extraction-cli', key, candidate, recordedResults[key], cliReviews).status;
      expect(verdict({ ...result, exitCode: result.exitCode === 0 ? 1 : 0 }), `${key} exit delta`).toBe('mismatched-record');
      expect(verdict({
        ...result, stderr: { bytes: Buffer.byteLength('unreviewed stderr\n'), sha256: sha256('unreviewed stderr\n'), text: 'unreviewed stderr\n' }
      }), `${key} stderr delta`).toBe('mismatched-record');
      if (key === 'status-human') {
        expect(verdict(withStdout(result, `${text}unreviewed\n`))).toBe('mismatched-record');
        continue;
      }
      const payload: Record<string, unknown> = JSON.parse(text);
      for (const field of leafPaths(payload)) {
        const mutated = structuredClone(payload);
        const value = typeof field.value === 'string' ? `${field.value} unreviewed`
          : typeof field.value === 'number' ? field.value + 1 : typeof field.value === 'boolean' ? !field.value : 'unreviewed';
        setLeaf(mutated, field.segments, value);
        expect(verdict(withStdout(result, `${JSON.stringify(mutated, null, 2)}\n`)),
          `${key} unreviewed field ${field.segments.join('/')}`).toBe('mismatched-record');
      }
      expect(verdict(withStdout(result, `${JSON.stringify({ ...payload, unreviewed: true }, null, 2)}\n`)))
        .toBe('mismatched-record');
    }
  }, 120_000);
});

const repositoryGovernanceExports = [
  'assertGovernanceContentSafe', 'buildRepositoryGovernanceArtifacts', 'governanceAgentIntegrations', 'governanceArtifactPaths',
  'governanceContextSchemaVersion', 'governanceInvocationGuide', 'governancePolicySchemaVersion', 'governancePolicyVersion',
  'renderCanonicalGovernancePolicy', 'renderCredentialPolicySchema', 'renderGovernanceAssessmentGuide', 'renderGovernanceContext',
  'validateGovernanceContext', 'validateGovernancePolicy'
];

async function importsOf(file: string): Promise<{ declarations: string[]; imports: string[] }> {
  const source = await readFile(path.join(process.cwd(), file), 'utf8');
  const ast = parseAst(source, { lang: 'ts' }, file) as unknown as { body: Array<Record<string, any>> };
  return {
    declarations: ast.body.filter((node) => !['ImportDeclaration', 'ExportAllDeclaration'].includes(node.type) &&
      !(node.type === 'ExportNamedDeclaration' && node.source)).map((node) => node.type),
    imports: ast.body.filter((node) => node.type === 'ImportDeclaration').map((node) => node.source.value)
  };
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(path.join(process.cwd(), directory), { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.ts')).map((entry) => `${directory}/${entry.name}`).sort();
}

async function runtimeClosure(entry: string): Promise<string[]> {
  const visited = new Set<string>();
  const visit = async (file: string): Promise<void> => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = await readFile(path.join(process.cwd(), file), 'utf8');
    const ast = parseAst(source, { lang: 'ts' }, file) as unknown as { body: Array<Record<string, any>> };
    for (const node of ast.body) {
      if (!['ImportDeclaration', 'ExportAllDeclaration', 'ExportNamedDeclaration'].includes(node.type) || !node.source) continue;
      if (node.importKind === 'type' || node.exportKind === 'type') continue;
      if (node.specifiers?.length && node.specifiers.every((specifier: Record<string, unknown>) =>
        specifier.importKind === 'type' || specifier.exportKind === 'type')) continue;
      const specifier = String(node.source.value);
      if (!specifier.startsWith('.')) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier.replace(/\.js$/u, '.ts')));
      await visit(target);
    }
  };
  await visit(entry);
  return [...visited].sort();
}

describe.skipIf(captureMode)('governance responsibility boundaries', () => {
  it('keeps both legacy modules as pure compatibility facades with identical public bindings', async () => {
    const [artifacts, guides, contract, context, schema, inspection, cli] = await Promise.all([
      import('../src/generators/governance/artifacts.js'),
      import('../src/generators/governance/guides.js'),
      import('../src/domain/governance/policy/policy-contract.js'),
      import('../src/domain/governance/policy/context.js'),
      import('../src/domain/governance/activation/credential-policy-schema.js'),
      import('../src/application/governance/inspection.js'),
      import('../src/cli/commands/governance.js')
    ]);
    const catalog = await import('../src/domain/project/catalog.js');
    expect(Object.keys(governance).sort()).toEqual(repositoryGovernanceExports);
    expect(governance.governanceAgentIntegrations).toBe(catalog.governanceAgentIntegrations);
    expect(governance.governanceArtifactPaths).toBe(catalog.governanceArtifactPaths);
    expect(governance.governancePolicySchemaVersion).toBe(contract.governancePolicySchemaVersion);
    expect(governance.governancePolicyVersion).toBe(contract.governancePolicyVersion);
    expect(governance.validateGovernancePolicy).toBe(contract.validateGovernancePolicy);
    expect(governance.assertGovernanceContentSafe).toBe(contract.assertGovernanceContentSafe);
    expect(governance.governanceContextSchemaVersion).toBe(context.governanceContextSchemaVersion);
    expect(governance.validateGovernanceContext).toBe(context.validateGovernanceContext);
    expect(governance.renderCredentialPolicySchema).toBe(schema.renderCredentialPolicySchema);
    expect(governance.governanceInvocationGuide).toBe(guides.governanceInvocationGuide);
    expect(governance.renderGovernanceAssessmentGuide).toBe(guides.renderGovernanceAssessmentGuide);
    expect(governance.renderCanonicalGovernancePolicy).toBe(artifacts.renderCanonicalGovernancePolicy);
    expect(governance.renderGovernanceContext).toBe(artifacts.renderGovernanceContext);
    expect(governance.buildRepositoryGovernanceArtifacts).toBe(artifacts.buildRepositoryGovernanceArtifacts);
    expect(Object.keys(governanceCommands).sort()).toEqual(['governanceCommand', 'inspectGovernanceTransition']);
    expect(governanceCommands.governanceCommand).toBe(cli.governanceCommand);
    expect(governanceCommands.inspectGovernanceTransition).toBe(inspection.inspectGovernanceTransition);
    for (const facade of ['src/repository-governance.ts', 'src/governance-activation/commands.ts']) {
      const shape = await importsOf(facade);
      expect(shape.declarations, `${facade} must only re-export`).toEqual([]);
      expect(shape.imports, `${facade} must only re-export`).toEqual([]);
    }
  });

  it('reads the packaged governance policy only through its adapter and keeps renderers and CLI free of direct filesystem access', async () => {
    const readers: string[] = [];
    const scan = async (directory: string): Promise<void> => {
      for (const entry of await readdir(path.join(process.cwd(), directory), { withFileTypes: true })) {
        const relative = `${directory}/${entry.name}`;
        if (entry.isDirectory()) await scan(relative);
        else if (entry.name.endsWith('.ts') && /'single-maintainer-gitflow',\s*'policy\.md'/u.test(await readFile(path.join(process.cwd(), relative), 'utf8'))) {
          readers.push(relative);
        }
      }
    };
    await scan('src');
    expect(readers).toEqual(['src/adapters/packaged-assets/governance-policy.ts']);
    for (const file of [
      ...await sourceFiles('src/generators/governance'),
      'src/cli/commands/governance.ts', 'src/cli/commands/governance-output.ts',
      'src/domain/governance/policy/policy-contract.ts', 'src/domain/governance/policy/context.ts',
      'src/domain/governance/activation/credential-policy-schema.ts'
    ]) {
      const { imports } = await importsOf(file);
      expect(imports.filter((specifier) => /^node:fs(?:\/promises)?$/u.test(specifier)), file).toEqual([]);
    }
  });

  it('keeps application governance and update revalidation independent of CLI transport, transitively', async () => {
    for (const entry of [
      'src/application/governance/inspection.ts', 'src/application/governance/verification.ts',
      'src/application/update/revalidation.ts', 'src/application/update/revalidation-plan.ts'
    ]) {
      const closure = await runtimeClosure(entry);
      expect(closure.filter((file) => file.startsWith('src/cli/')), entry).toEqual([]);
      expect(closure, entry).not.toContain('src/governance-activation/commands.ts');
    }
  });
});
