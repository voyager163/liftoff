import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { devNull } from 'node:os';
import { promisify } from 'node:util';
import { digest, identifier, portableParts, record, sha, SecurityEvidenceError } from './evidence.ts';
import { securityWorkflowInvocation, verifiedPrExecutionIdentity, type VerifiedPrExecution } from './workflow-invocation.ts';

const runFile = promisify(execFile);
const registryPath = ['security', 'control-plane.json'];
const maximumBytes = 8 * 1024 * 1024;
type FileMode = '100644' | '100755' | '120000' | '160000';

export interface TreeEntry {
  pathParts: string[];
  mode: FileMode;
  object: string;
}

export interface AdmissionContext {
  repository: 'voyager163/liftoff';
  baseRef: 'develop' | 'main';
  baseCommit: string;
  headCommit: string;
  validatorDigest?: string;
  executionMode?: 'local' | 'hosted-pr';
  execution?: VerifiedPrExecution;
  now: Date;
}

export interface PolicyDataRegistration {
  id: string;
  adapter: string;
  pathParts: string[];
}

export interface PolicyRecord {
  findingKey: string;
  permissionDigest: string;
  kind: 'vulnerability' | 'secret';
  valid: boolean;
  allowsFinding: boolean;
  incident: 'none' | 'confirmed' | 'remediated';
  incidentHistory: string[];
}

export interface ParsedPolicyData {
  records: PolicyRecord[];
  diagnostics: string[];
}

export interface RawFinding {
  key: string;
  kind: 'vulnerability' | 'policy' | 'secret';
  confirmedUnremediated: boolean;
}

export interface AdmissionObservation {
  sourceCommit: string;
  runId: string;
  attempt: number;
  validatorDigest: string;
  policyDigest: string;
  protectedInputsDigest: string;
  analysisConfigurationDigest: string;
  coverageDigest: string;
  completedAt: string;
  execution: 'success' | 'failure' | 'skipped' | 'cancelled';
  integrity: 'success' | 'failure';
  functional: 'success' | 'failure';
  coverageComplete: boolean;
  findingPolicy: 'passed' | 'blocked' | 'unavailable';
  findings: RawFinding[];
  executionBindingDigest?: string;
}

export interface ExpectedObservation {
  sourceCommit: string;
  runId: string;
  attempt: number;
  reportDigest: string;
}

export interface PolicyAdapter {
  parse(source: string, observed: readonly RawFinding[], now: Date): ParsedPolicyData;
}

export interface AdmissionResult {
  kind: 'pull-request-admission';
  decision: 'normal-admitted' | 'maintenance-admitted' | 'blocked';
  findingPolicy: 'passed' | 'blocked';
  policyAdopted: false;
  publicationQualified: false;
  baseCommit: string;
  headCommit: string;
  basePolicyDigest: string;
  proposalDigest: string;
  changeSetDigest: string;
  validatorDigest: string;
  evidenceDigest: string;
  changes: number;
  protectedChanges: number;
  controlChanges: number;
  newFindings: number | null;
  reason: string;
  sourceMode: 'local-head-only' | 'verified-pr-tested-merge';
  testedCommit: string;
  testedTreeDigest: string;
  executionBindingDigest: string | null;
  hostedQualification: false;
}

interface LoadedBase {
  repositoryRoot: string;
  context: AdmissionContext & { validatorDigest: string };
  base: TreeEntry[];
  head: TreeEntry[];
  tested: TreeEntry[];
  testedCommit: string;
  testedProtected: string;
  execution: ReturnType<typeof verifiedPrExecutionIdentity> | null;
  registrations: PolicyDataRegistration[];
  baseData: Map<string, string>;
  headData: Map<string, string>;
  basePolicyDigest: string;
  proposalDigest: string;
  baseProtected: string;
  headProtected: string;
  controlPaths: Set<string>;
  readControlSource(parts: string[]): Promise<string>;
}

