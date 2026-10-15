import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { observeProjectGitMetadata, gitConfigNullFile } from './adapters/assessment/live.js';
import { inspectModernLocalRuntime, planModernLocalRuntime } from './application/governance/modern-local-inputs.js';
import { projectCatalog } from './application/project/catalog.js';
import { parseProjectManifest } from './application/project/manifest.js';
import { resolveModernManifestSourceContext } from './application/project/source-context.js';
import { canonicalSha256 } from './domain/governance/activation/canonical-json.js';
import { freezeModernValue } from './domain/governance/activation/modern-graph.js';
import { capturedFileBytes } from './domain/governance/activation/modern-local-inputs.js';
import type { ModernLocalSnapshot } from './domain/governance/activation/modern-local-inputs.js';
import { copyModernLocalData } from './domain/governance/activation/modern-local-inputs.js';
import { createSource5WorkflowContext } from './governance-activation/workflow-source5-context.js';
import { workflowGitCommand, workflowGitOptions } from './governance-activation/workflow-binding.js';
import { NodeCommandRunner } from './process-runner.js';
import type { CommandResult } from './process-runner.js';

export const workflowContextValidators = Object.freeze([
  'source-integrity', 'backend-tests', 'worker-tests', 'frontend-build', 'framework-source'
] as const);
export type WorkflowContextValidator = typeof workflowContextValidators[number];
export interface WorkflowContextValidatorRequest {
  readonly validator: WorkflowContextValidator;
  readonly sourceSha: string;
}
export interface WorkflowContextValidatorReport {
  readonly validator: WorkflowContextValidator;
  readonly sourceSha: string;
  readonly status: 'passed' | 'failed' | 'blocked';
  readonly code: string;
  readonly message: string;
  readonly graphHash: string | null;
  readonly inputDigest: string | null;
  readonly workloadExecution: boolean;
  readonly executionBoundary: 'not-a-sandbox';
  readonly providerAccess: 'not-authorized-or-established-by-validator';
  readonly phaseProof: 'not-issued';
  readonly retainedExecutionDirectory: string | null;
  readonly command: null | {
    readonly status: number | null;
    readonly signal: string | null;
    readonly timedOut: boolean;
    readonly outputLimitExceeded: boolean;
    readonly processTreeSettled: boolean;
    readonly stdoutDigest: string;
    readonly stderrDigest: string;
  };
}

class ValidatorRefusal extends Error {
  constructor(readonly code: string, message: string, readonly status: 'failed' | 'blocked' = 'blocked') {
    super(message);
  }
}

function readRequest(value: WorkflowContextValidatorRequest): WorkflowContextValidatorRequest {
  value = copyModernLocalData(value);
  if (Object.keys(value).sort().join(',') !== 'sourceSha,validator' ||
    !workflowContextValidators.includes(value.validator) || typeof value.sourceSha !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(value.sourceSha)) {
    throw new ValidatorRefusal('validator-request', 'A validator requires one supported literal subject and its exact full source commit.');
  }
  return value;
}

export function parseWorkflowContextValidatorArgs(argv: readonly string[]): WorkflowContextValidatorRequest {
  if (argv.length !== 4 || argv[0] !== '--validator' || argv[2] !== '--source-sha') {
    throw new ValidatorRefusal('validator-arguments', 'Use exactly --validator <subject> --source-sha <full-commit>; arbitrary commands, paths and extra options are unsupported.');
  }
  const validator = workflowContextValidators.find(value => value === argv[1]);
  if (!validator) throw new ValidatorRefusal('validator-subject', 'The requested validator has no release-owned executable body.');
  return readRequest({ validator, sourceSha: argv[3]! });
}

function completed(result: CommandResult): boolean {
  return result.status === 0 && result.signal === null && !result.timedOut && !result.outputLimitExceeded &&
    !result.aborted && !result.errorCode && result.processTreeSettled === true;
}

