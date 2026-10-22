export const applicationArtifactBuildToolObligations = Object.freeze([
  'authenticated-tool-source-and-execution-permission',
  'complete-runtime-library-plugin-and-configuration-closure',
  'same-host-docker-daemon-and-buildkit-container-readback',
  'whole-job-physical-currentness-and-protected-custody'
]);

// Embedded unchanged in the closed workflow; observation never executes candidate tools.
export const applicationArtifactBuildToolObservationProgram = String.raw`import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const deadline = Date.now() + 15_000;
const obligations = ${JSON.stringify(applicationArtifactBuildToolObligations)};
const files = [];
let readBytes = 0;
function refuse(code) {
  const error = new Error('Build-tool observation refused.');
  error.code = code;
  throw error;
}
function bounded() {
  if (Date.now() >= deadline) refuse('observation-deadline');
}
function identity(info) {
  return [info.dev, info.ino, info.mode, info.uid, info.gid, info.nlink, info.size,
    info.mtimeNs, info.ctimeNs].map(value => String(value));
}
function absent(file) {
  bounded();
  try { fs.lstatSync(file); return false; }
  catch (error) {
    if (error.code === 'ENOENT') return true;
    refuse('file-unobservable');
  }
}
function snapshot(selected, maximumBytes, executable, retain = false) {
  bounded();
  if (!path.isAbsolute(selected) || selected.includes('\0')) refuse('tool-path-unsafe');
  const resolved = fs.realpathSync(selected);
  if (!executable && resolved !== selected) refuse('tool-path-unsafe');
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size <= 0n ||
      before.size > BigInt(maximumBytes) || (before.mode & 0o022n) !== 0n ||
      executable && (before.mode & 0o111n) === 0n) refuse('tool-file-unsafe');
    const hash = createHash('sha256'), chunk = Buffer.alloc(32 * 1024), retained = [];
    let size = 0;
    for (;;) {
      bounded();
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      size += count;
      readBytes += count;
      if (size > maximumBytes || readBytes > 512 * 1024 * 1024) refuse('observation-byte-limit');
      hash.update(chunk.subarray(0, count));
      if (retain) retained.push(Buffer.from(chunk.subarray(0, count)));
    }
    chunk.fill(0);
    const after = fs.fstatSync(fd, { bigint: true });
    if (BigInt(size) !== before.size || JSON.stringify(identity(before)) !== JSON.stringify(identity(after)) ||
      fs.realpathSync(selected) !== resolved ||
      JSON.stringify(identity(fs.lstatSync(resolved, { bigint: true }))) !== JSON.stringify(identity(before))) {
      refuse('tool-file-changed');
    }
    return { selected, resolved, physical: identity(before), sha256: hash.digest('hex'),
      bytes: size, mode: Number(before.mode & 0o777n),
      ...(retain ? { content: Buffer.concat(retained) } : {}) };
  } finally { fs.closeSync(fd); }
}
function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function observed(role, selected) {
  const original = snapshot(selected, 128 * 1024 * 1024, true);
  files.push({ role, original });
}
function parsed(bytes) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) refuse('builder-declaration-invalid');
  let value;
  try { value = JSON.parse(text); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    refuse('builder-declaration-invalid');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse('builder-declaration-invalid');
  return value;
}
function observe() {
  if (process.platform !== 'linux') refuse('host-unsupported');
  if (['DOCKER_HOST', 'BUILDKIT_HOST', 'BUILDX_CONFIG', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY',
    'DOCKER_API_VERSION'].some(name => process.env[name]) ||
    process.env.DOCKER_CONTEXT && process.env.DOCKER_CONTEXT !== 'default') refuse('ambient-builder-override');
  const recipe = parsed(Buffer.from(process.env.LIFTOFF_DIGEST_RECIPE ?? 'null'));
  if (Object.keys(recipe).sort().join(',') !== 'builderName,buildkitVersion,buildxVersion,version' ||
    recipe.version !== 'oci-digest-v1' ||
    typeof recipe.builderName !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,62}$/u.test(recipe.builderName) ||
    [recipe.buildxVersion, recipe.buildkitVersion].some(value =>
      typeof value !== 'string' || !/^v[0-9]+\.[0-9]+\.[0-9]+$/u.test(value))) refuse('recipe-invalid');
  const config = process.env.DOCKER_CONFIG;
  if (!config || !path.isAbsolute(config) || fs.realpathSync(config) !== config) refuse('credential-scope-unavailable');
  const configInfo = fs.lstatSync(config);
  if (!configInfo.isDirectory() || (configInfo.mode & 0o077) !== 0 ||
    configInfo.uid !== process.getuid()) refuse('credential-scope-unavailable');
  const search = process.env.PATH;
  if (!search || search.length > 32_768) refuse('tool-path-unsafe');
  const directories = search.split(path.delimiter);
  if (directories.length > 128 || directories.some(directory => !path.isAbsolute(directory))) refuse('tool-path-unsafe');
  observed('node', process.execPath);
  for (const [role, name] of [['git', 'git'], ['azure-launcher', 'az'], ['docker-client', 'docker']]) {
    const selected = directories.map(directory => path.join(directory, name)).find(file => !absent(file));
    if (!selected) refuse('client-file-unavailable');
    observed(role, selected);
  }
  const candidates = [
    path.join(config, 'cli-plugins', 'docker-buildx'),
    '/usr/local/lib/docker/cli-plugins/docker-buildx',
    '/usr/local/libexec/docker/cli-plugins/docker-buildx',
    '/usr/lib/docker/cli-plugins/docker-buildx',
    '/usr/libexec/docker/cli-plugins/docker-buildx'
  ];
  let plugins = 0;
  for (const candidate of candidates) {
    if (absent(candidate)) continue;
    observed('buildx-candidate', candidate);
    plugins++;
  }
  if (!plugins) refuse('plugin-file-unavailable');
  const selected = path.join(config, 'buildx', 'instances', recipe.builderName);
  const captured = snapshot(selected, 64 * 1024, false, true);
  const { content: bytes, ...original } = captured;
  let declaration;
  try {
    declaration = parsed(bytes);
  } finally { bytes.fill(0); }
  if (declaration.Name !== recipe.builderName || declaration.Driver !== 'docker-container' ||
    declaration.Dynamic !== false || !Array.isArray(declaration.Nodes) || declaration.Nodes.length !== 1 ||
    !declaration.Nodes[0] || typeof declaration.Nodes[0].Name !== 'string' ||
    !/^[a-z0-9][a-z0-9_-]{0,62}$/u.test(declaration.Nodes[0].Name) ||
    declaration.Nodes[0].Endpoint !== 'default') refuse('builder-declaration-mismatch');
  files.push({ role: 'builder-declaration', original });
  for (const entry of files) {
    const current = snapshot(entry.original.selected,
      entry.role === 'builder-declaration' ? 64 * 1024 : 128 * 1024 * 1024,
      entry.role !== 'builder-declaration');
    if (JSON.stringify(current) !== JSON.stringify(entry.original)) refuse('tool-file-changed');
  }
  bounded();
  return { status: 'observed', code: 'complete-closure-unavailable', builder: {
    name: declaration.Name, node: declaration.Nodes[0].Name, driver: declaration.Driver,
    endpoint: declaration.Nodes[0].Endpoint, scope: 'local-declaration-only',
    declarationDigest: original.sha256, runningVersion: 'not-observed'
  } };
}
let result;
try { result = observe(); }
catch (error) {
  const codes = ['host-unsupported', 'observation-deadline', 'file-unobservable', 'tool-path-unsafe',
    'tool-file-unsafe', 'observation-byte-limit', 'tool-file-changed', 'builder-declaration-invalid',
    'ambient-builder-override', 'recipe-invalid', 'credential-scope-unavailable', 'client-file-unavailable',
    'plugin-file-unavailable', 'builder-declaration-changed', 'builder-declaration-mismatch'];
  result = { status: 'blocked', code: codes.includes(error.code) ? error.code : 'file-unobservable' };
}
console.log(JSON.stringify({ schemaVersion: 1, kind: 'application-build-tool-observation.v1',
  ...result, qualification: 'not-issued', scope: 'physical-files-and-local-builder-declaration',
  pluginSelection: 'not-established', obligations,
  files: files.map(({ role, original }) => ({ role, sha256: original.sha256, bytes: original.bytes,
    mode: original.mode, physicalDigest: digest(original) }))
}));`;