export interface AdoptedBaseHandle { readonly kind: 'independently-loaded-base'; }
const loadedBases = new WeakMap<AdoptedBaseHandle, LoadedBase>();

export function canonicalDigest(value: unknown): string {
  function encode(value: unknown, depth: number): string {
    if (depth > 32) throw new SecurityEvidenceError('admission-data-too-deep');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(item => encode(item, depth + 1)).join(',')}]`;
    if (value === undefined || typeof value !== 'object') throw new SecurityEvidenceError('invalid-admission-data');
    const item = value as Record<string, unknown>;
    return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${encode(item[key], depth + 1)}`).join(',')}}`;
  }
  return `sha256:${createHash('sha256').update(encode(value, 0)).digest('hex')}`;
}

function key(parts: readonly string[]): string { return portableParts(parts).join('/'); }

function parseRegistry(source: string) {
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new SecurityEvidenceError('invalid-control-registry-json'); }
  const registry = record(value, ['schemaVersion', 'repository', 'policyData', 'controlInputs', 'validatorInputs'], 'invalid-control-registry');
  if (registry.schemaVersion !== 1 || registry.repository !== 'voyager163/liftoff' ||
      !Array.isArray(registry.policyData) || registry.policyData.length === 0 || registry.policyData.length > 32) {
    throw new SecurityEvidenceError('invalid-control-registry');
  }
  const registrations = registry.policyData.map(value => {
    const item = record(value, ['id', 'adapter', 'pathParts'], 'invalid-policy-registration');
    return {
      id: identifier(item.id, 'invalid-policy-id'), adapter: identifier(item.adapter, 'invalid-policy-adapter'),
      pathParts: portableParts(item.pathParts)
    };
  });
  if (new Set(registrations.map(item => item.id)).size !== registrations.length ||
      new Set(registrations.map(item => key(item.pathParts).toLowerCase())).size !== registrations.length ||
      registrations.some(item => key(item.pathParts) === key(registryPath))) {
    throw new SecurityEvidenceError('duplicate-or-self-registering-policy');
  }
  const parsePaths = (value: unknown) => {
    if (!Array.isArray(value) || value.length === 0 || value.length > 200) throw new SecurityEvidenceError('invalid-control-inputs');
    const paths = value.map(portableParts);
    if (new Set(paths.map(parts => key(parts).toLowerCase())).size !== paths.length) throw new SecurityEvidenceError('duplicate-control-input');
    return paths;
  };
  const controlInputs = parsePaths(registry.controlInputs), validatorInputs = parsePaths(registry.validatorInputs);
  if (validatorInputs.some(parts => !controlInputs.some(input => key(input) === key(parts))) ||
      registrations.some(item => controlInputs.some(parts => key(parts) === key(item.pathParts)))) {
    throw new SecurityEvidenceError('invalid-control-data-boundary');
  }
  return { registrations, controlInputs, validatorInputs };
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const gitNull = process.platform === 'win32' ? 'NUL' : devNull;
  return {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: gitNull, GIT_CONFIG_GLOBAL: gitNull,
    GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0'
  };
}

export function admissionGitFailureMetadata(args: readonly string[], error: unknown) {
  const operation = args[0] === 'rev-parse' && args[1] === '--show-toplevel' ? 'root'
    : args[0] === 'rev-parse' && args[1] === '--is-shallow-repository' ? 'history'
      : args[0] === 'ls-tree' ? 'tree' : args[0] === 'cat-file' && args[1] === '-s' ? 'blob-size'
        : args[0] === 'cat-file' && args[1] === 'blob' ? 'blob-content' : 'unregistered';
  const value = error && typeof error === 'object' ? error : {};
  const code = 'code' in value ? value.code : null;
  const nativeCode = typeof code === 'number' && Number.isSafeInteger(code) && code >= 0 && code <= 255 ? code
    : typeof code === 'string' && ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'EINVAL', 'ETIMEDOUT', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes(code)
      ? code : 'unclassified';
  const stderr = 'stderr' in value && (typeof value.stderr === 'string' || Buffer.isBuffer(value.stderr))
    ? value.stderr.toString() : '';
  const reason = [
    ['unable to read config file', 'config-unreadable'],
    ['bad config line', 'config-invalid'],
    ['not a git repository', 'repository-unavailable'],
    ['detected dubious ownership', 'ownership-rejected'],
    ['unknown option', 'unsupported-option']
  ].find(([text]) => stderr.includes(text!))?.[1] ?? 'unclassified';
  return { operation, nativeCode, reason, timedOut: 'killed' in value && value.killed === true };
}

export async function loadAdoptedBase(
  repositoryRoot: string, context: AdmissionContext
): Promise<AdoptedBaseHandle> {
  if (context.repository !== 'voyager163/liftoff' || !['develop', 'main'].includes(context.baseRef) ||
      !Number.isFinite(context.now.getTime())) throw new SecurityEvidenceError('invalid-admission-context');
  sha(context.baseCommit); sha(context.headCommit);
  if (context.validatorDigest !== undefined) digest(context.validatorDigest);
  if (context.executionMode !== undefined && !['local', 'hosted-pr'].includes(context.executionMode) ||
      (context.executionMode === 'hosted-pr') !== (context.execution !== undefined)) {
    throw new SecurityEvidenceError('admission-hosted-execution-required');
  }
  const execution = context.execution ? verifiedPrExecutionIdentity(context.execution, context.now) : null;
  if (execution && (execution.invocation.baseSha !== context.baseCommit ||
      execution.invocation.pullRequestHeadSha !== context.headCommit || execution.baseRef !== context.baseRef)) {
    throw new SecurityEvidenceError('admission-tested-context-mismatch');
  }
  const root = await realpath(repositoryRoot);
  async function git(args: string[]): Promise<string> {
    try {
      const result = await runFile('git', [
        '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : devNull}`, ...args
      ], { cwd: root, env: gitEnvironment(), encoding: 'buffer', timeout: 30_000, maxBuffer: maximumBytes });
      if (result.stderr.length > 0) throw new SecurityEvidenceError('unexpected-git-diagnostics');
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(result.stdout);
    } catch (error) {
      if (error instanceof SecurityEvidenceError) throw error;
      throw Object.assign(new SecurityEvidenceError('admission-git-read-failed'),
        { diagnostic: admissionGitFailureMetadata(args, error) });
    }
  }
  if (await realpath((await git(['rev-parse', '--show-toplevel'])).trim()) !== root) {
    throw new SecurityEvidenceError('admission-root-mismatch');
  }
  if ((await git(['rev-parse', '--is-shallow-repository'])).trim() !== 'false') {
    throw new SecurityEvidenceError('incomplete-admission-history');
  }
  async function tree(commit: string): Promise<TreeEntry[]> {
    const entries = (await git(['ls-tree', '-r', '-z', '--full-tree', commit])).split('\0').filter(Boolean).map(line => {
      const separator = line.indexOf('\t');
      if (separator === -1) throw new SecurityEvidenceError('invalid-git-tree');
      const [mode, type, object] = line.slice(0, separator).split(' ');
      if (!['100644', '100755', '120000', '160000'].includes(mode ?? '') ||
          (type !== 'blob' && type !== 'commit')) throw new SecurityEvidenceError('unsupported-git-tree-entry');
      return { pathParts: portableParts(line.slice(separator + 1).split('/')), mode: mode as FileMode, object: sha(object) };
    });
    if (entries.length === 0 || entries.length > 100_000 ||
        new Set(entries.map(entry => key(entry.pathParts).toLowerCase())).size !== entries.length) {
      throw new SecurityEvidenceError('invalid-or-aliased-git-tree');
    }
    return entries.sort((a, b) => key(a.pathParts) < key(b.pathParts) ? -1 : key(a.pathParts) > key(b.pathParts) ? 1 : 0);
  }
  async function blob(tree: TreeEntry[], parts: string[]): Promise<string> {
    const entry = tree.find(entry => key(entry.pathParts) === key(parts));
    if (!entry || entry.mode !== '100644') throw new SecurityEvidenceError('policy-data-not-regular');
    const size = Number((await git(['cat-file', '-s', entry.object])).trim());
    if (!Number.isSafeInteger(size) || size < 1 || size > 256 * 1024) throw new SecurityEvidenceError('policy-data-size');
    return git(['cat-file', 'blob', entry.object]);
  }
  const [base, head] = await Promise.all([tree(context.baseCommit), tree(context.headCommit)]);
  const testedCommit = execution?.invocation.sourceSha ?? context.headCommit;
  let tested = head;
  if (execution) {
    const parents = (await git(['show', '--no-patch', '--format=%P', testedCommit])).trim().split(' ');
    securityWorkflowInvocation({
      GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: execution.invocation.repository,
      GITHUB_EVENT_NAME: execution.invocation.event, GITHUB_SHA: testedCommit,
      GITHUB_WORKFLOW_SHA: execution.invocation.workflowSha, GITHUB_REF: execution.invocation.ref,
      GITHUB_BASE_REF: execution.baseRef, GITHUB_RUN_ID: execution.invocation.runId,
      GITHUB_RUN_ATTEMPT: String(execution.invocation.attempt),
      LIFTOFF_PR_BASE_SHA: context.baseCommit, LIFTOFF_PR_HEAD_SHA: context.headCommit
    }, { checkoutSha: testedCommit, mergeParents: parents });
    if ((await git(['rev-parse', `${testedCommit}^{tree}`])).trim() !== execution.tree) {
      throw new SecurityEvidenceError('admission-tested-tree-mismatch');
    }
    tested = await tree(testedCommit);
  }
  const registrySource = await blob(base, registryPath);
  const { registrations, controlInputs, validatorInputs } = parseRegistry(registrySource);
  if (execution && !controlInputs.some(parts => key(parts) === execution.workflow)) {
    throw new SecurityEvidenceError('admission-unregistered-tested-workflow');
  }
  if (execution && !validatorInputs.some(parts => key(parts) === 'scripts/repository-security/workflow-invocation.ts')) {
    throw new SecurityEvidenceError('admission-unregistered-execution-validator');
  }
  const controlEntries = controlInputs.map(parts => {
    const entry = base.find(entry => key(entry.pathParts) === key(parts));
    if (!entry || !['100644', '100755'].includes(entry.mode)) throw new SecurityEvidenceError('missing-control-input');
    return entry;
  });
  const validatorDigest = canonicalDigest(validatorInputs.map(parts =>
    controlEntries.find(entry => key(entry.pathParts) === key(parts))));
  if (context.validatorDigest !== undefined && context.validatorDigest !== validatorDigest) {
    throw new SecurityEvidenceError('validator-source-mismatch');
  }
  const baseData = new Map<string, string>(), headData = new Map<string, string>();
  for (const registration of registrations) {
    baseData.set(registration.id, await blob(base, registration.pathParts));
    const entry = head.find(entry => key(entry.pathParts) === key(registration.pathParts));
    if (entry?.mode === '100644') headData.set(registration.id, await blob(head, registration.pathParts));
    if (execution && headData.has(registration.id) &&
        await blob(tested, registration.pathParts) !== headData.get(registration.id)) {
      throw new SecurityEvidenceError('admission-tested-policy-proposal-mismatch');
    }
  }
  const policyPaths = new Set(registrations.map(item => key(item.pathParts)));
  const handle: AdoptedBaseHandle = Object.freeze({ kind: 'independently-loaded-base' });
  loadedBases.set(handle, {
    repositoryRoot: root,
    context: { ...context, validatorDigest, now: new Date(context.now) }, base, head, tested, testedCommit, execution,
    testedProtected: canonicalDigest(tested.filter(entry => !policyPaths.has(key(entry.pathParts)))),
    registrations, baseData, headData,
    basePolicyDigest: canonicalDigest({ registrySource, data: [...baseData] }),
    proposalDigest: canonicalDigest([...headData]),
    baseProtected: canonicalDigest(base.filter(entry => !policyPaths.has(key(entry.pathParts)))),
    headProtected: canonicalDigest(head.filter(entry => !policyPaths.has(key(entry.pathParts)))),
    controlPaths: new Set([...controlInputs.map(key), key(registryPath)]),
    readControlSource: parts => blob(base, parts)
  });
  return handle;
}

