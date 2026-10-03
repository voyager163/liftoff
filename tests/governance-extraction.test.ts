import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';
import * as governance from '../src/repository-governance.js';
import * as governanceCommands from '../src/governance-activation/commands.js';
import {
  acceptedPreExtractionSources, acceptedSourceInventory, cliSnapshot, harnessFile, renderingSnapshot, sha256,
  sourceTreeInventory, type Snapshot
} from './fixtures/governance-extraction/harness.js';
import { expectReviewedRendering } from './fixtures/reviewed-rendering.js';

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
    const current = await cliSnapshot();
    expect(current.previewCreated).toBe(recorded.cli.previewCreated);
    const recordedResults = recorded.cli.results as Record<string, unknown>;
    const currentResults = current.results as Record<string, unknown>;
    expect(Object.keys(currentResults)).toEqual(Object.keys(recordedResults));
    for (const key of Object.keys(recordedResults)) expect(currentResults[key], key).toEqual(recordedResults[key]);
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
