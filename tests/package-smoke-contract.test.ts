import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import { builtinAssets } from '../src/plugins/builtin/assets.js';
import { CaptureStream, ReadyInitRunner } from './helpers.js';
import {
  assertUnpackedPackageSize,
  formatSmokeIssues,
  installedAssetByteIssues,
  installedPlanCases,
  installedRetainedAssetIssues,
  maximumUnpackedPackageBytes,
  packagedAssetIssues,
  planContractIssues,
  requiredAncillaryAssets,
  requiredPackagedAssets
} from '../scripts/package-smoke-contract.mjs';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')) as {
  files: string[];
};
const templatePaths = builtinAssets.map((asset) => asset.pathParts.join('/'));
const required = requiredPackagedAssets as readonly string[];
const nonAssetPaths = ['package.json', 'README.md', 'dist/cli.js', 'docs/getting-started.md'];
const eggInfoPaths = ['PKG-INFO', 'SOURCES.txt', 'dependency_links.txt', 'requires.txt', 'top_level.txt']
  .map((name) => `assets/locks/python-genai/liftoff_template_python_genai.egg-info/${name}`);
const helperPath = 'assets/repair/windows-job-controller.ps1';
const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function ownedRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `liftoff-smoke-contract-${prefix}-`));
  cleanups.push(root);
  return root;
}

type Issue = { readonly code: string; readonly path?: string; readonly subject?: string };
const codes = (issues: readonly Issue[]) => issues.map((issue) => [issue.code, issue.path ?? issue.subject]);
const issuesFor = (packedPaths: readonly string[], declaredFiles: readonly unknown[]) =>
  codes(packagedAssetIssues({ packedPaths, declaredFiles }));
const consistentPack = [...nonAssetPaths, ...required];

describe('unpacked package budget', () => {
  it('admits exactly 12 MiB and rejects the first excess byte', () => {
    expect(maximumUnpackedPackageBytes).toBe(12_582_912);
    for (const bytes of [0, 8_388_608, 12_582_911, 12_582_912]) {
      expect(() => assertUnpackedPackageSize(bytes)).not.toThrow();
    }
    expect(() => assertUnpackedPackageSize(12_582_913))
      .toThrow('Packed package unexpectedly exceeds the 12 MiB unpacked-size budget: 12582913');
  });

  it.each([undefined, null, '12582912', -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid measured size %s instead of bypassing the budget', (bytes) => {
      expect(() => assertUnpackedPackageSize(bytes)).toThrow(TypeError);
    }
  );
});

describe('required packaged assets', () => {
  it('requires exactly the thirteen template assets and fourteen core ancillary assets', () => {
    expect(required).toHaveLength(27);
    expect(new Set(required).size).toBe(27);
    expect(required).toEqual([...templatePaths, ...requiredAncillaryAssets].sort());
    expect(templatePaths.filter((entry) => requiredAncillaryAssets.includes(entry))).toEqual([]);
    const declaredAssets = packageJson.files.filter((entry) =>
      entry.replaceAll('\\', '/').replace(/^(?:!|\.\/|\/)+/, '').split('/')[0].normalize('NFKC').toLowerCase() === 'assets');
    expect(declaredAssets.filter((entry) => !templatePaths.includes(entry)).sort())
      .toEqual([...requiredAncillaryAssets].sort());
  });
});

