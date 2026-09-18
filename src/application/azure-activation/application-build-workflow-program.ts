import { createHash } from 'node:crypto';

/**
 * Dependency-free executable, embedded verbatim in the reviewed workflow, not fetched from a mutable URL.
 * Tests run these same bytes with isolated provider responses and real supervised fixture processes.
 *
 * Buildx's image exporter needs push-by-digest + name-canonical + oci-mediatypes; --push alone
 * may publish a tagged index. Both default provenance and SBOM attestations are disabled.
 * Flags are not proof: the actual descriptor, manifest/config bytes and platform are checked below.
 *
 * Docker/BuildKit's AuthConfig.RegistryToken supplies the already repository-scoped bearer token.
 * An ACR refresh token is never given to Docker, nor is a login action trusted with credential argv.
 */
export const applicationBuildWorkflowProgram = String.raw`import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, realpath, open, rm } from 'node:fs/promises';
import { resolve, join, relative, sep } from 'node:path';
import { spawn } from 'node:child_process';

let stage = 'prerequisites';
const require = condition => { if (!condition) throw new Error('Application build refused.'); };
const object = value => { require(value !== null && typeof value === 'object' && !Array.isArray(value)); return value; };
const exact = (value, keys) => { const data = object(value); require(Object.keys(data).sort().join(',') === [...keys].sort().join(',')); return data; };
const positive = value => { require(Number.isSafeInteger(value) && value > 0); return value; };
const text = (value, pattern) => { require(typeof value === 'string' && value.length <= 2048 && pattern.test(value)); return value; };
const sha = value => text(value, /^[a-f0-9]{40}$/);
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const imageDigest = value => text(value, /^sha256:[a-f0-9]{64}$/);
const uuid = value => { require(value !== '00000000-0000-0000-0000-000000000000'); return text(value, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/); };
const publicName = value => text(value, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/);
const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
// JSON.parse alone silently accepts duplicate object members, including credential scopes.
const json = bytes => {
  require(bytes.length > 0 && bytes.length <= 524288);
  const source = decode(bytes);
  const token = /"(?:\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})|[^"\\\u0000-\u001f])*"|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\]:,]/y;
  let position = 0, count = 0;
  const next = () => {
    while (position < source.length && /[ \r\n\t]/.test(source[position])) position++;
    token.lastIndex = position;
    const match = token.exec(source);
    require(match !== null && ++count <= 32768);
    position = token.lastIndex;
    return match[0];
  };
  const parse = (first, depth) => {
    require(depth < 64);
    if (first === '{') {
      const result = Object.create(null);
      let key = next();
      if (key === '}') return result;
      while (true) {
        require(key.startsWith('"'));
        key = JSON.parse(key);
        require(!Object.hasOwn(result, key) && next() === ':');
        result[key] = parse(next(), depth + 1);
        const delimiter = next();
        if (delimiter === '}') return result;
        require(delimiter === ',');
        key = next();
      }
    }
    if (first === '[') {
      const result = [];
      let value = next();
      if (value === ']') return result;
      while (true) {
        result.push(parse(value, depth + 1));
        const delimiter = next();
        if (delimiter === ']') return result;
        require(delimiter === ',' && result.length <= 4096);
        value = next();
      }
    }
    require(!['}', ']', ':', ','].includes(first));
    const result = JSON.parse(first);
    require(typeof result !== 'number' || Number.isFinite(result));
    return result;
  };
  const result = parse(next(), 0);
  require(source.slice(position).trim() === '');
  return result;
};
const secret = value => { require(typeof value === 'string' && value.length > 0 && value.length <= 65536 && !/[\s\u0000-\u001f\u007f]/.test(value)); return value; };
const protectedValues = [];
const protect = value => { const token = secret(value); protectedValues.push(Buffer.from(token)); return token; };
const claims = (token, minimumSeconds = 30) => {
  secret(token);
  const parts = token.split('.');
  require(parts.length === 3 && parts.every(part => /^[A-Za-z0-9_-]+$/.test(part)));
  const bytes = Buffer.from(parts[1], 'base64url');
  try {
    require(bytes.toString('base64url') === parts[1]);
    const value = object(json(bytes)), now = Date.now() / 1000;
    require(Number.isSafeInteger(value.exp) && value.exp > now + minimumSeconds && value.exp < now + 86400 &&
      (value.nbf === undefined || Number.isSafeInteger(value.nbf) && value.nbf <= now) &&
      (value.iat === undefined || Number.isSafeInteger(value.iat) && value.iat <= now + 60));
    return value;
  } finally { bytes.fill(0); }
};

let owned, ownedIdentity, builder, builderAttempted = false, childEnvironment;
let report, output, recipe, timer, deadline, failed = false;
const controller = new AbortController();
const stopped = () => controller.abort();
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, stopped);
const remaining = seconds => {
  require(!controller.signal.aborted);
  const ms = Math.min(seconds * 1000, deadline - Date.now());
  require(ms > 0);
  return ms;
};
const command = async (executable, args, options = {}) => {
  require(['git', 'docker'].includes(executable));
  const cleanup = options.cleanup === true;
  const timeout = cleanup ? recipe.limits.commandTimeoutSeconds * 1000 :
    remaining(options.seconds ?? recipe.limits.commandTimeoutSeconds);
  const result = await new Promise((done, reject) => {
    let child, clock, settled = false, invalid = false, size = 0;
    const chunks = [];
    const kill = () => {
      invalid = true;
      if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    };
    const finish = ok => {
      if (settled) return;
      settled = true;
      clearTimeout(clock);
      controller.signal.removeEventListener('abort', kill);
      if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
      if (ok && !invalid) done(Buffer.concat(chunks));
      else { for (const chunk of chunks) chunk.fill(0); reject(new Error('Bounded command failed.')); }
    };
    try {
      child = spawn(executable, args, {
        cwd: owned, env: { ...childEnvironment, ...options.env }, shell: false, detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      clock = setTimeout(kill, timeout);
      if (!cleanup) {
        controller.signal.addEventListener('abort', kill, { once: true });
        if (controller.signal.aborted) kill();
      }
      for (const [stream, retain] of [[child.stdout, true], [child.stderr, false]]) stream.on('data', chunk => {
        size += chunk.length;
        if (size > 131072) kill();
        else if (retain) chunks.push(Buffer.from(chunk));
        chunk.fill(0);
      });
      child.once('error', () => finish(false));
      child.once('close', code => finish(code === 0));
    } catch { kill(); finish(false); }
  });
  try { return decode(result); } finally { result.fill(0); }
};
const docker = (args, options) => command('docker', ['--host', 'unix:///var/run/docker.sock', ...args], options);
const boundedFile = async (path, maximum) => {
  const before = await lstat(path);
  require(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size > 0 && before.size <= maximum);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    require(stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size);
    const bytes = Buffer.alloc(stat.size);
    let position = 0;
    while (position < bytes.length) {
      const part = await file.read(bytes, position, bytes.length - position, position);
      require(part.bytesRead > 0);
      position += part.bytesRead;
    }
    const after = await file.stat();
    require(after.size === stat.size && after.mtimeMs === stat.mtimeMs);
    return bytes;
  } finally { await file.close(); }
};
const privateFile = async (path, content) => {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
};
const cleanup = async () => {
  let cleanupFailed = false;
  if (builderAttempted) {
    try { await docker(['buildx', 'rm', '--force', builder], { cleanup: true }); } catch { cleanupFailed = true; }
  }
  if (owned) {
    try {
      const actual = await lstat(owned);
      require(actual.isDirectory() && !actual.isSymbolicLink() &&
        actual.ino === ownedIdentity.ino && actual.dev === ownedIdentity.dev && await realpath(owned) === owned);
      await rm(owned, { recursive: true, force: false });
    } catch { cleanupFailed = true; }
  }
  require(!cleanupFailed);
};

try {
  recipe = exact(json(Buffer.from(process.env.LIFTOFF_APPLICATION_BUILD_RECIPE ?? '')), [
    'schemaVersion', 'recipe', 'workflowPath', 'repository', 'repositoryId', 'actorId', 'ref', 'azure', 'registry',
    'artifactName', 'platform', 'context', 'dockerfile', 'tools', 'uploadArtifactActionSha', 'budget', 'limits'
  ]);
  require(recipe.schemaVersion === 1 && recipe.recipe === 'liftoff-application-build-workflow.v1');
  const azure = exact(recipe.azure, ['tenantId', 'clientId', 'principalId']);
  for (const id of Object.values(azure)) uuid(id);
  const registry = exact(recipe.registry, ['resourceId', 'loginServer', 'location', 'repository']);
  text(registry.resourceId, /^\/subscriptions\/[a-f0-9-]{36}\/resourceGroups\/[A-Za-z0-9_()-][A-Za-z0-9_.()-]{0,89}\/providers\/Microsoft\.ContainerRegistry\/registries\/[a-z0-9]{5,50}$/);
  uuid(registry.resourceId.split('/')[2]);
  text(registry.loginServer, /^[a-z0-9](?:[a-z0-9.-]{0,180}[a-z0-9])?\.azurecr\.io$/);
  require(registry.loginServer.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)));
  text(registry.repository, /^[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*)*$/);
  require(registry.repository.length <= 255);
  text(registry.location, /^[a-z0-9-]{1,50}$/);
  text(recipe.repository, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/);
  positive(recipe.repositoryId); positive(recipe.actorId); publicName(recipe.artifactName);
  text(recipe.workflowPath, /^\.github\/workflows\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.ya?ml$/);
  text(recipe.ref, /^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/);
  require(!recipe.ref.includes('..') && recipe.ref.split('/').every(part => part && !part.endsWith('.') && !part.endsWith('.lock')));
  for (const [path, root] of [[recipe.context, true], [recipe.dockerfile, false]]) {
    if (root && path === '.') continue;
    text(path, /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$/);
    require(path.split('/').every(part => part && !['.', '..', '.git'].includes(part)));
  }
  text(recipe.uploadArtifactActionSha, /^[a-f0-9]{40}$/);
  exact(recipe.tools, ['dockerVersion', 'buildxVersion', 'buildkitImage']);
  text(recipe.tools.dockerVersion, /^\d{1,3}\.\d{1,3}\.\d{1,3}$/);
  text(recipe.tools.buildxVersion, /^v\d{1,3}\.\d{1,3}\.\d{1,3}$/);
  text(recipe.tools.buildkitImage, /^moby\/buildkit@sha256:[a-f0-9]{64}$/);
  exact(recipe.budget, ['currency', 'fixedMonthlyCents', 'usageMonthlyCents']);
  text(recipe.budget.currency, /^[A-Z]{3}$/);
  for (const field of ['fixedMonthlyCents', 'usageMonthlyCents']) require(Number.isSafeInteger(recipe.budget[field]) && recipe.budget[field] >= 0);
  exact(recipe.limits, ['maxRunMinutes', 'httpTimeoutSeconds', 'commandTimeoutSeconds', 'buildTimeoutSeconds']);
  for (const [key, maximum] of [['maxRunMinutes', 30], ['httpTimeoutSeconds', 30], ['commandTimeoutSeconds', 60],
    ['buildTimeoutSeconds', recipe.limits.maxRunMinutes * 60 - recipe.limits.commandTimeoutSeconds - 70]]) require(positive(recipe.limits[key]) <= maximum);
  require(['linux/amd64', 'linux/arm64'].includes(recipe.platform) && process.platform === 'linux' &&
    process.arch === (recipe.platform === 'linux/amd64' ? 'x64' : 'arm64'));
  deadline = Date.now() + (recipe.limits.maxRunMinutes * 60 - recipe.limits.commandTimeoutSeconds - 60) * 1000;
  timer = setTimeout(stopped, deadline - Date.now());
  const sourceSha = sha(process.env.LIFTOFF_SOURCE_SHA);
  const nonce = text(process.env.LIFTOFF_OPERATION_ID, /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/);
  const runId = positive(Number(text(process.env.GITHUB_RUN_ID, /^[1-9]\d{0,15}$/)));
  require(process.env.GITHUB_RUN_ATTEMPT === '1' && process.env.GITHUB_REPOSITORY === recipe.repository &&
    process.env.GITHUB_REPOSITORY_ID === String(recipe.repositoryId) && process.env.GITHUB_ACTOR_ID === String(recipe.actorId) &&
    process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && process.env.GITHUB_SHA === sourceSha &&
    process.env.GITHUB_WORKFLOW_SHA === sourceSha && process.env.GITHUB_REF === 'refs/heads/' + recipe.ref &&
    process.env.GITHUB_WORKFLOW_REF === recipe.repository + '/' + recipe.workflowPath + '@refs/heads/' + recipe.ref &&
    process.env.GITHUB_JOB === 'build' && process.env.GITHUB_API_URL === 'https://api.github.com' &&
    process.env.GITHUB_SERVER_URL === 'https://github.com' &&
    process.env.LIFTOFF_REGISTRY_RESOURCE_ID === registry.resourceId && process.env.LIFTOFF_IMAGE_REPOSITORY === registry.repository &&
    process.env.LIFTOFF_ARTIFACT_NAME === recipe.artifactName && process.env.LIFTOFF_PLATFORM === recipe.platform);
  const githubToken = protect(process.env.GH_TOKEN);
  const workspace = await realpath(text(process.env.GITHUB_WORKSPACE, /^\/[^\u0000-\u001f\u007f]+$/));
  require((await lstat(workspace)).isDirectory());
  output = join(workspace, 'liftoff-application-build.json');
  try { await lstat(output); throw new Error('Existing report.'); } catch (error) { require(error.code === 'ENOENT'); }
  owned = join(workspace, '.liftoff-application-build-' + randomUUID());
  await mkdir(owned, { mode: 0o700 });
  ownedIdentity = await lstat(owned);
  require(ownedIdentity.isDirectory() && (ownedIdentity.mode & 0o777) === 0o700 && ownedIdentity.uid === process.getuid());
  const home = join(owned, 'home'), dockerConfig = join(owned, 'docker'), scratch = join(owned, 'scratch');
  for (const path of [home, dockerConfig, scratch]) await mkdir(path, { mode: 0o700 });
  childEnvironment = {
    PATH: text(process.env.PATH, /^[^\u0000-\u001f\u007f]+$/), HOME: home, TMPDIR: scratch, TMP: scratch, TEMP: scratch,
    DOCKER_CONFIG: dockerConfig, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', NO_COLOR: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false', GIT_LFS_SKIP_SMUDGE: '1',
    BUILDX_METADATA_PROVENANCE: 'disabled', BUILDX_METADATA_WARNINGS: 'false', BUILDX_NO_DEFAULT_ATTESTATIONS: '1'
  };
  const api = 'https://api.github.com/repos/' + recipe.repository;
  const runPath = api + '/actions/runs/' + runId;
  const origin = 'https://' + registry.loginServer;
  const armUrl = 'https://management.azure.com' + registry.resourceId + '?api-version=2023-07-01';
  const aadUrl = 'https://login.microsoftonline.com/' + azure.tenantId + '/oauth2/v2.0/token';
  const oidcUrl = new URL(secret(process.env.ACTIONS_ID_TOKEN_REQUEST_URL));
  require(oidcUrl.protocol === 'https:' && /^[a-z0-9-]+\.actions\.githubusercontent\.com$/.test(oidcUrl.hostname) &&
    !oidcUrl.port && !oidcUrl.username && !oidcUrl.password && !oidcUrl.hash &&
    /^\/[A-Za-z0-9_/-]+\/idtoken$/.test(oidcUrl.pathname) &&
    [...oidcUrl.searchParams.keys()].every(key => key === 'api-version') &&
    oidcUrl.searchParams.getAll('api-version').length === 1 &&
    /^2\.0(?:-preview)?$/.test(oidcUrl.searchParams.get('api-version')));
  oidcUrl.searchParams.set('audience', 'api://AzureADTokenExchange');
  const allowed = new Map([
    [api, 'GET'], [runPath, 'GET'], [runPath + '/attempts/1', 'GET'],
    [runPath + '/attempts/1/jobs?per_page=100&page=1', 'GET'],
    [api + '/contents/' + recipe.workflowPath + '?ref=' + sourceSha, 'GET'],
    [armUrl, 'GET'], [aadUrl, 'POST'], [oidcUrl.href, 'GET'],
    [origin + '/oauth2/exchange', 'POST'], [origin + '/oauth2/token', 'POST']
  ]);
  const http = async (url, options = {}) => {
    const method = options.form ? 'POST' : 'GET';
    require(allowed.get(url) === method);
    const abort = new AbortController(), ms = remaining(recipe.limits.httpTimeoutSeconds);
    let rejectDeadline;
    const timeout = new Promise((_, reject) => { rejectDeadline = reject; });
    const clock = setTimeout(() => { abort.abort(); rejectDeadline(new Error('HTTP deadline.')); }, ms);
    const execute = async () => {
      const response = await fetch(url, {
        method, redirect: 'error', signal: AbortSignal.any([controller.signal, abort.signal]),
        headers: {
          accept: options.accept ?? 'application/json',
          ...(options.token ? { authorization: 'Bearer ' + options.token } : {}),
          ...(options.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          ...(url.startsWith('https://api.github.com/') ? { 'x-github-api-version': '2022-11-28' } : {})
        },
        ...(options.form ? { body: options.form.toString() } : {})
      });
      require(response.status === 200 && !response.redirected && (!response.url || response.url === url));
      const maximum = options.maximum ?? 65536;
      const length = response.headers.get('content-length');
      require(length === null || /^\d+$/.test(length) && Number(length) <= maximum);
      require(response.body !== null);
      let size = 0;
      const chunks = [];
      try {
        for await (const chunk of response.body) {
          size += chunk.length;
          require(size <= maximum);
          chunks.push(Buffer.from(chunk));
        }
        require(size > 0 && (length === null || size === Number(length)));
        return { bytes: Buffer.concat(chunks), headers: response.headers };
      } catch { abort.abort(); throw new Error('Bounded response failed.'); }
      finally { for (const chunk of chunks) chunk.fill(0); }
    };
    try { return await Promise.race([execute(), timeout]); }
    finally { clearTimeout(clock); }
  };
  const getJson = async (url, options) => {
    const response = await http(url, options);
    try {
      require(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/json');
      return object(json(response.bytes));
    } finally { response.bytes.fill(0); }
  };
  const github = url => getJson(url, { token: githubToken, maximum: 524288 });
  const observe = async () => {
    stage = 'github-identities';
    const repository = await github(api);
    require(repository.id === recipe.repositoryId && repository.full_name === recipe.repository &&
      repository.archived === false && repository.disabled === false);
    const run = await github(runPath + '/attempts/1'), current = await github(runPath);
    for (const value of [run, current]) require(value.id === runId && value.run_attempt === 1 &&
      value.event === 'workflow_dispatch' && value.head_sha === sourceSha && value.head_branch === recipe.ref &&
      value.path === recipe.workflowPath && value.display_title === 'liftoff-' + nonce &&
      value.status === 'in_progress' && value.conclusion === null &&
      object(value.actor).id === recipe.actorId && object(value.triggering_actor).id === recipe.actorId &&
      object(value.repository).id === recipe.repositoryId && value.repository.full_name === recipe.repository &&
      object(value.head_repository).id === recipe.repositoryId && value.head_repository.full_name === recipe.repository);
    const workflowId = positive(run.workflow_id);
    require(current.workflow_id === workflowId);
    const workflowUrl = api + '/actions/workflows/' + workflowId;
    allowed.set(workflowUrl, 'GET');
    const workflow = await github(workflowUrl);
    require(workflow.id === workflowId && workflow.path === recipe.workflowPath &&
      workflow.state === 'active' && workflow.name === 'Liftoff application image build');
    const jobs = await github(runPath + '/attempts/1/jobs?per_page=100&page=1');
    require(jobs.total_count === 1 && Array.isArray(jobs.jobs) && jobs.jobs.length === 1);
    const job = object(jobs.jobs[0]);
    require(job.run_id === runId && job.head_sha === sourceSha && job.head_branch === recipe.ref &&
      job.name === 'Liftoff application image build' && job.status === 'in_progress' && job.conclusion === null &&
      (job.run_attempt === undefined || job.run_attempt === 1) &&
      job.run_url === runPath && job.url === api + '/actions/jobs/' + positive(job.id) &&
      job.html_url === 'https://github.com/' + recipe.repository + '/actions/runs/' + runId + '/job/' + job.id);
    positive(job.runner_id);
    const exactJobUrl = api + '/actions/jobs/' + job.id;
    allowed.set(exactJobUrl, 'GET');
    const exactJob = await github(exactJobUrl);
    for (const key of ['id', 'run_id', 'head_sha', 'head_branch', 'name', 'status', 'conclusion', 'runner_id', 'run_url', 'url', 'html_url'])
      require(exactJob[key] === job[key]);
    require(exactJob.run_attempt === undefined || exactJob.run_attempt === 1);
    return { workflowId, jobId: job.id };
  };
  const producer = await observe();
  stage = 'workflow-source';
  const workflowSource = await github(api + '/contents/' + recipe.workflowPath + '?ref=' + sourceSha);
  require(workflowSource.path === recipe.workflowPath && workflowSource.type === 'file' && workflowSource.encoding === 'base64' &&
    Number.isSafeInteger(workflowSource.size) && workflowSource.size > 0 && workflowSource.size <= 262144 &&
    typeof workflowSource.content === 'string' && workflowSource.content.length <= 360448);
  const encoded = workflowSource.content.replace(/\r?\n/g, '');
  require(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded));
  const workflowBytes = Buffer.from(encoded, 'base64');
  require(workflowBytes.length === workflowSource.size && workflowBytes.toString('base64') === encoded &&
    createHash('sha1').update('blob ' + workflowBytes.length + '\0').update(workflowBytes).digest('hex') === workflowSource.sha);
  const workflowDigest = createHash('sha256').update(JSON.stringify(decode(workflowBytes)) + '\n').digest('hex');
  stage = 'source-checkout';
  const source = join(owned, 'source');
  await command('git', ['init', '--quiet', '--template=', source]);
  await command('git', ['-C', source, 'remote', 'add', 'origin', 'https://github.com/' + recipe.repository + '.git']);
  const gitAuth = {
    GIT_CONFIG_COUNT: '7',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: 'Authorization: Basic ' + Buffer.from('x-access-token:' + githubToken).toString('base64'),
    GIT_CONFIG_KEY_1: 'http.followRedirects', GIT_CONFIG_VALUE_1: 'false',
    GIT_CONFIG_KEY_2: 'credential.helper', GIT_CONFIG_VALUE_2: '',
    GIT_CONFIG_KEY_3: 'core.hooksPath', GIT_CONFIG_VALUE_3: '/dev/null',
    GIT_CONFIG_KEY_4: 'protocol.allow', GIT_CONFIG_VALUE_4: 'never',
    GIT_CONFIG_KEY_5: 'protocol.https.allow', GIT_CONFIG_VALUE_5: 'always',
    GIT_CONFIG_KEY_6: 'http.proxy', GIT_CONFIG_VALUE_6: ''
  };
  try { await command('git', ['-C', source, 'fetch', '--quiet', '--no-tags', '--depth=1', 'origin', sourceSha], { env: gitAuth }); }
  finally { gitAuth.GIT_CONFIG_VALUE_0 = ''; }
  await command('git', ['-C', source, '-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', 'checkout', '--quiet', '--detach', sourceSha]);
  const confined = async (path, directory) => {
    const actual = resolve(source, path);
    require(actual === source || relative(source, actual).split(sep).every(part => part !== '..') && !relative(source, actual).startsWith(sep));
    let current = source;
    for (const part of relative(source, actual).split(sep).filter(Boolean)) {
      current = join(current, part);
      require(!(await lstat(current)).isSymbolicLink());
    }
    const stat = await lstat(actual);
    require(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1);
    return actual;
  };
  const verifyCheckout = async () => {
    require((await command('git', ['-C', source, 'rev-parse', 'HEAD'])).trim() === sourceSha &&
      (await command('git', ['-C', source, 'status', '--porcelain=v1', '--untracked-files=all'])).trim() === '');
    const actual = await boundedFile(await confined(recipe.workflowPath, false), 262144);
    try { require(actual.equals(workflowBytes)); } finally { actual.fill(0); }
  };
  await verifyCheckout();
  const context = await confined(recipe.context, true), dockerfile = await confined(recipe.dockerfile, false);
  stage = 'tool-prerequisites';
  const version = object(json(Buffer.from(await docker(['version', '--format', '{{json .}}']))));
  require(object(version.Client).Version === recipe.tools.dockerVersion && object(version.Server).Version === recipe.tools.dockerVersion);
  const buildxVersion = await docker(['buildx', 'version']);
  require(/^github\.com\/docker\/buildx v\d+\.\d+\.\d+(?: [A-Za-z0-9.-]+)?\s*$/.test(buildxVersion) &&
    buildxVersion.trim().split(/\s+/)[1] === recipe.tools.buildxVersion);
  stage = 'federated-identity';
  let oidc = protect((await getJson(oidcUrl.href, { token: protect(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) })).value);
  const identity = claims(oidc);
  require(identity.iss === 'https://token.actions.githubusercontent.com' && identity.aud === 'api://AzureADTokenExchange' &&
    identity.sub === 'repo:' + recipe.repository + ':ref:refs/heads/' + recipe.ref &&
    identity.repository === recipe.repository && identity.repository_id === String(recipe.repositoryId) &&
    identity.actor_id === String(recipe.actorId) && identity.sha === sourceSha &&
    identity.ref === 'refs/heads/' + recipe.ref && identity.event_name === 'workflow_dispatch' &&
    identity.workflow_ref === process.env.GITHUB_WORKFLOW_REF && identity.workflow_sha === sourceSha &&
    identity.run_id === String(runId) && identity.run_attempt === '1' && identity.runner_environment === 'github-hosted');
  const aad = await getJson(aadUrl, { form: new URLSearchParams({
    client_id: azure.clientId, grant_type: 'client_credentials',
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: oidc, scope: 'https://management.azure.com/.default'
  }) });
  oidc = '';
  require(aad.token_type === 'Bearer');
  let aadAccess = protect(aad.access_token); delete aad.access_token;
  const principal = claims(aadAccess);
  require(principal.oid === azure.principalId && principal.tid === azure.tenantId &&
    (principal.appid ?? principal.azp) === azure.clientId &&
    (principal.appid === undefined || principal.appid === azure.clientId) &&
    (principal.azp === undefined || principal.azp === azure.clientId) &&
    ['https://management.azure.com/', 'https://management.azure.com', 'https://management.core.windows.net/',
      '797f4846-ba00-4fd7-ba43-dac1f8f63013'].includes(principal.aud));
  stage = 'registry-identity';
  const arm = await getJson(armUrl, { token: aadAccess });
  require(typeof arm.id === 'string' && arm.id.toLowerCase() === registry.resourceId.toLowerCase() &&
    arm.type === 'Microsoft.ContainerRegistry/registries' && arm.name === registry.resourceId.split('/').at(-1) &&
    arm.location === registry.location && object(arm.properties).loginServer === registry.loginServer &&
    arm.properties.adminUserEnabled === false && arm.properties.provisioningState === 'Succeeded');
  stage = 'registry-exchange';
  let refresh = protect((await getJson(origin + '/oauth2/exchange', { form: new URLSearchParams({
    grant_type: 'access_token', tenant: azure.tenantId, service: registry.loginServer, access_token: aadAccess
  }) })).refresh_token);
  aadAccess = '';
  const refreshClaims = claims(refresh);
  require(refreshClaims.aud === registry.loginServer && refreshClaims.tenant === azure.tenantId && refreshClaims.grant_type === 'refresh_token');
  const registryAccess = async actions => {
    const access = protect((await getJson(origin + '/oauth2/token', { form: new URLSearchParams({
      grant_type: 'refresh_token', service: registry.loginServer,
      scope: 'repository:' + registry.repository + ':' + actions.join(','), refresh_token: refresh
    }) })).access_token);
    const grant = claims(access, actions.includes('push') ? recipe.limits.buildTimeoutSeconds + 30 : 30);
    require(grant.aud === registry.loginServer && grant.grant_type === 'access_token' &&
      Array.isArray(grant.access) && grant.access.length === 1);
    const scope = exact(grant.access[0], ['type', 'name', 'actions']);
    require(scope.type === 'repository' && scope.name === registry.repository && Array.isArray(scope.actions) &&
      [...scope.actions].sort().join(',') === [...actions].sort().join(','));
    return access;
  };
  let pushToken = await registryAccess(['pull', 'push']);
  const credentialPath = join(dockerConfig, 'config.json');
  await privateFile(credentialPath, JSON.stringify({ auths: { [registry.loginServer]: { registrytoken: pushToken } } }));
  pushToken = '';
  stage = 'image-build';
  builder = 'liftoff-' + runId + '-1-' + randomUUID();
  builderAttempted = true;
  await docker(['buildx', 'create', '--name', builder, '--driver', 'docker-container', '--driver-opt', 'image=' + recipe.tools.buildkitImage]);
  await docker(['buildx', 'inspect', builder, '--bootstrap']);
  const metadataPath = join(owned, 'build-metadata.json');
  await docker(['buildx', 'build', '--builder', builder, '--platform', recipe.platform, '--provenance=false', '--sbom=false',
    '--metadata-file', metadataPath, '--file', dockerfile,
    '--label', 'org.opencontainers.image.source=https://github.com/' + recipe.repository,
    '--label', 'org.opencontainers.image.revision=' + sourceSha,
    '--output', 'type=image,name=' + registry.loginServer + '/' + registry.repository +
      ',push-by-digest=true,name-canonical=true,push=true,oci-mediatypes=true',
    '--quiet', context], { seconds: recipe.limits.buildTimeoutSeconds });
  await rm(credentialPath, { force: false });
  const metadataBytes = await boundedFile(metadataPath, 65536);
  let metadata;
  try { metadata = object(json(metadataBytes)); } finally { metadataBytes.fill(0); }
  const builtDigest = imageDigest(metadata['containerimage.digest']);
  const descriptor = object(metadata['containerimage.descriptor']);
  require(descriptor.digest === builtDigest && descriptor.mediaType === 'application/vnd.oci.image.manifest.v1+json' &&
    Number.isSafeInteger(descriptor.size) && descriptor.size > 0 && descriptor.size <= 49152);
  stage = 'oci-manifest';
  let pullToken = await registryAccess(['pull']);
  refresh = '';
  const manifestUrl = origin + '/v2/' + registry.repository + '/manifests/' + builtDigest;
  allowed.set(manifestUrl, 'GET');
  const manifest = await http(manifestUrl, { token: pullToken, maximum: 49152, accept: 'application/vnd.oci.image.manifest.v1+json' });
  const manifestObject = object(json(manifest.bytes));
  require(manifest.headers.get('docker-content-digest') === builtDigest && digest(manifest.bytes) === builtDigest &&
    manifest.headers.get('content-type')?.split(';')[0].trim() === descriptor.mediaType &&
    descriptor.size === manifest.bytes.length && manifestObject.schemaVersion === 2 &&
    manifestObject.mediaType === 'application/vnd.oci.image.manifest.v1+json' && !Object.hasOwn(manifestObject, 'manifests') &&
    !Object.hasOwn(manifestObject, 'subject') && !Object.hasOwn(manifestObject, 'artifactType') &&
    Array.isArray(manifestObject.layers) && manifestObject.layers.length <= 128);
  for (const entry of manifestObject.layers) {
    const layer = object(entry);
    imageDigest(layer.digest);
    require(Number.isSafeInteger(layer.size) && layer.size >= 0 && layer.size <= 2 ** 31 &&
      ['application/vnd.oci.image.layer.v1.tar', 'application/vnd.oci.image.layer.v1.tar+gzip',
        'application/vnd.oci.image.layer.v1.tar+zstd'].includes(layer.mediaType) && !Object.hasOwn(layer, 'urls'));
  }
  stage = 'oci-config';
  const configDescriptor = object(manifestObject.config), configDigest = imageDigest(configDescriptor.digest);
  require(configDescriptor.mediaType === 'application/vnd.oci.image.config.v1+json' &&
    configDigest === metadata['containerimage.config.digest'] &&
    Number.isSafeInteger(configDescriptor.size) && configDescriptor.size > 0 && configDescriptor.size <= 49152 &&
    !Object.hasOwn(configDescriptor, 'urls'));
  const configUrl = origin + '/v2/' + registry.repository + '/blobs/' + configDigest;
  allowed.set(configUrl, 'GET');
  const configuration = await http(configUrl, { token: pullToken, maximum: 49152, accept: 'application/octet-stream' });
  pullToken = '';
  const config = object(json(configuration.bytes));
  require(digest(configuration.bytes) === configDigest && configuration.bytes.length === configDescriptor.size &&
    (configuration.headers.get('docker-content-digest') === null || configuration.headers.get('docker-content-digest') === configDigest) &&
    config.os === 'linux' && config.architecture === recipe.platform.split('/')[1]);
  const labels = object(object(config.config).Labels);
  require(labels['org.opencontainers.image.source'] === 'https://github.com/' + recipe.repository &&
    labels['org.opencontainers.image.revision'] === sourceSha);
  for (const token of protectedValues) for (const bytes of [manifest.bytes, configuration.bytes])
    require(!bytes.includes(token) && !bytes.includes(token.toString('base64')));
  stage = 'final-bindings';
  await verifyCheckout();
  const currentProducer = await observe();
  require(currentProducer.workflowId === producer.workflowId && currentProducer.jobId === producer.jobId);
  report = Buffer.from(JSON.stringify({
    schemaVersion: 1, kind: 'liftoff-application-build',
    source: { repository: recipe.repository, repositoryId: recipe.repositoryId, commitSha: sourceSha },
    producer: { workflowId: producer.workflowId, workflowPath: recipe.workflowPath, workflowDigest,
      runId, runAttempt: 1, actorId: recipe.actorId, jobId: producer.jobId },
    image: { registryResourceId: registry.resourceId, loginServer: registry.loginServer, repository: registry.repository, digest: builtDigest },
    oci: { manifestBase64: manifest.bytes.toString('base64'), configBase64: configuration.bytes.toString('base64') }
  }) + '\n');
  manifest.bytes.fill(0); configuration.bytes.fill(0); workflowBytes.fill(0);
  require(report.length <= 65536 && !controller.signal.aborted);
} catch { failed = true; }
finally {
  clearTimeout(timer);
  try { await cleanup(); } catch { failed = true; stage = 'private-cleanup'; }
}
if (!failed) {
  let created;
  try {
    require(!controller.signal.aborted && Date.now() < deadline);
    const file = await open(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      created = await file.stat();
      await file.writeFile(report);
      await file.sync();
      require(!controller.signal.aborted && Date.now() < deadline);
      const actual = await lstat(output);
      require(actual.isFile() && actual.nlink === 1 && actual.ino === created.ino && actual.dev === created.dev &&
        actual.size === report.length && (actual.mode & 0o777) === 0o600);
    } finally { await file.close(); }
  } catch {
    failed = true;
    stage = 'report-write';
    if (created) {
      try {
        const current = await lstat(output);
        require(current.ino === created.ino && current.dev === created.dev && current.isFile());
        await rm(output, { force: false });
      } catch {}
    }
  }
}
report?.fill(0);
for (const token of protectedValues) token.fill(0);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(signal, stopped);
if (failed) {
  process.stderr.write('Application build failed (' + stage + '); credential and command diagnostics withheld. No successful report was produced; remote effects are not rolled back.\n');
  process.exitCode = 1;
}
`;

