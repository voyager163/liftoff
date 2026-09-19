import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BuildFailure, runBuildCommand } from './build-tools.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(path.join(directory, 'dependencies.json'), 'utf8'));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const run = (command, args, environment = process.env, label = command) =>
  runBuildCommand(command, args, { environment, label });
const fail = (code) => { throw new BuildFailure(code); };

try {
  const compiler = process.env.CC ?? 'cc';
  const compilerVersion = run(compiler, ['--version'], process.env, 'compiler').split('\n')[0];
  run('pkg-config', ['--version']);
  run('git', ['--version']);
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) fail('native-linux-build-required');
  if (!process.env.LIBSECRET_SOURCE_DIR || !process.env.LIBSECRET_PREFIX) fail('explicit-pinned-source-and-prefix-required');
  const source = await realpath(process.env.LIBSECRET_SOURCE_DIR);
  const prefix = await realpath(process.env.LIBSECRET_PREFIX);
  if (run('git', ['-C', source, 'rev-parse', 'HEAD']) !== manifest.libsecret.commit ||
      run('git', ['-C', source, 'status', '--porcelain', '--untracked-files=no'])) fail('libsecret-source-identity-mismatch');
  const pcDirectories = [path.join(prefix, 'lib', 'pkgconfig'), path.join(prefix, 'lib64', 'pkgconfig')];
  const environment = { ...process.env, PKG_CONFIG_PATH: pcDirectories.join(path.delimiter) };
  const modules = manifest.pkgConfig.modules;
  for (const module of modules) {
    try { run('pkg-config', ['--exists', module], environment); }
    catch (error) {
      if (error.message === 'build-command-failed:pkg-config') fail(`missing-build-dependency:${module}`);
      throw error;
    }
  }
  if (await realpath(run('pkg-config', ['--variable=prefix', 'libsecret-1'], environment)) !== prefix)
    fail('libsecret-system-fallback-forbidden');
  run('pkg-config', [`--atleast-version=${manifest.pkgConfig.minimumGlib}`, 'glib-2.0'], environment);
  // Restrict build prefixes to unambiguous flag paths; never shell-evaluate pkg-config output.
  if (!/^\/[A-Za-z0-9_./-]+$/u.test(prefix)) fail('unsupported-build-prefix');
  const flags = run('pkg-config', ['--cflags', '--libs', ...modules], environment).split(/\s+/u);
  if (flags.some((flag) => /["'\\]/u.test(flag))) fail('unsupported-build-flags');
  const output = path.join(directory, 'build');
  await mkdir(output, { recursive: true });
  const binary = path.join(output, 'liftoff-linux-keystore-client');
  const sources = manifest.sources.filter((name) => name.endsWith('.c')).map((name) => path.join(directory, name));
  runBuildCommand(compiler, [...manifest.cflags, ...sources, '-o', binary, ...flags, '-pthread', '-Wl,-z,relro,-z,now'],
    { label: 'compiler', diagnostics: true });
  const dependencies = {};
  for (const module of modules) {
    const libdir = run('pkg-config', ['--variable=libdir', module], environment);
    const libraryName = module === 'libsecret-1' ? 'libsecret-1.so' : `lib${module}.so`;
    const library = await realpath(path.join(libdir, libraryName));
    dependencies[module] = {
      version: run('pkg-config', ['--modversion', module], environment),
      library, sha256: digest(await readFile(library))
    };
  }
  const sourceDigests = {};
  for (const name of [...manifest.sources, 'dependencies.json', 'build.mjs', 'build-tools.mjs'])
    sourceDigests[name] = digest(await readFile(path.join(directory, name)));
  const probeDirectories = [...new Set(Object.values(dependencies).map((entry) => path.dirname(entry.library)))];
  if (probeDirectories.some((entry) => !/^\/[A-Za-z0-9_./-]+$/u.test(entry))) fail('unsupported-probe-library-path');
  await writeFile(path.join(output, 'build-identity.json'), JSON.stringify({
    schemaVersion: 1, platform: process.platform, architecture: process.arch,
    libsecretCommit: manifest.libsecret.commit, compiler: compilerVersion,
    binarySha256: digest(await readFile(binary)), sources: sourceDigests, dependencies,
    contractProbeLibraryPath: probeDirectories.join(':'),
    qualification: 'compile-only-not-provider-or-runtime-admission'
  }, null, 2) + '\n');
  console.info('compile-only:success (helper was not executed)');
} catch (error) {
  const code = error instanceof BuildFailure ? error.message
    : error?.code === 'ENOENT' ? 'missing-build-dependency:source-prefix-or-library' : 'compile-only:failed';
  console.error(code);
  if (error instanceof BuildFailure && error.diagnostics) console.error(error.diagnostics);
  process.exitCode = 1;
}
