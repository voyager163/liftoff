#!/usr/bin/env node
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function testRuntimeEnvironment(repository, env = process.env, nativeTemp = tmpdir()) {
  const source = await realpath(repository);
  const proposed = env.LIFTOFF_TEST_TEMP_PARENT ?? env.RUNNER_TEMP ?? nativeTemp;
  if (!path.isAbsolute(proposed)) throw new Error('Tests require an absolute temporary directory outside the source checkout.');
  const root = await realpath(proposed), status = await lstat(root), relative = path.relative(source, root);
  if (!status.isDirectory() || !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    throw new Error('Tests require a temporary directory outside the source checkout; set LIFTOFF_TEST_TEMP_PARENT explicitly.');
  }
  return { ...env, TMPDIR: root, TMP: root, TEMP: root };
}

export async function runTests(args, env = process.env) {
  const repository = fileURLToPath(new URL('..', import.meta.url));
  const runtime = await prepareTestRuntime(repository, env);
  const environment = runtime.environment;
  const child = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)), 'run', ...args], {
    cwd: repository, env: environment, stdio: 'inherit', shell: false
  });
  const stop = signal => { child.kill(signal); };
  const interrupt = () => stop('SIGINT'), terminate = () => stop('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', () => reject(new Error('Unable to start the test runner.')));
      child.once('close', (code, signal) => resolve(signal ? 1 : code ?? 1));
    });
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
    await runtime.cleanup();
  }
}

export async function prepareTestRuntime(repository, env = process.env, nativeTemp = tmpdir()) {
  const environment = await testRuntimeEnvironment(repository, env, nativeTemp);
  const socketName = `liftoff-job-${'0'.repeat(36)}.sock`;
  if (process.platform !== 'darwin' || env.LIFTOFF_TEST_TEMP_PARENT || env.RUNNER_TEMP ||
      Buffer.byteLength(path.join(environment.TMPDIR, socketName)) < 104) {
    return { environment, ownedRoot: null, cleanup: async () => {} };
  }
  const root = await mkdtemp(path.join(await realpath('/tmp'), 'liftoff-tests-'));
  const identity = await lstat(root);
  if (!identity.isDirectory() || identity.isSymbolicLink() || identity.mode & 0o077) {
    throw new Error('Unable to create a private short test runtime directory.');
  }
  return {
    environment: await testRuntimeEnvironment(repository, env, root),
    ownedRoot: root,
    cleanup: async () => {
      const current = await lstat(root);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) {
        throw new Error('Owned test runtime identity changed; cleanup refused.');
      }
      await rm(root, { recursive: true });
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = await runTests(process.argv.slice(2)); }
  catch { console.error('Test runner setup failed: verify dependencies and an external LIFTOFF_TEST_TEMP_PARENT.'); process.exitCode = 1; }
}