export function adoptedBaseIdentity(handle: AdoptedBaseHandle) {
  const base = loadedBases.get(handle);
  if (!base) throw new SecurityEvidenceError('unverified-adopted-base');
  return {
    baseCommit: base.context.baseCommit, headCommit: base.context.headCommit,
    testedCommit: base.testedCommit, testedProtectedInputsDigest: base.testedProtected,
    sourceMode: base.execution ? 'verified-pr-tested-merge' as const : 'local-head-only' as const,
    executionBindingDigest: base.execution ? canonicalDigest(base.execution) : null,
    policyDigest: base.basePolicyDigest, proposalDigest: base.proposalDigest,
    baseProtectedInputsDigest: base.baseProtected, headProtectedInputsDigest: base.headProtected,
    validatorDigest: base.context.validatorDigest
  };
}

export function readAdoptedPolicyData(handle: AdoptedBaseHandle, id: string): string {
  const base = loadedBases.get(handle);
  if (!base) throw new SecurityEvidenceError('unverified-adopted-base');
  const source = base.baseData.get(id);
  if (source === undefined) throw new SecurityEvidenceError('unregistered-policy-data');
  return source;
}

export function adoptedSourceSnapshot(handle: AdoptedBaseHandle, side: 'base' | 'candidate') {
  const base = loadedBases.get(handle);
  if (!base) throw new SecurityEvidenceError('unverified-adopted-base');
  if (side !== 'base' && side !== 'candidate') throw new SecurityEvidenceError('invalid-admission-side');
  return {
    repositoryRoot: base.repositoryRoot,
    sourceRef: side === 'candidate' && base.execution ? base.execution.invocation.ref : `refs/heads/${base.context.baseRef}`,
    sourceCommit: side === 'base' ? base.context.baseCommit : base.testedCommit,
    treeDigest: canonicalDigest(side === 'base' ? base.base : base.tested),
    protectedInputsDigest: side === 'base' ? base.baseProtected : base.testedProtected
  };
}