async function assertCommittedInputs(root: string, snapshot: ModernLocalSnapshot, sourceSha: string,
  managedPaths: readonly string[], componentRoots: readonly string[]): Promise<string> {
  const options = workflowGitOptions(root, 10_000);
  const env: NodeJS.ProcessEnv = { ...options.env };
  for (const key of Object.keys(process.env)) if (key.toUpperCase().startsWith('GIT_')) env[key] = undefined;
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitConfigNullFile(),
    GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
  const result = await new NodeCommandRunner().run(
    workflowGitCommand(['ls-tree', '-r', '--full-tree', '-z', sourceSha]),
    { ...options, env, ensureProcessTreeSettled: true });
  if (!completed(result) || result.stdout.length && !result.stdout.endsWith('\0')) {
    throw new ValidatorRefusal('validator-source-tree', 'The complete bounded immutable source tree was not observed.');
  }
  const blobs = new Map<string, { mode: string; digest: string }>();
  for (const entry of result.stdout.split('\0').filter(Boolean)) {
    const match = /^([0-7]{6}) (?:blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/u.exec(entry);
    if (!match || blobs.has(match[3]!)) {
      throw new ValidatorRefusal('validator-source-tree', 'Source tree membership is malformed or ambiguous.');
    }
    blobs.set(match[3]!, { mode: match[1]!, digest: match[2]! });
  }
  const files = snapshot.files.filter(file => file.scope === 'application' ||
    file.pathParts.join('/') === 'liftoff.manifest.json' || managedPaths.includes(file.pathParts.join('/')));
  const selectedPaths = new Set(files.map(file => file.pathParts.join('/')));
  for (const name of blobs.keys()) {
    if (componentRoots.some(root => name.startsWith(`${root}/`)) && !selectedPaths.has(name)) {
      throw new ValidatorRefusal('validator-source-membership',
        'A committed selected component member was deleted, excluded or omitted from the observed source closure.', 'failed');
    }
  }
  for (const file of files) {
    const name = file.pathParts.join('/'), blob = blobs.get(name), bytes = capturedFileBytes(file);
    if (bytes === undefined) {
      if (!blob) continue;
    } else {
      const digest = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      const mode = file.mode! & 0o111 ? '100755' : '100644';
      if (blob?.digest === digest && blob.mode === mode) continue;
    }
    throw new ValidatorRefusal('validator-source-mismatch',
      'Selected input bytes, absence or executable mode do not match the exact reviewed commit.', 'failed');
  }
  return canonicalSha256(files.map(file => ({
    pathParts: file.pathParts, digest: file.digest, mode: file.mode
  })));
}

/** Explicit runner execution, not a plan reader, host sandbox, approval issuer or provider proof producer. */
export async function executeWorkflowContextValidator(
  projectRoot: string, request: WorkflowContextValidatorRequest
): Promise<WorkflowContextValidatorReport> {
  request = readRequest(request);
  let graphHash: string | null = null, inputDigest: string | null = null;
  let workloadExecution = false;
  let retainedExecutionDirectory: string | null = null;
  let command: WorkflowContextValidatorReport['command'] = null;
  const report = (status: WorkflowContextValidatorReport['status'], code: string, message: string) =>
    freezeModernValue({ ...request, status, code, message, graphHash, inputDigest, workloadExecution,
      executionBoundary: 'not-a-sandbox' as const,
      providerAccess: 'not-authorized-or-established-by-validator' as const,
      phaseProof: 'not-issued' as const, retainedExecutionDirectory, command });
  try {
    const runner = new NodeCommandRunner();
    const before = await observeProjectGitMetadata(projectRoot, runner);
    if (!before.facts.isRepository || before.facts.head !== request.sourceSha || before.facts.originState !== 'verified') {
      throw new ValidatorRefusal('validator-source-binding',
        'Validation requires the exact Git root/HEAD and one matching credential-free GitHub origin.', 'failed');
    }
    const observed = await inspectModernLocalRuntime(projectRoot);
    const planned = await planModernLocalRuntime(observed);
    const local = planned.localPlan;
    if (observed.status !== 'observed' || !local || local.inspection.status !== 'modern-observed' ||
      local.context?.kind !== 'governed') {
      throw new ValidatorRefusal('validator-source-unavailable', 'The complete selected modern governed source could not be interpreted.');
    }
    const manifestFile = local.inspection.snapshot.files.find(file => file.pathParts.join('/') === 'liftoff.manifest.json');
    const manifestBytes = manifestFile && capturedFileBytes(manifestFile);
    if (!manifestBytes) throw new ValidatorRefusal('validator-manifest', 'The selected source manifest is absent.');
    const manifest = parseProjectManifest(JSON.parse(manifestBytes.toString('utf8')));
    if (manifest.artifactVersion !== 8 || manifest.governance.profile === 'none') {
      throw new ValidatorRefusal('validator-source-family', 'Readable legacy or governance-none source cannot select the current5 validator.');
    }
    const source = resolveModernManifestSourceContext(manifest);
    const context = createSource5WorkflowContext(projectCatalog, {
      recordedIdentity: manifest.governance.activationIdentity, profile: manifest.governance.profile,
      policyVersion: manifest.governance.policyVersion, selection: { ...source.selection, profile: manifest.governance.profile },
      pluginResolutionDigest: source.plugins.resolutionDigest,
      activeLayoutDigest: manifest.governance.activationIdentity.activeLayoutDigest
    });
    graphHash = context.records.identity.phaseGraphHash;
    inputDigest = local.baselineDigest;
    const consistency = local.checks.find(check => check.id === 'source-consistency');
    const selected = request.validator === 'source-integrity' ? consistency :
      local.checks.find(check => check.id === request.validator);
    if (consistency?.status !== 'planned' || selected?.status !== 'planned') {
      throw new ValidatorRefusal('validator-inputs',
        'The actual selected validator input closure is incomplete, unsupported or inapplicable; no check was substituted.');
    }
    const managedPaths = manifest.managedArtifacts.map(file => file.pathParts.join('/'));
    const componentRoots = source.activeLayout.bindings.filter(binding => binding.kind === 'component')
      .map(binding => binding.pathParts.join('/'));
    const originalInputs = await assertCommittedInputs(projectRoot, local.inspection.snapshot,
      request.sourceSha, managedPaths, componentRoots);
    if (selected.command) {
      const home = await mkdtemp(path.join(os.tmpdir(), 'liftoff-workflow-validator-'));
      let settled = false;
      let commandFailed = false;
      retainedExecutionDirectory = home;
      try {
        const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
        for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT', 'TMPDIR', 'TEMP', 'TMP']) {
          if (process.env[key] !== undefined) env[key] = process.env[key];
        }
        Object.assign(env, selected.env, {
          HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'localappdata'),
          XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'),
          XDG_DATA_HOME: path.join(home, 'data'), CI: 'true', LANG: 'C', LC_ALL: 'C',
          npm_config_userconfig: path.join(home, 'npmrc'), npm_config_globalconfig: path.join(home, 'global-npmrc'),
          npm_config_cache: path.join(home, 'npm-cache')
        });
        const result = await runner.run(selected.command, {
          cwd: path.join(projectRoot, ...selected.cwdPathParts), env, timeoutMs: 180_000,
          maxOutputBytes: 1024 * 1024, ensureProcessTreeSettled: true, stream: false
        });
        workloadExecution = result.processSpawned === true;
        settled = result.processTreeSettled === true;
        command = {
          status: result.status, signal: result.signal, timedOut: result.timedOut,
          outputLimitExceeded: result.outputLimitExceeded === true, processTreeSettled: result.processTreeSettled === true,
          stdoutDigest: canonicalSha256(result.stdout), stderrDigest: canonicalSha256(result.stderr)
        };
        commandFailed = !completed(result);
      } finally {
        if (settled) {
          try {
            await rm(home, { recursive: true, force: true });
          } catch {
            throw new ValidatorRefusal('validator-cleanup',
              'Settled validator execution could not remove its exact owned temporary home; the retained directory is not successful cleanup.');
          }
          retainedExecutionDirectory = null;
        }
      }
      if (commandFailed) {
        return report('failed', 'validator-command', 'The actual validator did not exit successfully with its original process tree settled; raw project output was withheld.');
      }
    } else if (request.validator !== 'source-integrity' && request.validator !== 'framework-source') {
      throw new ValidatorRefusal('validator-body', 'The selected context has no executable validator body.');
    }
    const after = await inspectModernLocalRuntime(projectRoot);
    if (after.status !== 'observed' || after.local.status !== 'modern-observed') {
      throw new ValidatorRefusal('validator-source-drift', 'Selected inputs became unavailable during validation.', 'failed');
    }
    const currentInputs = await assertCommittedInputs(projectRoot, after.local.snapshot,
      request.sourceSha, managedPaths, componentRoots);
    if (currentInputs !== originalInputs) {
      throw new ValidatorRefusal('validator-source-drift',
        'The exact selected source membership, bytes, absence or modes changed during validation.', 'failed');
    }
    const metadata = await observeProjectGitMetadata(projectRoot, runner);
    if (metadata.digest !== before.digest) {
      throw new ValidatorRefusal('validator-source-drift', 'The exact Git root, HEAD or repository binding changed during validation.', 'failed');
    }
    return report('passed', 'validator-passed', 'The selected real validator passed for its exact committed inputs; this result issues no phase or provider qualification.');
  } catch (error) {
    if (error instanceof ValidatorRefusal) return report(error.status, error.code, error.message);
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let request: WorkflowContextValidatorRequest | undefined;
  try {
    request = parseWorkflowContextValidatorArgs(process.argv.slice(2));
  } catch {
    process.stderr.write('Workflow validator refused unsupported or malformed arguments; no validation was performed.\n');
    process.exitCode = 2;
  }
  if (request) {
    try {
      const report = await executeWorkflowContextValidator(process.cwd(), request);
      process.stdout.write(`${JSON.stringify(report)}\n`);
      process.exitCode = report.status === 'passed' ? 0 : report.status === 'failed' ? 1 : 2;
    } catch {
      process.stderr.write('Workflow validator execution or readback failed. A runner command may already have executed; neither validation success nor phase qualification was issued.\n');
      process.exitCode = 2;
    }
  }
}