/**
 * Actions limits each run command to 21,000 characters. Keep the complete readable source in
 * fixed, bounded environment literals and execute only its embedded SHA-256-checked bytes.
 * No dispatch input or downloaded program is evaluated; the private runtime inherits no code env.
 */
export function applicationBuildWorkflowProgramDelivery(): { env: Record<string, string>; run: string } {
  const chunks = applicationBuildWorkflowProgram.match(/[\s\S]{1,16000}/gu)!;
  const env = Object.fromEntries(chunks.map((chunk, index) => [`LIFTOFF_APPLICATION_BUILD_PROGRAM_${index}`, chunk]));
  const names = Object.keys(env);
  const expected = createHash('sha256').update(applicationBuildWorkflowProgram).digest('hex');
  return {
    env,
    run: `node --input-type=module <<'LIFTOFF_APPLICATION_BUILD_PROGRAM'\n` +
      `import { createHash } from 'node:crypto';\n` +
      `try {\n` +
      `  const names = ${JSON.stringify(names)};\n` +
      `  const program = names.map(name => process.env[name] ?? '').join('');\n` +
      `  for (const name of names) delete process.env[name];\n` +
      `  if (createHash('sha256').update(program).digest('hex') !== '${expected}') throw new Error('Program identity mismatch.');\n` +
      `  await import('data:text/javascript;base64,' + Buffer.from(program).toString('base64'));\n` +
      `} catch { process.stderr.write('Application build program identity or execution failed; diagnostics withheld.\\n'); process.exitCode = 1; }\n` +
      `LIFTOFF_APPLICATION_BUILD_PROGRAM\n`
  };
}
