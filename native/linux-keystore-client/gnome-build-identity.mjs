import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BuildFailure, runBuildCommand } from './build-tools.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(path.join(directory, 'gnome-dependencies.json'), 'utf8'));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (code) => { throw new BuildFailure(code); };
const run = (command, args, environment = process.env) =>
  runBuildCommand(command, args, { label: path.basename(command).replaceAll('.', '-'), environment });

try {
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) fail('native-linux-required');
  for (const name of ['GNOME_SOURCE_DIR', 'GNOME_BUILD_DIR', 'GNOME_PREFIX'])
    if (!process.env[name]) fail('explicit-gnome-build-paths-required');
  const source = await realpath(process.env.GNOME_SOURCE_DIR);
  const build = await realpath(process.env.GNOME_BUILD_DIR);
  const prefix = await realpath(process.env.GNOME_PREFIX);
  if (run('git', ['-C', source, 'rev-parse', 'HEAD']) !== manifest.sourceCommit ||
      run('git', ['-C', source, 'status', '--porcelain', '--untracked-files=no'])) fail('gnome-source-mismatch');
  const options = JSON.parse(run('meson', ['introspect', '--buildoptions', build]));
  for (const [name, expected] of Object.entries(manifest.mesonOptions))
    if (options.find((option) => option.name === name)?.value !== expected) fail('gnome-build-options-mismatch');
  const privatePrefixOptions = {};
  for (const [name, relative] of Object.entries(manifest.privatePrefixOptions)) {
    const expected = path.join(prefix, relative);
    if (options.find((option) => option.name === name)?.value !== expected) fail('gnome-private-pkcs11-path-required');
    privatePrefixOptions[name] = expected;
  }
  if (await realpath(options.find((option) => option.name === 'prefix')?.value ?? '') !== prefix)
    fail('gnome-prefix-mismatch');
  run('pkg-config', [`--atleast-version=${manifest.minimumGlib}`, 'glib-2.0']);
  const executable = await realpath(path.join(prefix, 'bin', 'gnome-keyring-daemon'));
  if (!executable.startsWith(`${prefix}${path.sep}`)) fail('system-daemon-fallback-forbidden');
  const executableDigest = digest(await readFile(executable));
  if (executableDigest !== digest(await readFile(path.join(build, 'daemon', 'gnome-keyring-daemon'))))
    fail('gnome-built-target-copy-mismatch');
  const dependencies = {};
  for (const [module, filename] of Object.entries(manifest.primaryLibraries)) {
    const libdir = run('pkg-config', ['--variable=libdir', module]);
    const library = await realpath(path.join(libdir, filename));
    dependencies[module] = {
      library, sha256: digest(await readFile(library)),
      version: run('pkg-config', ['--modversion', module]), stem: filename
    };
  }
  const tools = {};
  for (const [name, filename] of Object.entries(manifest.runtimeTools)) {
    const selected = await realpath(filename);
    tools[name] = { path: selected, sha256: digest(await readFile(selected)) };
  }
  const libraryDirectories = [...new Set(Object.values(dependencies).map((entry) => path.dirname(entry.library)))];
  if (libraryDirectories.some((entry) => !/^\/[A-Za-z0-9_./-]+$/u.test(entry))) fail('unsupported-library-path');
  const output = path.join(directory, 'build');
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'gnome-build-identity.json'), JSON.stringify({
    schemaVersion: 1, kind: manifest.kind, platform: process.platform, architecture: process.arch,
    sourceCommit: manifest.sourceCommit,
    executable: { path: executable, sha256: executableDigest },
    dependencies, tools, libraryPath: libraryDirectories.join(':'),
    mesonOptions: manifest.mesonOptions, privatePrefixOptions,
    fixtureManifestSha256: digest(await readFile(path.join(directory, 'gnome-dependencies.json'))),
    qualification: manifest.qualification
  }, null, 2) + '\n');
  console.info('gnome-build-identity:recorded-without-daemon-execution');
} catch (error) {
  console.error(error instanceof BuildFailure ? error.message : 'gnome-build-identity:failed');
  process.exitCode = 1;
}