describe('packed asset inventory', () => {
  it('accepts the real declarations when the pack holds exactly the required assets', () => {
    expect(issuesFor(consistentPack, packageJson.files)).toEqual([]);
  });

  it('reports the legacy directory entries and every file they packed', () => {
    const legacyFiles = ['dist', 'assets/locks', 'assets/governance', 'assets/repair', 'assets/supported-stack.json', ...templatePaths, 'docs'];
    expect(issuesFor([...consistentPack, ...eggInfoPaths], legacyFiles)).toEqual([
      ['directory-asset-entry', 'assets/governance'],
      ['directory-asset-entry', 'assets/locks'],
      ['directory-asset-entry', 'assets/repair'],
      ...[
        'assets/governance/modern/source-contracts.json',
        'assets/governance/single-maintainer-gitflow/activation-v2-graph.json',
        'assets/governance/single-maintainer-gitflow/activation-v3-graph.json',
        'assets/governance/single-maintainer-gitflow/assessment-controls.json',
        'assets/governance/single-maintainer-gitflow/policy-v7.md',
        'assets/governance/single-maintainer-gitflow/policy.md',
        'assets/governance/team-gitflow/assessment-controls.json',
        'assets/governance/team-gitflow/policy-v1.md',
        ...eggInfoPaths,
        helperPath,
        'assets/skills/assessment.md',
        'assets/skills/governance-assessment.md',
        'assets/skills/repair.md',
        'assets/skills/setup.md'
      ].map((entry) => ['undeclared-packaged-asset', entry])
    ]);
  });

  it('fails when a required asset is omitted from both the declaration and the pack', () => {
    for (const omitted of required) {
      expect(issuesFor(
        consistentPack.filter((entry) => entry !== omitted),
        packageJson.files.filter((entry) => entry !== omitted)
      ), omitted).toEqual([['required-asset-not-packed', omitted]]);
    }
  });

  it('decides between file, directory and missing entries from pack evidence only', () => {
    const [firstTemplate] = templatePaths;
    expect(issuesFor(consistentPack.filter((entry) => entry !== firstTemplate), packageJson.files))
      .toEqual([['declared-asset-not-packed', firstTemplate], ['required-asset-not-packed', firstTemplate]]);

    for (const extra of ['assets/plugins/unknown/data', eggInfoPaths[0]]) {
      expect(issuesFor([...consistentPack, extra], [...packageJson.files, extra]), extra)
        .toEqual([['unexpected-declared-asset', extra]]);
    }

    const goDirectory = 'assets/plugins/go-huma/go-backend';
    expect(issuesFor(consistentPack, [...packageJson.files.filter((entry) => !entry.startsWith(`${goDirectory}/`)), goDirectory]))
      .toEqual([
        ['directory-asset-entry', goDirectory],
        ['undeclared-packaged-asset', `${goDirectory}/go.mod`],
        ['undeclared-packaged-asset', `${goDirectory}/go.sum`]
      ]);

    // A file name is not evidence: this go.mod is packed as a directory.
    const module = `${goDirectory}/go.mod`;
    expect(issuesFor([...consistentPack.filter((entry) => entry !== module), `${module}/inner`], packageJson.files))
      .toEqual([
        ['directory-asset-entry', module],
        ['undeclared-packaged-asset', `${module}/inner`],
        ['required-asset-not-packed', module]
      ]);

    expect(issuesFor([...consistentPack, 'assets/plugins/unknown/data'], [...packageJson.files, 'assets']))
      .toEqual([['directory-asset-entry', 'assets'], ['undeclared-packaged-asset', 'assets/plugins/unknown/data']]);
  });

  it('rejects non-canonical, pattern and duplicate asset entries before using them as paths', () => {
    for (const entry of [
      'assets\\repair\\windows-job-controller.ps1', './assets/x', '/assets/x', 'assets/', 'assets//x',
      'assets/./x', 'assets/../x', 'assets/*/x', '!assets/x', '**/*.json', 'assets/caf\u00e9.json'
    ]) {
      expect(issuesFor(consistentPack, [...packageJson.files, entry]), entry).toEqual([['invalid-asset-entry', entry]]);
    }
    expect(issuesFor(consistentPack, [...packageJson.files, 42])).toEqual([['invalid-asset-entry', '<number>']]);
    expect(issuesFor(consistentPack, [...packageJson.files, null])).toEqual([['invalid-asset-entry', '<null>']]);

    const [firstTemplate] = templatePaths;
    expect(issuesFor(consistentPack, [...packageJson.files, firstTemplate]))
      .toEqual([['duplicate-asset-entry', firstTemplate]]);
    const caseAlias = 'assets/plugins/Azure/opentofu-azure/versions.tf';
    expect(issuesFor(consistentPack, [...packageJson.files, caseAlias])).toEqual([['duplicate-asset-entry', caseAlias]]);

    const decomposed = 'assets/plugins/unknown/cafe\u0301.json';
    const composed = 'assets/plugins/unknown/caf\u00e9.json';
    expect(issuesFor([...consistentPack, decomposed, composed], packageJson.files))
      .toEqual([['duplicate-packaged-asset', composed], ['undeclared-packaged-asset', decomposed]]);
    expect(issuesFor([...consistentPack, helperPath], packageJson.files))
      .toEqual([['duplicate-packaged-asset', helperPath]]);

    expect(() => packagedAssetIssues({ packedPaths: 'dist', declaredFiles: [] })).toThrow(TypeError);
    expect(() => packagedAssetIssues({ packedPaths: [1], declaredFiles: [] })).toThrow(TypeError);
  });

  it('rejects portable case aliases of the asset root in either list and in either order', () => {
    const [ancillary] = requiredAncillaryAssets;
    for (const alias of [ancillary.replace(/^assets/, 'ASSETS'), ancillary.replace(/^assets/, 'Assets')]) {
      for (const declared of [[...packageJson.files, alias], [alias, ...packageJson.files]]) {
        expect(issuesFor(consistentPack, declared), `declared ${alias}`).toEqual([['invalid-asset-entry', alias]]);
        for (const packed of [[...consistentPack, alias], [alias, ...consistentPack]]) {
          expect(issuesFor(packed, declared), `declared and packed ${alias}`)
            .toEqual([['invalid-asset-entry', alias], ['duplicate-packaged-asset', alias]]);
        }
      }
      for (const packed of [[...consistentPack, alias], [alias, ...consistentPack]]) {
        expect(issuesFor(packed, packageJson.files), `packed ${alias}`).toEqual([['duplicate-packaged-asset', alias]]);
      }
      expect(issuesFor(consistentPack.map((entry) => (entry === ancillary ? alias : entry)), packageJson.files), `replaced by ${alias}`)
        .toEqual([
          ['declared-asset-not-packed', ancillary],
          ['undeclared-packaged-asset', alias],
          ['required-asset-not-packed', ancillary]
        ]);
    }
    const unknown = 'ASSETS/plugins/unknown/data';
    expect(issuesFor(consistentPack, [...packageJson.files, unknown])).toEqual([['invalid-asset-entry', unknown]]);
    expect(issuesFor([...consistentPack, unknown], packageJson.files)).toEqual([['undeclared-packaged-asset', unknown]]);
    expect(issuesFor([...consistentPack, unknown], [...packageJson.files, unknown]))
      .toEqual([['invalid-asset-entry', unknown], ['undeclared-packaged-asset', unknown]]);
  });

  it('treats sparse or non-string packed paths as argument errors', () => {
    const sparsePack = [...consistentPack, , 'dist/extra.js'];
    expect(Object.hasOwn(sparsePack, consistentPack.length)).toBe(false);
    expect(() => packagedAssetIssues({ packedPaths: sparsePack, declaredFiles: packageJson.files })).toThrow(TypeError);
    expect(() => packagedAssetIssues({ packedPaths: [...consistentPack, undefined], declaredFiles: packageJson.files }))
      .toThrow(TypeError);
  });

  it('formats one line per issue', () => {
    expect(formatSmokeIssues('Packed asset inventory mismatch', packagedAssetIssues({
      packedPaths: consistentPack.filter((entry) => entry !== helperPath),
      declaredFiles: packageJson.files.filter((entry) => entry !== helperPath)
    }))).toBe(`Packed asset inventory mismatch:\n- [required-asset-not-packed] ${helperPath}: required asset is absent from the pack`);
  });
});

