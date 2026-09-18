#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  assertOwnedOutput, cleanBuildEnvironment, copyInventoriedFile, createOwnedOutput, demand,
  fileIdentity, findExternalExecutable, inventoryTree, makeReadOnly, regularRoot, writeJson, writeNew
} from './native-build-files.mjs';
import { preparePrivateRuntime, verifyRuntimeArchive } from './node-runtime.mjs';
import { nativeEntrypoints, nativePlanSmokeCases, smokeNativeBundle } from './assemble-native-bundle.mjs';
import { canonicalJson, inspectArchiveDocumentation, inspectFile, sha256, verifyPackagedDocumentation } from '../release-evidence.mjs';
import { DocumentationClosureError, OPERATOR_DOCUMENTS } from './native-document-links.mjs';

function writableOwnedTree(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    const stat = fs.lstatSync(full);
    demand(!stat.isSymbolicLink(), 'Owned proof cleanup encountered a link; retain this directory for inspection');
    if (stat.isDirectory()) { fs.chmodSync(full, 0o700); writableOwnedTree(full); }
    else fs.chmodSync(full, stat.mode & 0o111 ? 0o700 : 0o600);
  }
}

async function failedCommand(executable, args, cwd, env) {
  const { NodeCommandRunner } = await import(new URL('../../dist/process-runner.js', import.meta.url).href);
  const result = await new NodeCommandRunner().run({ executable, args }, { cwd, env, timeoutMs: 30_000,
    maxOutputBytes: 1024 * 1024, ensureProcessTreeSettled: true });
  demand(result.status !== 0 && result.status !== null && result.signal === null && result.timedOut === false && result.processTreeSettled === true,
    'Expected broken-bundle failure did not settle safely');
  return { exitCode: result.status, stderrSha256: sha256(result.stderr) };
}

