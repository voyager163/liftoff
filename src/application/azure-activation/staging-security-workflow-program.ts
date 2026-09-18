import { createHash } from 'node:crypto';
import { stagingPrivateHttpProgram } from './staging-private-http.js';

/**
 * Dependency-free executable, embedded verbatim in the reviewed workflow, not fetched from a mutable URL.
 * Dedicated Linux-runner program that validates producer run/job metadata via GitHub REST API,
 * performs same-job private-access health and OpenAPI schema observations against the target Container App,
 * executes bounded container security (Trivy-compatible) and DAST (ZAP-compatible) scans,
 * parses real scan JSON formats (rejecting malformed, truncated, or unapproved targets),
 * distinguishes prerequisite failures from policy findings, and atomically writes the single report artifact.
 */
export const stagingSecurityWorkflowProgram =
  `const stagingPrivateHttp = await import('data:text/javascript;base64,${Buffer.from(stagingPrivateHttpProgram).toString('base64')}');\n` +
  String.raw`import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, readFile, rm, mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';

let stage = 'initialization';
let failed = false;
let prerequisiteError = null;

const requireCondition = (condition, message = 'Staging security prerequisite failed.') => {
  if (!condition) {
    const error = new Error(message);
    error.stage = stage;
    throw error;
  }
};

const digestHex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const canonicalValue = (value) => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    requireCondition(Number.isFinite(value), 'Non-finite recipe value');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  requireCondition(typeof value === 'object', 'Unsupported recipe value');
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]));
};
const canonicalDigest = (value) => digestHex(Buffer.from(JSON.stringify(canonicalValue(value)) + '\n'));
const dispatchId = (value) => {
  requireCondition(typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value) &&
    Number.isSafeInteger(Number(value)), 'Exact runtime workflow/runner identity missing');
  return Number(value);
};

// Read environment configuration
const recipeRaw = process.env.LIFTOFF_STAGING_SECURITY_RECIPE;
const correlationId = process.env.LIFTOFF_CORRELATION_ID;
const configurationDigest = process.env.LIFTOFF_CONFIGURATION_DIGEST;
const recipeDigest = process.env.LIFTOFF_RECIPE_DIGEST;
const ghToken = process.env.GH_TOKEN;

// Immediately erase GH_TOKEN from process.env to prevent child inheritance or ambient leaks
delete process.env.GH_TOKEN;
delete process.env.GITHUB_TOKEN;

const childEnv = { PATH: '/usr/local/bin:/usr/bin:/bin:/opt/az/bin', LANG: 'C.UTF-8' };
let deadline = 0;
let owned;
let registryToken;

const fetchJson = async (url, headers = {}, timeoutSeconds = 15) => {
  const parsedUrl = new URL(url);
  const allowed = recipe.authority.allowedNetworkTargets;
  requireCondition(allowed.includes(parsedUrl.hostname), 'Disallowed network target: ' + parsedUrl.hostname);
  const response = await fetch(url, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(Math.max(1, Math.min(timeoutSeconds * 1000, deadline - Date.now())))
  });
  requireCondition(response.status === 200, 'HTTP status was ' + response.status + ' for ' + parsedUrl.pathname);
  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  requireCondition(contentType === 'application/json', 'Content-Type was not application/json');
  let size = 0;
  const chunks = [];
  requireCondition(response.body !== null, 'Response body was null');
  for await (const chunk of response.body) {
    size += chunk.length;
    requireCondition(size <= 524288, 'Response exceeded 512KB');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const body = JSON.parse(text);
  requireCondition(body !== null && typeof body === 'object', 'JSON root was not an object');
  const bodyDigest = digestHex(bytes);
  return { body, bytes, status: response.status, bodyDigest };
};

const runCommand = async (tool, args, options = {}) => {
  const stat = await lstat(tool.executable);
  requireCondition(stat.isFile() && !stat.isSymbolicLink() && await realpath(tool.executable) === tool.executable &&
    stat.size > 0 && stat.size <= 536870912, 'Invalid pinned tool');
  const binary = await readFile(tool.executable);
  try { requireCondition('sha256:' + digestHex(binary) === tool.expectedSha256, 'Pinned tool digest changed'); }
  finally { binary.fill(0); }
  return new Promise((resolvePromise, rejectPromise) => {
    const timeoutMs = Math.min(options.timeoutSeconds * 1000, deadline - Date.now());
    requireCondition(Number.isFinite(timeoutMs) && timeoutMs > 0, 'Execution window expired');
    const proc = spawn(tool.executable, args, {
      env: { ...childEnv, HOME: owned, ...(options.env ?? {}) },
      cwd: owned,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdoutSize = 0, stderrSize = 0;
    const stdoutChunks = [], stderrChunks = [];
    let aborted = false;
    const kill = () => {
      aborted = true;
      if (proc.pid) {
        try { process.kill(-proc.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    };
    const timer = setTimeout(kill, timeoutMs);

    proc.stdout.on('data', chunk => {
      stdoutSize += chunk.length;
      if (stdoutSize > 2 * 1024 * 1024) {
        kill();
        return;
      }
      stdoutChunks.push(chunk);
    });

    proc.stderr.on('data', chunk => {
      stderrSize += chunk.length;
      if (stderrSize > 512 * 1024) {
        kill();
        return;
      }
      stderrChunks.push(chunk);
    });

    proc.on('close', code => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);
      stderr.fill(0);
      if (aborted || !Number.isSafeInteger(code)) {
        stdout.fill(0); rejectPromise(new Error('Owned scanner process exceeded its bound or did not settle.'));
      } else resolvePromise({ code, stdout });
    });

    proc.on('error', err => {
      clearTimeout(timer);
      rejectPromise(err);
    });
  });
};

const parseTrivyRealJson = (rawBytes, failOnSeverities) => {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
  const data = JSON.parse(text);
  requireCondition(typeof data === 'object' && data !== null, 'Trivy output root must be an object');
  requireCondition(data.SchemaVersion === 2 && data.ArtifactType === 'container_image' &&
    data.ArtifactName === recipe.image.loginServer + '/' + recipe.image.repository + '@' + recipe.image.digest, 'Trivy image binding');
  requireCondition(Array.isArray(data.Results) && data.Results.length > 0 && data.Results.length <= 4096, 'Trivy output missing Results array');
  const findings = [];
  const findingsCount = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const result of data.Results) {
    requireCondition(result && typeof result === 'object' && !Array.isArray(result) && typeof result.Target === 'string' &&
      result.Target.length > 0 && (result.Vulnerabilities === undefined || Array.isArray(result.Vulnerabilities)), 'Malformed Trivy result');
    for (const vuln of result.Vulnerabilities ?? []) {
      requireCondition(typeof vuln === 'object' && vuln !== null, 'Malformed vulnerability item');
      requireCondition(typeof vuln.VulnerabilityID === 'string' && vuln.VulnerabilityID.length > 0, 'Missing VulnerabilityID');
      requireCondition(typeof vuln.PkgName === 'string' && vuln.PkgName.length > 0, 'Missing PkgName');
      requireCondition(['CRITICAL','HIGH','MEDIUM','LOW'].includes(vuln.Severity) &&
        typeof vuln.InstalledVersion === 'string' && vuln.InstalledVersion.length > 0, 'Unknown Severity or package version');
      const sev = vuln.Severity;
      if (sev === 'CRITICAL') findingsCount.critical++;
      else if (sev === 'HIGH') findingsCount.high++;
      else if (sev === 'MEDIUM') findingsCount.medium++;
      else if (sev === 'LOW') findingsCount.low++;
      else findingsCount.info++;

      const finding = {
        vulnerabilityId: vuln.VulnerabilityID,
        packageName: vuln.PkgName,
        installedVersion: vuln.InstalledVersion,
        severity: sev
      };
      if (vuln.FixedVersion) finding.fixedVersion = String(vuln.FixedVersion);
      if (vuln.Title) finding.title = String(vuln.Title);
      if (vuln.PrimaryURL) finding.primaryUrl = String(vuln.PrimaryURL);
      findings.push(finding);
    }
  }
  const policyViolations = findings.filter(f => failOnSeverities.includes(f.severity));
  return {
    findings,
    findingsCount,
    status: policyViolations.length > 0 ? 'policy_violation' : 'passed'
  };
};

const parseZapRealJson = (rawBytes, expectedHost, failOnRisk) => {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
  const data = JSON.parse(text);
  requireCondition(typeof data === 'object' && data !== null, 'ZAP output root must be an object');
  requireCondition(data['@programName'] === 'ZAP' && data['@version'] === recipe.tools.dastScanner.version, 'ZAP version binding');
  requireCondition(Array.isArray(data.site) && data.site.length === 1, 'ZAP output missing unique site');
  const alerts = [];
  const alertsCount = { high: 0, medium: 0, low: 0, info: 0 };
  for (const s of data.site) {
    requireCondition(typeof s === 'object' && s !== null, 'Malformed ZAP site entry');
    const host = s['@host'];
    requireCondition(host === expectedHost && s['@name'] === 'https://' + expectedHost &&
      s['@port'] === '443' && s['@ssl'] === 'true', 'ZAP report site host mismatch');
    requireCondition(Array.isArray(s.alerts) && s.alerts.length <= 4096, 'Missing actual ZAP alert inventory');
    for (const a of s.alerts) {
      requireCondition(typeof a === 'object' && a !== null, 'Malformed ZAP alert entry');
      requireCondition(typeof a.pluginid === 'string' && a.pluginid.length > 0, 'Missing alert pluginid');
      const name = a.alert || a.name;
      requireCondition(typeof name === 'string' && name.length > 0, 'Missing alert name');
      requireCondition(['0','1','2','3'].includes(a.riskcode) && Array.isArray(a.instances) &&
        a.instances.length > 0 && a.instances.length <= 4096, 'Unknown ZAP risk or missing instance');
      const risk = {'0':'INFORMATIONAL','1':'LOW','2':'MEDIUM','3':'HIGH'}[a.riskcode];
      alertsCount[risk === 'INFORMATIONAL' ? 'info' : risk.toLowerCase()]++;
      let uri;
      for (const instance of a.instances) {
        requireCondition(instance && typeof instance.uri === 'string', 'Malformed DAST instance');
        const url = new URL(instance.uri);
        requireCondition(url.origin === 'https://' + expectedHost && !url.username && !url.password && !url.hash,
          'Out-of-scope DAST instance');
        uri ??= url.origin + url.pathname;
      }
      const alert = {
        pluginId: a.pluginid,
        name,
        risk
      };
      if (a.confidence) alert.confidence = String(a.confidence);
      if (uri) alert.uri = uri;
      alerts.push(alert);
    }
  }
  const policyViolations = alerts.filter(a => failOnRisk.includes(a.risk));
  return {
    alerts,
    alertsCount,
    status: policyViolations.length > 0 ? 'policy_violation' : 'passed'
  };
};

let recipe;
let reportBuffer = null;

try {
  stage = 'recipe-validation';
  requireCondition(typeof recipeRaw === 'string' && recipeRaw.length > 0, 'Missing LIFTOFF_STAGING_SECURITY_RECIPE');
  requireCondition(typeof recipeDigest === 'string' && recipeDigest.length > 0, 'Missing LIFTOFF_RECIPE_DIGEST');
  recipe = JSON.parse(recipeRaw);
  requireCondition(recipe.schemaVersion === 1 && recipe.recipe === 'liftoff-staging-security-workflow.v1' &&
    recipe.environment === 'staging' && !Object.hasOwn(recipe,'sourceSha') && !Object.hasOwn(recipe,'workflowId') &&
    recipe.runner && Object.keys(recipe.runner).sort().join(',') === 'group,label',
    'Only source recipe fields may be embedded');
  requireCondition(/^[a-f0-9]{64}$/.test(recipeDigest) && canonicalDigest(recipe) === recipeDigest,
    'Source recipe commitment mismatch');
  const executionSource = process.env.LIFTOFF_EXECUTION_SOURCE_SHA;
  const workflowId = dispatchId(process.env.LIFTOFF_WORKFLOW_ID);
  requireCondition(typeof executionSource === 'string' && /^[a-f0-9]{40}$/.test(executionSource), 'Immutable execution source missing');
  recipe.sourceSha = executionSource;
  recipe.workflowId = workflowId;
  recipe.runner.runnerGroupId = dispatchId(process.env.LIFTOFF_RUNNER_GROUP_ID);
  recipe.runner.runnerId = process.env.LIFTOFF_RUNNER_ID === 'none' ? null : dispatchId(process.env.LIFTOFF_RUNNER_ID);
  requireCondition(/^sha256:[a-f0-9]{64}$/.test(process.env.LIFTOFF_IMAGE_DIGEST) &&
    /^[a-z0-9][a-z0-9.-]{1,200}\.azurecontainerapps\.io$/.test(process.env.LIFTOFF_TARGET_FQDN) &&
    !process.env.LIFTOFF_TARGET_FQDN.includes('..') &&
    /^[a-f0-9]{64}$/.test(process.env.LIFTOFF_DATABASE_DIGEST) &&
    /^[a-f0-9]{64}$/.test(process.env.LIFTOFF_DATABASE_METADATA_DIGEST), 'Exact runtime artifact, target or database binding missing');
  recipe.image.digest = process.env.LIFTOFF_IMAGE_DIGEST;
  recipe.target.fqdn = process.env.LIFTOFF_TARGET_FQDN;
  recipe.target.privateIp = process.env.LIFTOFF_TARGET_PRIVATE_IP === 'none' ? null : process.env.LIFTOFF_TARGET_PRIVATE_IP;
  requireCondition(recipe.target.privateIp === null || stagingPrivateHttp.isRfc1918Ipv4(recipe.target.privateIp), 'Invalid private target address');
  recipe.database.databaseSha256 = process.env.LIFTOFF_DATABASE_DIGEST;
  recipe.database.metadataSha256 = process.env.LIFTOFF_DATABASE_METADATA_DIGEST;
  recipe.authority.allowedNetworkTargets = [recipe.target.fqdn,'api.github.com',recipe.image.loginServer];
  requireCondition(/^[a-f0-9]{64}$/.test(configurationDigest) && canonicalDigest(recipe) === configurationDigest,
    'Reviewed runtime qualification commitment mismatch');
  deadline = Date.now() + (recipe.authority.limits.maxRunMinutes * 60 - 60) * 1000;
  const temporary = await realpath(process.env.RUNNER_TEMP);
  owned = await mkdtemp(join(temporary, 'liftoff-staging-scan-'));

  const runId = Number(process.env.GITHUB_RUN_ID);
  const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  const repository = process.env.GITHUB_REPOSITORY;
  const repositoryId = Number(process.env.GITHUB_REPOSITORY_ID);
  const commitSha = process.env.GITHUB_SHA;
  const ref = process.env.GITHUB_REF;

  requireCondition(repository === recipe.repository, 'Repository mismatch');
  requireCondition(repositoryId === recipe.repositoryId, 'Repository ID mismatch');
  requireCondition(/^[a-f0-9]{40}$/.test(executionSource) && commitSha === executionSource &&
    process.env.GITHUB_WORKFLOW_SHA === executionSource && ref === 'refs/heads/' + recipe.ref &&
    process.env.GITHUB_ACTOR_ID === String(recipe.actorId) && process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
    process.env.GITHUB_WORKFLOW_REF === recipe.repository + '/' + recipe.workflowPath + '@refs/heads/' + recipe.ref,
    'Immutable execution source mismatch');
  requireCondition(runAttempt === 1, 'Only first dispatch run attempt can establish qualification');

  stage = 'github-producer-verification';
  requireCondition(typeof ghToken === 'string' && ghToken.length > 0, 'Missing GH_TOKEN for producer verification');
  const ghHeaders = {
    authorization: 'Bearer ' + ghToken,
    accept: 'application/vnd.github+json'
  };
  const runUrl = 'https://api.github.com/repos/' + repository + '/actions/runs/' + runId + '/attempts/' + runAttempt;
  const runRes = await fetchJson(runUrl, ghHeaders, recipe.authority.limits.httpTimeoutSeconds);
  const runData = runRes.body;
  requireCondition(runData.id === runId && runData.workflow_id === workflowId && runData.run_attempt === 1 &&
    runData.path === recipe.workflowPath && runData.actor?.id === recipe.actorId && runData.triggering_actor?.id === recipe.actorId &&
    runData.head_sha === executionSource && runData.head_branch === recipe.ref && runData.event === 'workflow_dispatch' &&
    runData.repository?.id === recipe.repositoryId && runData.repository?.full_name === recipe.repository &&
    runData.display_title === 'liftoff-' + correlationId, 'Run metadata binding mismatch');
  const workflowSource = (await fetchJson('https://api.github.com/repos/' + repository + '/contents/' +
    recipe.workflowPath + '?ref=' + executionSource, ghHeaders, recipe.authority.limits.httpTimeoutSeconds)).body;
  requireCondition(workflowSource.type === 'file' && workflowSource.path === recipe.workflowPath &&
    workflowSource.encoding === 'base64' && typeof workflowSource.content === 'string', 'Actual workflow bytes missing');
  const sourceBytes = Buffer.from(workflowSource.content.replace(/\r?\n/g,''),'base64');
  requireCondition(sourceBytes.length === workflowSource.size &&
    createHash('sha1').update('blob ' + sourceBytes.length + '\0').update(sourceBytes).digest('hex') === workflowSource.sha,
    'Actual source blob mismatch');
  const workflowDigest = digestHex(Buffer.from(JSON.stringify(new TextDecoder('utf-8',{fatal:true}).decode(sourceBytes)) + '\n'));
  sourceBytes.fill(0);

  const jobsUrl = runUrl + '/jobs?per_page=100&page=1';
  const jobsRes = await fetchJson(jobsUrl, ghHeaders, recipe.authority.limits.httpTimeoutSeconds);
  const jobsData = jobsRes.body;
  requireCondition(jobsData.total_count === 1 && jobsData.jobs?.length === 1, 'Workflow must contain exactly one job');
  const job = jobsData.jobs[0];
  requireCondition(Number.isSafeInteger(job.runner_id) && job.runner_id > 0 &&
    (recipe.runner.runnerId === null || job.runner_id === recipe.runner.runnerId) &&
    job.runner_group_id === recipe.runner.runnerGroupId &&
    job.name === 'Liftoff staging security and DAST qualification' && job.run_id === runId &&
    job.head_sha === executionSource && Array.isArray(job.labels) && job.labels.includes(recipe.runner.label), 'Dedicated runner binding mismatch');

  stage = 'private-health-and-schema';
  const healthUrl = 'https://' + recipe.target.fqdn + recipe.target.healthPath;
  const schemaUrl = 'https://' + recipe.target.fqdn + recipe.target.schemaPath;
  const observeRuntime = async (pathname) => {
    if (recipe.target.privateIp === null) return fetchJson('https://' + recipe.target.fqdn + pathname, {}, recipe.authority.limits.httpTimeoutSeconds);
    const result = await stagingPrivateHttp.stagingPrivateHttpFetch({
      fqdn: recipe.target.fqdn, path: pathname, expectedPrivateIp: recipe.target.privateIp, deadlineMs: deadline,
      timeoutMs: recipe.authority.limits.httpTimeoutSeconds * 1000, maxBodyBytes: 131072
    });
    result.bytes.fill(0);
    return { body: result.body, status: result.witness.statusCode, bodyDigest: result.witness.bodyDigest, witness: result.witness };
  };
  const healthRes = await observeRuntime(recipe.target.healthPath);
  requireCondition(healthRes.body.status === 'ok', 'Health status was not ok');
  const schemaRes = await observeRuntime(recipe.target.schemaPath);
  requireCondition(/^3\.(?:0|1)\.\d+$/.test(schemaRes.body.openapi), 'OpenAPI version must be 3.0 or 3.1');
  requireCondition(schemaRes.body.paths !== null && typeof schemaRes.body.paths === 'object' &&
    !Array.isArray(schemaRes.body.paths) && Object.keys(schemaRes.body.paths).length > 0 &&
    Object.keys(schemaRes.body.paths).length <= 128 && schemaRes.body.info &&
    typeof schemaRes.body.info.title === 'string' && typeof schemaRes.body.info.version === 'string' &&
    Object.entries(schemaRes.body.paths).every(([name,item]) => name.startsWith('/') && item && typeof item === 'object' &&
      Object.entries(item).some(([method,value]) => ['get','post','put','patch','delete','head','options','trace'].includes(method) &&
        value && typeof value.responses === 'object' && Object.keys(value.responses).length > 0)), 'OpenAPI operations missing');

  stage = 'exact-registry-read-credential';
  const azureTool = recipe.tools.azureCli;
  const azureDirectory = await realpath(process.env.AZURE_CONFIG_DIR);
  requireCondition(azureDirectory === join(temporary,'liftoff-staging-azure-' + correlationId), 'Explicit transient Azure login directory mismatch');
  const azureVersion = await runCommand(azureTool, ['version','--output','json'], {
    timeoutSeconds: recipe.authority.limits.commandTimeoutSeconds, env: { AZURE_CONFIG_DIR: azureDirectory }
  });
  requireCondition(azureVersion.code === 0 && JSON.parse(azureVersion.stdout.toString())['azure-cli'] === azureTool.version, 'Azure CLI version mismatch');
  azureVersion.stdout.fill(0);
  const access = await runCommand(azureTool, ['account','get-access-token','--subscription',recipe.azure.subscriptionId,
    '--tenant',recipe.azure.tenantId,'--resource','https://management.azure.com/','--output','json'], {
    timeoutSeconds: recipe.authority.limits.commandTimeoutSeconds, env: { AZURE_CONFIG_DIR: azureDirectory }
  });
  requireCondition(access.code === 0, 'Explicit federated registry reader unavailable');
  let accessData;
  try { accessData = JSON.parse(access.stdout.toString()); } finally { access.stdout.fill(0); }
  const claims = JSON.parse(Buffer.from(accessData.accessToken.split('.')[1],'base64url').toString());
  requireCondition(accessData.subscription === recipe.azure.subscriptionId && accessData.tenant === recipe.azure.tenantId &&
    claims.tid === recipe.azure.tenantId && claims.oid === recipe.azure.principalId &&
    (claims.appid ?? claims.azp) === recipe.azure.clientId && claims.aud === 'https://management.azure.com/' &&
    Number.isSafeInteger(claims.exp) && claims.exp * 1000 > deadline, 'Actual Azure read principal mismatch');
  const registryPost = async (endpoint, form) => {
    const response = await fetch('https://' + recipe.image.loginServer + endpoint, {
      method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'}, body:form.toString(),
      redirect:'error', signal:AbortSignal.timeout(recipe.authority.limits.httpTimeoutSeconds * 1000)
    });
    requireCondition(response.status === 200, 'Registry credential exchange failed');
    let size = 0; const chunks = [];
    for await (const chunk of response.body) { size += chunk.length; requireCondition(size <= 131072); chunks.push(chunk); }
    const body = Buffer.concat(chunks);
    try { return JSON.parse(body.toString()); } finally { body.fill(0); }
  };
  const refresh = await registryPost('/oauth2/exchange', new URLSearchParams({
    grant_type:'access_token',service:recipe.image.loginServer,tenant:recipe.azure.tenantId,access_token:accessData.accessToken
  }));
  accessData = null;
  requireCondition(typeof refresh.refresh_token === 'string' && refresh.refresh_token.length > 0);
  const scoped = await registryPost('/oauth2/token', new URLSearchParams({
    grant_type:'refresh_token',service:recipe.image.loginServer,scope:'repository:' + recipe.image.repository + ':pull',
    refresh_token:refresh.refresh_token
  }));
  refresh.refresh_token = '';
  requireCondition(typeof scoped.access_token === 'string' && scoped.access_token.length > 0);
  registryToken = scoped.access_token;

  stage = 'container-scanner-execution';
  const cacheDirectory = join(owned,'trivy-cache');
  await mkdir(join(cacheDirectory,'db'),{recursive:true,mode:0o700});
  requireCondition(await realpath(recipe.database.cacheDirectory) === recipe.database.cacheDirectory, 'Database directory replaced');
  for (const [filename,expected] of [['trivy.db',recipe.database.databaseSha256],['metadata.json',recipe.database.metadataSha256]]) {
    const file = join(recipe.database.cacheDirectory,'db',filename);
    const stat = await lstat(file);
    requireCondition(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 536870912, 'Pinned database unavailable');
    const bytes = await readFile(file);
    try {
      requireCondition(digestHex(bytes) === expected, 'Vulnerability database changed');
      if (filename === 'metadata.json') {
        const metadata = JSON.parse(bytes.toString());
        requireCondition(metadata.Version === 2 && Number.isFinite(Date.parse(metadata.UpdatedAt)) &&
          Number.isFinite(Date.parse(metadata.NextUpdate)) && Date.parse(metadata.UpdatedAt) <= Date.now() &&
          Date.parse(metadata.NextUpdate) > Date.now() &&
          Date.now() - Date.parse(metadata.UpdatedAt) <= recipe.database.maxAgeHours * 3600000, 'Vulnerability database stale');
      }
      await writeFile(join(cacheDirectory,'db',filename),bytes,{flag:'wx',mode:0o600});
    } finally { bytes.fill(0); }
  }
  const csTool = recipe.tools.containerScanner;
  const csVer = await runCommand(csTool, ['--version'], { timeoutSeconds: recipe.authority.limits.commandTimeoutSeconds });
  requireCondition(csVer.code === 0 && csVer.stdout.toString('utf8').split(/\r?\n/).includes('Version: ' + csTool.version), 'Container scanner version mismatch');
  csVer.stdout.fill(0);

  const imageRef = recipe.image.loginServer + '/' + recipe.image.repository + '@' + recipe.image.digest;
  const csReportFile = join(owned,'trivy-scan-report.json');
  const csRun = await runCommand(csTool, [
    'image', '--image-src', 'remote', '--format', 'json', '--output', csReportFile,
    '--scanners','vuln','--cache-dir',cacheDirectory,'--skip-db-update','--skip-java-db-update','--offline-scan','--exit-code','0', imageRef
  ], { timeoutSeconds: recipe.authority.limits.scanTimeoutSeconds,
    env: { TRIVY_USERNAME:'00000000-0000-0000-0000-000000000000',TRIVY_PASSWORD:registryToken } });
  registryToken = null;
  csRun.stdout.fill(0);
  requireCondition(csRun.code === 0, 'Container scanner did not complete');
  const csStat = await lstat(csReportFile);
  requireCondition(csStat.isFile() && !csStat.isSymbolicLink() && csStat.size <= 2097152, 'Scanner report is not bounded');
  const csBytes = await readFile(csReportFile);
  requireCondition(csBytes && csBytes.length > 0, 'Empty container scanner output');
  const csDigest = digestHex(csBytes);
  const csParsed = parseTrivyRealJson(csBytes, recipe.policy.failOnSeverities);
  csBytes.fill(0);

  stage = 'dast-scanner-execution';
  const dastTool = recipe.tools.dastScanner;
  const dastReportFile = join(owned,'dast-report.json');
  const targetUrl = 'https://' + recipe.target.fqdn;
  const contextFile = join(owned,'liftoff-staging.context');
  await writeFile(contextFile,'<?xml version="1.0" encoding="UTF-8"?><configuration><context><name>Liftoff staging</name>' +
    '<inscope>true</inscope><incregex>https://' + recipe.target.fqdn.replaceAll('.','\\.') +
    '(?:/.*)?</incregex></context></configuration>',{flag:'wx',mode:0o600});
  const dastRun = await runCommand(dastTool, [
    '-t', targetUrl, '-n',contextFile,'-J', dastReportFile, '-m', '1', '-T', String(Math.ceil(recipe.authority.limits.scanTimeoutSeconds / 60))
  ], { timeoutSeconds: recipe.authority.limits.scanTimeoutSeconds });
  dastRun.stdout.fill(0);
  requireCondition([0,1,2].includes(dastRun.code), 'DAST scanner did not complete');
  const dastStat = await lstat(dastReportFile);
  requireCondition(dastStat.isFile() && !dastStat.isSymbolicLink() && dastStat.size <= 2097152, 'DAST report is not bounded');
  const dastBytes = await readFile(dastReportFile);
  requireCondition(dastBytes && dastBytes.length > 0, 'Empty DAST scanner output');
  const dastDigest = digestHex(dastBytes);
  const dastParsed = parseZapRealJson(dastBytes, recipe.target.fqdn, recipe.policy.failOnDastRisk);
  dastBytes.fill(0);

  stage = 'report-generation';
  const overallStatus = (csParsed.status === 'passed' && dastParsed.status === 'passed') ? 'passed' : 'policy_violation';

  const report = {
    schemaVersion: 1,
    kind: 'liftoff-staging-security',
    correlationId,
    configurationDigest,
    recipeDigest,
    source: {
      repository: recipe.repository,
      repositoryId: recipe.repositoryId,
      commitSha: executionSource,
      ref: recipe.ref
    },
    producer: {
      workflowId,
      workflowPath: recipe.workflowPath,
      workflowDigest,
      runId,
      runAttempt,
      actorId: runData.actor.id,
      jobId: job.id,
      runnerId: job.runner_id,
      runnerGroupId: job.runner_group_id
    },
    target: {
      environment: 'staging',
      resourceId: recipe.target.resourceId,
      fqdn: recipe.target.fqdn,
      imageDigest: recipe.image.digest
    },
    prerequisites: {
      health: {
        path: recipe.target.healthPath,
        status: 200,
        mediaType: 'application/json',
        bodyDigest: healthRes.bodyDigest,
        statusValue: 'ok'
      },
      schema: {
        path: recipe.target.schemaPath,
        status: 200,
        mediaType: 'application/json',
        bodyDigest: schemaRes.bodyDigest,
        openapi: schemaRes.body.openapi,
        paths: Object.keys(schemaRes.body.paths).sort()
      },
      reachabilityVerified: true
      , privateAccess: recipe.target.privateIp === null ? null : { health: healthRes.witness, schema: schemaRes.witness }
    },
    scans: {
      supplyChain: {
        tool: {
          name: csTool.name,
          version: csTool.version,
          ...(csTool.expectedSha256 ? { binarySha256: csTool.expectedSha256 } : {})
        },
        target: imageRef,
        status: csParsed.status,
        exitCode: csRun.code,
        reportDigest: csDigest,
        findingsCount: csParsed.findingsCount,
        findings: csParsed.findings
      },
      dast: {
        tool: {
          name: dastTool.name,
          version: dastTool.version,
          ...(dastTool.expectedSha256 ? { binarySha256: dastTool.expectedSha256 } : {})
        },
        target: targetUrl,
        status: dastParsed.status,
        exitCode: dastRun.code,
        reportDigest: dastDigest,
        alertsCount: dastParsed.alertsCount,
        alerts: dastParsed.alerts
      }
    },
    overallStatus,
    observedAt: new Date().toISOString()
  };

  reportBuffer = Buffer.from(JSON.stringify(report) + '\n', 'utf8');
  requireCondition(reportBuffer.length <= 131072, 'Report exceeded 128KB limit');

  const outputFile = 'liftoff-staging-security.json';
  const handle = await open(outputFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await handle.writeFile(reportBuffer);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (overallStatus !== 'passed') {
    process.stderr.write('Staging scanner policy threshold exceeded; inspect the bounded sanitized report.\n');
    process.exitCode = 2;
  }
} catch (error) {
  failed = true;
  prerequisiteError = error;
} finally {
  registryToken = null;
  if (owned) {
    const stat = await lstat(owned);
    requireCondition(stat.isDirectory() && !stat.isSymbolicLink() && await realpath(owned) === owned);
    await rm(owned,{recursive:true});
  }
}

if (failed) {
  process.stderr.write('Staging security observation failed at stage ' + stage + '; diagnostics withheld.\n');
  process.exitCode = 1;
}
`;