describe('installed package assets', () => {
  async function installedPair(): Promise<{ source: string; installed: string }> {
    const source = await ownedRoot('source');
    const installed = await ownedRoot('installed');
    for (const assetPath of required) {
      // The native helper stand-in is not valid UTF-8, so equality must never decode it.
      const bytes = assetPath === helperPath
        ? Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x0a])
        : Buffer.from(`fixture bytes for ${assetPath}\n`);
      for (const root of [source, installed]) {
        await mkdir(path.dirname(path.join(root, ...assetPath.split('/'))), { recursive: true });
        await writeFile(path.join(root, ...assetPath.split('/')), bytes);
      }
    }
    return { source, installed };
  }

  it('accepts byte-identical installed assets and reports altered or missing ones', async () => {
    const { source, installed } = await installedPair();
    expect(await installedAssetByteIssues({ installedRoot: installed, sourceRoot: source })).toEqual([]);

    const helper = path.join(installed, ...helperPath.split('/'));
    const bytes = await readFile(helper);
    bytes[1] ^= 0x01;
    await writeFile(helper, bytes);
    const [firstTemplate] = templatePaths;
    await rm(path.join(installed, ...firstTemplate.split('/')));
    expect(codes(await installedAssetByteIssues({ installedRoot: installed, sourceRoot: source }))).toEqual([
      ['missing-installed-asset', firstTemplate],
      ['installed-asset-bytes-differ', helperPath]
    ].sort((left, right) => (left[1] < right[1] ? -1 : 1)));
  });

  it('propagates unexpected read errors instead of reporting success or a missing asset', async () => {
    const { source, installed } = await installedPair();
    const [firstTemplate] = templatePaths;
    await rm(path.join(installed, ...firstTemplate.split('/')));
    await mkdir(path.join(installed, ...firstTemplate.split('/')));
    await expect(installedAssetByteIssues({ installedRoot: installed, sourceRoot: source }))
      .rejects.toMatchObject({ code: 'EISDIR' });

    const fresh = await installedPair();
    await rm(path.join(fresh.source, ...helperPath.split('/')));
    await expect(installedAssetByteIssues({ installedRoot: fresh.installed, sourceRoot: fresh.source }))
      .rejects.toMatchObject({ code: 'ENOENT' });

    await expect(installedAssetByteIssues({ installedRoot: 'relative', sourceRoot: source })).rejects.toThrow(TypeError);
  });

  it('follows package-manager links to identical bytes', async (context) => {
    const { source, installed } = await installedPair();
    const [firstTemplate] = templatePaths;
    const target = path.join(await ownedRoot('link-target'), 'asset');
    await writeFile(target, await readFile(path.join(source, ...firstTemplate.split('/'))));
    await rm(path.join(installed, ...firstTemplate.split('/')));
    try {
      await symlink(target, path.join(installed, ...firstTemplate.split('/')));
    } catch (error) {
      if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        context.skip();
      }
      throw error;
    }
    expect(await installedAssetByteIssues({ installedRoot: installed, sourceRoot: source })).toEqual([]);
  });

  it('reports an installed retained assets/locks root', async () => {
    const installed = await ownedRoot('retained');
    expect(await installedRetainedAssetIssues({ installedRoot: installed })).toEqual([]);
    await mkdir(path.join(installed, 'assets', 'locks'), { recursive: true });
    expect(codes(await installedRetainedAssetIssues({ installedRoot: installed })))
      .toEqual([['retained-asset-installed', 'assets/locks']]);
    await expect(installedRetainedAssetIssues({ installedRoot: 'relative' })).rejects.toThrow(TypeError);
  });
});