export async function verifyDevelopmentBundle({ projectRoot = process.cwd(), buildStatus, nodeArchive, outsideParent }) {
  projectRoot = regularRoot(projectRoot);
  const statusPath = path.resolve(projectRoot, buildStatus);
  demand(path.relative(projectRoot, statusPath).startsWith(`build${path.sep}`), 'Select the exact task-built status under project build/');
  fileIdentity(statusPath, 16 * 1024 * 1024);
  const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  demand(status.state === 'assembled-unqualified' && status.mode === 'development' && status.productionQualified === false &&
    status.source?.kind === 'unqualified-working-tree' && status.source.releaseCommit === null, 'Only an explicit unqualified development build may use this source-closure verifier');
  demand(status.target === `${process.platform}-${process.arch}`, 'This verification cannot claim another native host/architecture');
  const outputRoot = regularRoot(path.dirname(statusPath));
  const marker = JSON.parse(fs.readFileSync(path.join(outputRoot, '.liftoff-native-build-owner.json'), 'utf8'));
  const originalOutput = { root: outputRoot, owner: marker };
  assertOwnedOutput(originalOutput);
  const bundle = regularRoot(status.bundleDirectory);
  demand(path.dirname(bundle) === outputRoot, 'Build status cannot redirect probes into another installation');
  const files = JSON.parse(fs.readFileSync(path.join(outputRoot, 'payload-inventory.json'), 'utf8'));
  demand(canonicalJson(inventoryTree(bundle)) === canonicalJson(files), 'Actual development payload differs from its complete build inventory');
  demand(path.dirname(status.archivePath) === outputRoot, 'Development archive must remain in its exact owned build output');
  const archiveFile = inspectFile(projectRoot, path.relative(projectRoot, status.archivePath).split(path.sep).join('/'), status.archive.sha256);
  const archiveDocumentation = inspectArchiveDocumentation(archiveFile,
    status.target.startsWith('win32-') ? 'zip' : 'tar.gz', path.basename(bundle), projectRoot);
  const dependencies = JSON.parse(fs.readFileSync(path.join(bundle, 'runtime-dependencies.json'), 'utf8')).packages;
  const notices = JSON.parse(fs.readFileSync(path.join(bundle, 'THIRD_PARTY_NOTICES.json'), 'utf8'));
  demand(notices.schemaVersion === 1 && notices.dependencies.length === dependencies.length &&
    dependencies.every((dependency) => notices.dependencies.some((entry) => entry.name === dependency.name && entry.version === dependency.version && entry.files.length > 0)),
  'Runtime dependency license notice inventory is incomplete');
  for (const license of [notices.nodeLicense, ...notices.dependencies.flatMap((entry) => entry.files)]) {
    const file = files.find((entry) => entry.path === license.path);
    demand(file && file.sha256 === license.sha256 && file.size === license.size, 'Runtime license notice does not bind the actual packaged license bytes');
  }
  const archive = nodeArchive === undefined ? undefined : path.resolve(projectRoot, nodeArchive);
  if (archive) verifyRuntimeArchive(archive, status.target);
  const parent = regularRoot(outsideParent);
  const relative = path.relative(projectRoot, parent);
  demand(relative.startsWith('..') && parent !== path.parse(parent).root && parent !== os.homedir(),
    'Relocation proof needs an explicit safe parent outside the checkout, never the filesystem/home root');
  const proof = createOwnedOutput(parent, `.liftoff-native-closure-${randomUUID()}`);
  const work = path.join(proof.root, 'verification');
  const expectedRuntime = path.join(work, 'runtime');
  fs.mkdirSync(expectedRuntime, { recursive: true, mode: 0o700 });
  const env = cleanBuildEnvironment(work);
  const python = findExternalExecutable(process.platform === 'win32' ? 'python' : 'python3', projectRoot);
  try {
    const verifiedRuntime = await preparePrivateRuntime({ target: status.target, runtimeDirectory: expectedRuntime,
      workDirectory: work, archivePath: archive, python, env });
    const runtimeRelative = nativeEntrypoints(status.target).runtime;
    demand(fileIdentity(path.join(bundle, runtimeRelative)).sha256 === verifiedRuntime.executable.sha256,
      'Development payload runtime is not the independently verified official pinned binary');
    const relocated = path.join(proof.root, process.platform === 'win32'
      ? "relocated bundle 'single' $literal (round)"
      : "relocated bundle 'single' \"double\" $literal (round) ; semicolon");
    fs.mkdirSync(relocated, { mode: 0o700 });
    for (const file of files) copyInventoriedFile(bundle, relocated, file);
    makeReadOnly(relocated);
    const before = inventoryTree(relocated);
    const probes = await smokeNativeBundle(relocated, status.target, work, env, verifiedRuntime.executable.sha256);
    demand(canonicalJson(inventoryTree(relocated)) === canonicalJson(before), 'Relocated CLI changed read-only payload bytes or modes');
    const launcher = path.join(relocated, nativeEntrypoints(status.target).launcher);
    const markerPath = path.join(work, 'unexpected-shell-evaluation');
    const literal = `literal-$(printf unexpected > "${markerPath}")-'quoted'-"double"-;&`;
    const probeEnv = { ...env, PATH: path.join(work, 'empty-path'), NODE_OPTIONS: '--require=untrusted-preload-must-not-run' };
    const literalResult = await failedCommand(launcher, [literal], work, probeEnv);
    demand(!fs.existsSync(markerPath), 'Launcher evaluated a literal CLI argument as shell code');
    const negative = { literalArguments: literalResult };
    for (const [id, relativePath, args] of [
      ['missing-runtime', runtimeRelative, ['--version']],
      ['missing-dependency', 'node_modules/yaml', ['skills', 'list', '--json']],
      ['missing-asset', 'assets/skills/catalog.json', ['skills', 'list', '--json']],
      ['missing-template-catalog', 'assets/templates/catalog.json', nativePlanSmokeCases[0]],
      ['missing-profile-catalog', 'assets/profiles/catalog.json', nativePlanSmokeCases[0]]
    ]) {
      const original = path.join(relocated, relativePath);
      const containing = path.dirname(original);
      const backup = path.join(work, `${id}-retained`);
      const originalMode = fs.lstatSync(original).mode & 0o777;
      const parentMode = fs.lstatSync(containing).mode & 0o777;
      const directory = fs.lstatSync(original).isDirectory();
      fs.chmodSync(containing, 0o755);
      if (directory) fs.chmodSync(original, 0o755);
      let moved = false;
      try {
        fs.renameSync(original, backup);
        moved = true;
        negative[id] = await failedCommand(launcher, args, work, probeEnv);
      } finally {
        if (moved) fs.renameSync(backup, original);
        if (directory) fs.chmodSync(original, originalMode);
        fs.chmodSync(containing, parentMode);
      }
    }
    for (const relativePath of ['CONTRIBUTING.md', 'SECURITY.md', ...OPERATOR_DOCUMENTS]) {
      const original = path.join(relocated, relativePath);
      const containing = path.dirname(original);
      const parentMode = fs.lstatSync(containing).mode & 0o777;
      const backup = path.join(work, `missing-document-${randomUUID()}`);
      fs.chmodSync(containing, 0o755);
      let moved = false;
      try {
        fs.renameSync(original, backup);
        moved = true;
        let rejected = false;
        try { verifyPackagedDocumentation(relocated, inventoryTree(relocated)); }
        catch (error) {
          if (!(error instanceof DocumentationClosureError) || error.code !== 'missing-document' || error.target !== relativePath) throw error;
          negative[`missing-document:${relativePath}`] = { reasonCode: error.code, target: error.target };
          rejected = true;
        }
        demand(rejected, `Missing linked packaged document did not fail closure: ${relativePath}`);
      } finally {
        if (moved) fs.renameSync(backup, original);
        fs.chmodSync(containing, parentMode);
      }
    }
    const privateRuntime = path.join(relocated, runtimeRelative);
    const originalByte = Buffer.alloc(1);
    fs.chmodSync(privateRuntime, 0o755);
    const file = fs.openSync(privateRuntime, 'r+');
    try {
      fs.readSync(file, originalByte, 0, 1, 0);
      fs.writeSync(file, Buffer.from([originalByte[0] ^ 255]), 0, 1, 0);
      demand(fileIdentity(privateRuntime).sha256 !== verifiedRuntime.executable.sha256, 'Corrupt runtime bytes were not detected before execution');
      negative['corrupt-runtime-not-executed'] = { rejectedBeforeExecution: true };
    } finally {
      fs.writeSync(file, originalByte, 0, 1, 0);
      fs.closeSync(file);
      fs.chmodSync(privateRuntime, 0o555);
    }
    demand(canonicalJson(inventoryTree(relocated)) === canonicalJson(before), 'Proof fixture restoration did not preserve the exact owned payload');
    assertOwnedOutput(originalOutput);
    const result = {
      schemaVersion: 1, status: 'DEVELOPMENT_RUNTIME_CLOSURE_OBSERVED', sourceTreeSha256: status.source.treeSha256,
      version: status.version, target: status.target, runtime: verifiedRuntime,
      outsideCheckout: true, relocatedPathContainedQuotesAndMetacharacters: true,
      pathContainedNoNodeOrNpm: true, readOnlyPayloadPreserved: true,
      probes, negative, archiveDocumentation, productionQualified: false
    };
    const reportPath = path.join(outputRoot, `development-closure-proof-${randomUUID()}.json`);
    writeJson(reportPath, result);
    assertOwnedOutput(proof);
    writableOwnedTree(proof.root);
    fs.rmSync(proof.root, { recursive: true, force: false });
    return { ...result, reportPath };
  } catch (error) {
    throw new Error(`Native closure proof failed; owned external fixture retained at ${proof.root}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    demand(args.length === 4 || args.length === 6, 'Usage: verify-native-build.mjs --build-status PATH --outside-parent ABSOLUTE-PATH [--node-archive PATH]');
    const flags = {};
    for (let index = 0; index < args.length; index += 2) {
      demand(['--build-status', '--node-archive', '--outside-parent'].includes(args[index]) && !Object.hasOwn(flags, args[index]), 'Unknown or duplicate native proof argument');
      flags[args[index]] = args[index + 1];
    }
    demand(flags['--build-status'] && flags['--outside-parent'], 'Exact build status and outside-checkout parent are required');
    const result = await verifyDevelopmentBundle({ buildStatus: flags['--build-status'], nodeArchive: flags['--node-archive'], outsideParent: flags['--outside-parent'] });
    process.stdout.write(`${result.status}\nSource tree: ${result.sourceTreeSha256}\nPrivate runtime: Node ${result.runtime.version} ${result.target}\nProof: ${result.reportPath}\nProduction/native release qualification remains blocked.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