export async function readAdoptedControl(handle: AdoptedBaseHandle, parts: string[]): Promise<string> {
  const base = loadedBases.get(handle);
  if (!base) throw new SecurityEvidenceError('unverified-adopted-base');
  if (!base.controlPaths.has(key(parts))) throw new SecurityEvidenceError('unregistered-control-input');
  return base.readControlSource(parts);
}

function validateObservation(
  input: AdmissionObservation, expected: ExpectedObservation, base: LoadedBase, protectedDigest: string,
  requireSuccess = true, testedSource = false
): AdmissionObservation {
  record(input, [
    'sourceCommit', 'runId', 'attempt', 'validatorDigest', 'policyDigest', 'protectedInputsDigest',
    'analysisConfigurationDigest', 'coverageDigest', 'completedAt', 'execution', 'integrity', 'functional',
    'coverageComplete', 'findingPolicy', 'findings', ...(testedSource && base.execution ? ['executionBindingDigest'] : [])
  ], 'invalid-admission-observation');
  if (testedSource && base.execution && (
    input.executionBindingDigest !== canonicalDigest(base.execution) ||
    input.runId !== base.execution.invocation.runId || input.attempt !== base.execution.invocation.attempt
  )) throw new SecurityEvidenceError('admission-execution-binding-mismatch');
  if (canonicalDigest(input) !== digest(expected.reportDigest) || sha(input.sourceCommit) !== sha(expected.sourceCommit) ||
      input.runId !== expected.runId || input.attempt !== expected.attempt ||
      typeof input.runId !== 'string' || input.runId.length > 30 || !/^[1-9][0-9]*$/.test(input.runId) ||
      !Number.isSafeInteger(input.attempt) || input.attempt < 1 || input.attempt > 1_000_000 ||
      digest(input.validatorDigest) !== base.context.validatorDigest ||
      digest(input.policyDigest) !== base.basePolicyDigest ||
      digest(input.protectedInputsDigest) !== protectedDigest) throw new SecurityEvidenceError('admission-provenance-mismatch');
  digest(input.analysisConfigurationDigest); digest(input.coverageDigest);
  const completed = Date.parse(input.completedAt), now = base.context.now.getTime();
  if (!Number.isFinite(completed) || new Date(completed).toISOString() !== input.completedAt ||
      completed > now || now - completed > 24 * 60 * 60 * 1000) throw new SecurityEvidenceError('stale-admission-observation');
  if (!['success', 'failure', 'skipped', 'cancelled'].includes(input.execution) ||
      !['success', 'failure'].includes(input.integrity) || !['success', 'failure'].includes(input.functional) ||
      typeof input.coverageComplete !== 'boolean' || !['passed', 'blocked', 'unavailable'].includes(input.findingPolicy) ||
      requireSuccess && (input.execution !== 'success' || input.integrity !== 'success' || input.functional !== 'success' ||
        input.coverageComplete !== true || input.findingPolicy === 'unavailable') ||
      !Array.isArray(input.findings) || input.findings.length > 20_000) {
    throw new SecurityEvidenceError('incomplete-admission-observation');
  }
  for (const value of input.findings) {
    const finding = record(value, ['key', 'kind', 'confirmedUnremediated'], 'invalid-raw-finding');
    digest(finding.key);
    if (!['vulnerability', 'policy', 'secret'].includes(String(finding.kind)) ||
        typeof finding.confirmedUnremediated !== 'boolean' ||
        finding.confirmedUnremediated && finding.kind !== 'secret') throw new SecurityEvidenceError('invalid-raw-finding');
  }
  if (new Set(input.findings.map(item => item.key)).size !== input.findings.length) throw new SecurityEvidenceError('duplicate-raw-finding');
  return input;
}