async function renderPlan(args: readonly string[]): Promise<string> {
  const cwd = await ownedRoot('plan');
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const code = await runCommand(parseArgs(['plan', ...args]), {
    cwd,
    stdout,
    stderr,
    runner: new ReadyInitRunner(),
    terminal: { layout: 'plain', color: false }
  });
  expect(code, stderr.text()).toBe(0);
  return stdout.text();
}

describe('installed plan contracts', () => {
  it('keeps the original Node plan invocation and runs the other stacks from a directory with spaces', () => {
    expect(installedPlanCases.map((planCase) => planCase.id))
      .toEqual(['node-api', 'node-api-frontend', 'python-api', 'go-api', 'genai-rag', 'manual-cli-only']);
    expect(installedPlanCases[0].directory).toBe('outside');
    expect(installedPlanCases[0].args).toEqual([
      '--no-genai', '--api', 'node', '--cloud', 'azure', '--region', 'eastus',
      '--spec', 'openspec', '--agents', 'copilot', '--no-frontend'
    ]);
    for (const planCase of installedPlanCases.slice(1)) expect(planCase.directory, planCase.id).toContain(' ');
    expect(Object.isFrozen(installedPlanCases[0].decisions)).toBe(true);
  });

  it('matches every case against the source plain-layout rendering', async () => {
    for (const planCase of installedPlanCases) {
      expect(planContractIssues(await renderPlan(planCase.args), planCase), planCase.id).toEqual([]);
    }
  });

  it('reports changed decisions, missing or moved rows, excluded rows and malformed output', async () => {
    const [nodeCase, nodeFrontendCase] = installedPlanCases;
    const nodeOutput = await renderPlan(nodeCase.args);
    const frontendOutput = await renderPlan(nodeFrontendCase.args);
    const count = Number(/^Artifacts \((\d+)\)$/m.exec(nodeOutput)![1]);
    const withCount = (output: string, value: number) => output.replace(/^Artifacts \(\d+\)$/m, `Artifacts (${value})`);
    const row = (name: string, output: string) => new RegExp(`^Artifact: ${name} \\|.*$`, 'm').exec(output)![0];
    const lockRow = row('node-backend-lock', nodeOutput);

    expect(codes(planContractIssues(nodeOutput.replace('API stack: Node.js / Fastify / TypeScript', 'API stack: Go / Huma / Chi'), nodeCase)))
      .toEqual([['plan-decision-mismatch', 'API stack']]);
    expect(codes(planContractIssues(withCount(nodeOutput.replace(`${lockRow}\n`, ''), count - 1), nodeCase)))
      .toEqual([['plan-artifact-missing', 'node-backend-lock']]);
    expect(codes(planContractIssues(nodeOutput.replace(lockRow, lockRow.replace('Path: backend/package-lock.json', 'Path: server/package-lock.json')), nodeCase)))
      .toEqual([['plan-artifact-path-mismatch', 'node-backend-lock']]);
    const frontendRow = row('frontend-lock', frontendOutput);
    expect(codes(planContractIssues(withCount(nodeOutput.replace(`${lockRow}\n`, `${lockRow}\n${frontendRow}\n`), count + 1), nodeCase)))
      .toEqual([['plan-excluded-artifact-present', 'frontend-lock']]);
    expect(codes(planContractIssues(withCount(nodeOutput.replace(`${lockRow}\n`, `${lockRow}\n${lockRow}\n`), count + 1), nodeCase)))
      .toEqual([['plan-output-malformed', 'Artifacts']]);
    expect(codes(planContractIssues(withCount(nodeOutput, count + 1), nodeCase)))
      .toEqual([['plan-output-malformed', 'Artifacts'], ['plan-output-malformed', 'Artifacts']]);
    expect(codes(planContractIssues(nodeOutput.replace(lockRow, lockRow.replace(' | Path: ', ' | Where: ')), nodeCase)))
      .toEqual([['plan-output-malformed', 'Artifacts'], ['plan-artifact-missing', 'node-backend-lock']]);
    expect(codes(planContractIssues(nodeOutput.replace('Workstation requirements', 'Requirements'), nodeCase)))
      .toEqual([['plan-output-malformed', 'Workstation requirements']]);
    expect(codes(planContractIssues(nodeOutput.replace('Cloud: Azure\n', 'Cloud: Azure\nCloud: Azure\n'), nodeCase)))
      .toEqual([['plan-output-malformed', 'Project decisions']]);

    expect(() => planContractIssues(undefined, nodeCase)).toThrow(TypeError);
    expect(() => planContractIssues(nodeOutput, {})).toThrow(TypeError);
  });

  it('bounds an artifact count beyond the output before iterating to it', async () => {
    const [nodeCase] = installedPlanCases;
    const nodeOutput = await renderPlan(nodeCase.args);
    const lineCount = nodeOutput.split(/\r?\n/).length;
    const count = Number(/^Artifacts \((\d+)\)$/m.exec(nodeOutput)![1]);
    // Finite and small enough to stay cheap in-process even if the bound regressed.
    for (const oversized of [lineCount, 10_000]) {
      expect(codes(planContractIssues(nodeOutput.replace(`Artifacts (${count})`, `Artifacts (${oversized})`), nodeCase)), String(oversized))
        .toEqual([['plan-output-malformed', 'Artifacts']]);
    }
    expect(() => planContractIssues(nodeOutput, { ...nodeCase, excludedPathPrefixes: ['frontend/', , 'docs/'] }))
      .toThrow(TypeError);
    expect(() => planContractIssues(nodeOutput, { ...nodeCase, decisions: { Cloud: 7 } })).toThrow(TypeError);
  });

  it('bounds huge and overflowing artifact counts in an isolated, time-limited child process', () => {
    // A regression of the bound would loop without end, so it runs outside the Vitest worker with a
    // small heap and a kill timeout; a failure is reported instead of freezing the worker.
    const contractUrl = pathToFileURL(path.join(repositoryRoot, 'scripts', 'package-smoke-contract.mjs')).href;
    const script = [
      `const contract = await import(${JSON.stringify(contractUrl)});`,
      'const [planCase] = contract.installedPlanCases;',
      "const decisions = Object.entries(planCase.decisions).map(([label, value]) => label + ': ' + value);",
      "const rows = Object.entries(planCase.artifacts).map(([name, file]) => 'Artifact: ' + name + ' | Lifecycle: project (base) | Path: ' + file);",
      "const heading = 'Artifacts (' + rows.length + ')';",
      "const output = ['Project decisions', ...decisions, '', heading, ...rows, '', 'Workstation requirements', ''].join('\\n');",
      'const codes = (issues) => issues.map((issue) => [issue.code, issue.subject]);',
      "const withCount = (digits) => codes(contract.planContractIssues(output.replace(heading, 'Artifacts (' + digits + ')'), planCase));",
      'process.stdout.write(JSON.stringify({',
      '  control: codes(contract.planContractIssues(output, planCase)),',
      "  hugeFinite: withCount('9'.repeat(15)),",
      '  unsafe: withCount(String(Number.MAX_SAFE_INTEGER + 1)),',
      "  overflow: withCount('9'.repeat(400))",
      '}));'
    ].join('\n');
    const result = spawnSync(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: process.env,
      timeout: 15_000,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024
    });
    expect(result.error?.message, result.stderr).toBeUndefined();
    expect(result.signal, result.stderr).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    const malformed = [['plan-output-malformed', 'Artifacts']];
    expect(JSON.parse(result.stdout)).toEqual({ control: [], hugeFinite: malformed, unsafe: malformed, overflow: malformed });
  });
});
