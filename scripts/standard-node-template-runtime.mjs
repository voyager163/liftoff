import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import spawn from 'cross-spawn';

export function resolveTemplateRuntime(env = process.env) {
  const selectedNode = env.LIFTOFF_TEMPLATE_PROJECT_NODE;
  const selectedNpm = env.LIFTOFF_TEMPLATE_PROJECT_NPM;
  if ((selectedNode === undefined) !== (selectedNpm === undefined)) {
    throw new Error('Select both the generated-project Node executable and npm CLI, or neither.');
  }
  const nodePath = selectedNode ?? process.execPath;
  const npmCliPath = selectedNpm ?? env.npm_execpath;
  for (const [name, value] of [['Node executable', nodePath], ['npm CLI', npmCliPath]]) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || /[\r\n]/u.test(value)) {
      throw new Error(`An absolute, single-line ${name} path is required.`);
    }
  }
  return { nodePath, npmCliPath };
}

export function templateRuntimeEnvironment(runtime, env = process.env) {
  const pathKey = process.platform === 'win32'
    ? Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'Path'
    : 'PATH';
  return {
    ...env,
    [pathKey]: [path.dirname(runtime.nodePath), env[pathKey] ?? ''].join(path.delimiter),
    npm_node_execpath: runtime.nodePath,
    npm_execpath: runtime.npmCliPath
  };
}

async function captureTemplateRuntime() {
  const output = process.env.GITHUB_ENV;
  if (!output || !path.isAbsolute(output)) throw new Error('An absolute GITHUB_ENV path is required.');
  if (process.versions.node !== process.env.EXPECTED_PROJECT_NODE) {
    throw new Error('The selected generated-project Node version does not match its CI lane.');
  }
  const result = spawn.sync('npm', ['root', '--global'], { encoding: 'utf8', shell: false, timeout: 30_000 });
  if (result.error || result.status !== 0 || result.signal !== null) {
    throw new Error('Unable to locate the selected generated-project npm distribution.');
  }
  const root = result.stdout.trim();
  if (!path.isAbsolute(root)) throw new Error('The selected npm root is not absolute.');
  const manifest = JSON.parse(await readFile(path.join(root, 'npm', 'package.json'), 'utf8'));
  if (manifest.version !== process.env.EXPECTED_PROJECT_NPM) {
    throw new Error('The installed generated-project npm distribution does not match its CI lane.');
  }
  const runtime = resolveTemplateRuntime({
    LIFTOFF_TEMPLATE_PROJECT_NODE: process.execPath,
    LIFTOFF_TEMPLATE_PROJECT_NPM: path.join(root, 'npm', 'bin', 'npm-cli.js')
  });
  await appendFile(output, [
    `LIFTOFF_TEMPLATE_PROJECT_NODE=${runtime.nodePath}`,
    `LIFTOFF_TEMPLATE_PROJECT_NPM=${runtime.npmCliPath}`,
    `LIFTOFF_TEMPLATE_EXPECTED_PROJECT_NODE=${process.versions.node}`,
    `LIFTOFF_TEMPLATE_EXPECTED_NPM=${manifest.version}`, ''
  ].join('\n'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--capture') {
    throw new Error('Use --capture to retain the selected CI project runtime before selecting the CLI generator runtime.');
  }
  await captureTemplateRuntime();
}