function parseData(
  adapter: PolicyAdapter, source: string, findings: readonly RawFinding[], now: Date
): ParsedPolicyData {
  const data = adapter.parse(source, findings, now);
  if (!Array.isArray(data.records) || data.records.length > 10_000 || !Array.isArray(data.diagnostics) ||
      new Set(data.records.map(item => item.findingKey)).size !== data.records.length) {
    throw new SecurityEvidenceError('invalid-admission-policy-data');
  }
  for (const item of data.records) {
    record(item, ['findingKey', 'permissionDigest', 'kind', 'valid', 'allowsFinding', 'incident', 'incidentHistory'], 'invalid-policy-record');
    digest(item.findingKey); digest(item.permissionDigest);
    if (!['vulnerability', 'secret'].includes(item.kind) || typeof item.valid !== 'boolean' ||
        typeof item.allowsFinding !== 'boolean' || item.allowsFinding && !item.valid ||
        !['none', 'confirmed', 'remediated'].includes(item.incident) ||
        item.kind !== 'secret' && item.incident !== 'none' ||
        !Array.isArray(item.incidentHistory) || item.incidentHistory.length > 1000 ||
        item.incident !== 'none' && item.incidentHistory.length === 0 ||
        new Set(item.incidentHistory).size !== item.incidentHistory.length) throw new SecurityEvidenceError('invalid-policy-record');
    for (const value of item.incidentHistory) digest(value);
  }
  return data;
}