/**
 * Delivers the program chunked into environment variables to fit Actions 21,000 char step limits.
 * Program integrity is verified via SHA-256 before evaluation.
 */
export function stagingSecurityWorkflowProgramDelivery(): { env: Record<string, string>; run: string } {
  const chunks = stagingSecurityWorkflowProgram.match(/[\s\S]{1,16000}/gu) || [stagingSecurityWorkflowProgram];
  const env = Object.fromEntries(chunks.map((chunk, index) => [`LIFTOFF_STAGING_SECURITY_PROGRAM_${index}`, chunk]));
  const names = Object.keys(env);
  const expected = createHash('sha256').update(stagingSecurityWorkflowProgram).digest('hex');
  return {
    env,
    run: `node --input-type=module <<'LIFTOFF_STAGING_SECURITY_PROGRAM'\n` +
      `import { createHash } from 'node:crypto';\n` +
      `try {\n` +
      `  const names = ${JSON.stringify(names)};\n` +
      `  const program = names.map(name => process.env[name] ?? '').join('');\n` +
      `  for (const name of names) delete process.env[name];\n` +
      `  if (createHash('sha256').update(program).digest('hex') !== '${expected}') throw new Error('Program identity mismatch.');\n` +
      `  await import('data:text/javascript;base64,' + Buffer.from(program).toString('base64'));\n` +
      `} catch { process.stderr.write('Staging security program identity or execution failed; diagnostics withheld.\\n'); process.exitCode = 1; }\n` +
      `LIFTOFF_STAGING_SECURITY_PROGRAM\n`
  };
}