export function evaluateAdmission(
  handle: AdoptedBaseHandle,
  observations: { base: AdmissionObservation | null; candidate: AdmissionObservation },
  expected: { base: ExpectedObservation | null; candidate: ExpectedObservation },
  adapters: ReadonlyMap<string, PolicyAdapter>
): AdmissionResult {
  const loaded = loadedBases.get(handle);
  if (!loaded) throw new SecurityEvidenceError('unverified-adopted-base');
  if ((observations.base === null) !== (expected.base === null) ||
      expected.base !== null && expected.base.sourceCommit !== loaded.context.baseCommit ||
      expected.candidate.sourceCommit !== loaded.testedCommit) {
    throw new SecurityEvidenceError('admission-commit-mismatch');
  }
  const baseTree = new Map(loaded.base.map(entry => [key(entry.pathParts), entry]));
  const headTree = new Map(loaded.head.map(entry => [key(entry.pathParts), entry]));
  const paths = new Set([...baseTree.keys(), ...headTree.keys()]);
  const changes = [...paths].sort().flatMap(path => {
    const before = baseTree.get(path), after = headTree.get(path);
    return before?.object === after?.object && before?.mode === after?.mode ? [] : [{ path, before: before ?? null, after: after ?? null }];
  });
  const policyPaths = new Set(loaded.registrations.map(item => key(item.pathParts)));
  const maintenance = changes.length > 0 && changes.every(change =>
    policyPaths.has(change.path) && change.before?.mode === '100644' && change.after?.mode === '100644') &&
    loaded.baseProtected === loaded.headProtected;
  if (maintenance && loaded.baseProtected !== loaded.testedProtected) {
    throw new SecurityEvidenceError('admission-maintenance-tested-inputs-changed');
  }
  if (maintenance && observations.base === null) throw new SecurityEvidenceError('maintenance-needs-complete-base-observation');
  const base = observations.base !== null && expected.base !== null
    ? validateObservation(observations.base, expected.base, loaded, loaded.baseProtected, maintenance) : null;
  const candidate = validateObservation(observations.candidate, expected.candidate, loaded, loaded.testedProtected, true, true);
  const comparableBase = base?.execution === 'success' && base.coverageComplete && base.integrity === 'success' ? base : null;
  const baseFindings = new Map((comparableBase?.findings ?? []).map(finding => [finding.key, finding]));
  const candidateFindings = new Map(candidate.findings.map(finding => [finding.key, finding]));
  const newFindings = candidate.findings.filter(finding => baseFindings.get(finding.key)?.kind !== finding.kind);
  const result: AdmissionResult = {
    kind: 'pull-request-admission', decision: 'blocked', findingPolicy: candidate.findingPolicy === 'passed' ? 'passed' : 'blocked',
    policyAdopted: false, publicationQualified: false,
    baseCommit: loaded.context.baseCommit, headCommit: loaded.context.headCommit,
    basePolicyDigest: loaded.basePolicyDigest, proposalDigest: loaded.proposalDigest,
    changeSetDigest: canonicalDigest(changes), validatorDigest: loaded.context.validatorDigest,
    evidenceDigest: canonicalDigest(expected), changes: changes.length,
    protectedChanges: changes.filter(change => !loaded.registrations.some(item => key(item.pathParts) === change.path)).length,
    controlChanges: changes.filter(change => loaded.controlPaths.has(change.path)).length,
    newFindings: comparableBase ? newFindings.length : null,
    sourceMode: loaded.execution ? 'verified-pr-tested-merge' : 'local-head-only',
    testedCommit: loaded.testedCommit, testedTreeDigest: canonicalDigest(loaded.tested),
    executionBindingDigest: loaded.execution ? canonicalDigest(loaded.execution) : null,
    hostedQualification: false,
    reason: 'actual-findings-block'
  };
  if (candidate.findings.some(item => item.confirmedUnremediated) ||
      maintenance && base?.findings.some(item => item.confirmedUnremediated)) {
    return { ...result, reason: 'confirmed-unremediated-exposure' };
  }
  let newAuthority = false;
  for (const registration of loaded.registrations) {
    const adapter = adapters.get(registration.adapter);
    const beforeSource = loaded.baseData.get(registration.id), afterSource = loaded.headData.get(registration.id);
    if (!adapter || beforeSource === undefined || afterSource === undefined) return { ...result, reason: 'unknown-or-removed-policy-data' };
    const before = parseData(adapter, beforeSource, comparableBase?.findings ?? candidate.findings, loaded.context.now);
    const after = parseData(adapter, afterSource, maintenance ? base!.findings : candidate.findings, loaded.context.now);
    const beforeRecords = new Map(before.records.map(record => [record.findingKey, record]));
    const afterRecords = new Map(after.records.map(record => [record.findingKey, record]));
    for (const previous of before.records) {
      const current = afterRecords.get(previous.findingKey);
      if (previous.incident !== 'none' && (!current || current.incident === 'none' ||
          previous.incidentHistory.some(value => !current.incidentHistory.includes(value)))) {
        return { ...result, reason: 'incident-record-removal-or-change' };
      }
      if (!current && !maintenance && candidateFindings.has(previous.findingKey)) {
        return { ...result, reason: 'unresolved-waiver-retirement' };
      }
    }
    for (const current of after.records) {
      const previous = beforeRecords.get(current.findingKey);
      if (previous?.permissionDigest === current.permissionDigest) continue;
      newAuthority = true;
      const observed = baseFindings.get(current.findingKey);
      if (!current.valid || !observed || observed.confirmedUnremediated ||
          (current.kind === 'secret') !== (observed.kind === 'secret')) {
        return { ...result, reason: 'invalid-new-or-expanded-policy-record' };
      }
    }
    if (!maintenance && after.diagnostics.length > 0) return { ...result, reason: 'remaining-policy-diagnostics' };
  }
  if (maintenance) {
    if (!base || base.analysisConfigurationDigest !== candidate.analysisConfigurationDigest ||
        base.coverageDigest !== candidate.coverageDigest || newFindings.length > 0 ||
        canonicalDigest([...base.findings].sort((a, b) => a.key < b.key ? -1 : 1)) !==
          canonicalDigest([...candidate.findings].sort((a, b) => a.key < b.key ? -1 : 1))) {
      return { ...result, reason: 'incompatible-maintenance-observations' };
    }
    return { ...result, decision: 'maintenance-admitted', reason: 'exact-unadopted-policy-proposal' };
  }
  if (newAuthority) return { ...result, reason: 'candidate-grants-cannot-authorize-normal-change' };
  if (candidate.findingPolicy === 'passed') return { ...result, decision: 'normal-admitted', reason: 'actual-finding-policy-passed' };
  return result;
}

export function revalidateAdmission(
  previous: AdmissionResult, currentBase: AdoptedBaseHandle,
  observations: { base: AdmissionObservation | null; candidate: AdmissionObservation },
  expected: { base: ExpectedObservation | null; candidate: ExpectedObservation },
  adapters: ReadonlyMap<string, PolicyAdapter>
): AdmissionResult {
  const current = evaluateAdmission(currentBase, observations, expected, adapters);
  if (canonicalDigest(previous) !== canonicalDigest(current)) throw new SecurityEvidenceError('stale-admission-decision');
  return current;
}

export function rejectAdmissionAsPublicationEvidence(value: unknown): void {
  if (value !== null && typeof value === 'object' && 'kind' in value && value.kind === 'pull-request-admission') {
    throw new SecurityEvidenceError('admission-is-not-publication-qualification');
  }
  throw new SecurityEvidenceError('publication-qualification-required');
}
