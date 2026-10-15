import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { observeProjectGitMetadata, gitConfigNullFile } from './adapters/assessment/live.js';
import { assertWorkspaceDirectorySnapshot, captureWorkspaceDirectoryChain } from './adapters/filesystem/repair-workspaces.js';
import { readBoundProjectFileSnapshot } from './adapters/filesystem/bound-project-files.js';
import { assertModernLocalToolsCurrent, observeModernLocalTools } from './adapters/process/modern-local-tools.js';
import { inspectModernLocalRuntime, planModernLocalRuntime } from './application/governance/modern-local-inputs.js';
import { RepairWorkspaceError } from './application/repair/workspaces-types.js';
import { projectCatalog } from './application/project/catalog.js';
import { parseProjectManifest } from './application/project/manifest.js';
import { resolveModernManifestSourceContext } from './application/project/source-context.js';
import { canonicalSha256, isRecord } from './domain/governance/activation/canonical-json.js';
import { freezeModernValue } from './domain/governance/activation/modern-graph.js';
import { capturedFileBytes } from './domain/governance/activation/modern-local-inputs.js';
import type { ModernLocalSnapshot } from './domain/governance/activation/modern-local-inputs.js';
import { copyModernLocalData, localPath, modernLocalBounds, ModernLocalInputError } from './domain/governance/activation/modern-local-inputs.js';
import { actionReferences, pinnedActions } from './domain/governance/assessment/predicates.js';
import { parseAssessmentWorkflow } from './domain/governance/assessment/yaml.js';
import type { ParsedWorkflow } from './domain/governance/assessment/yaml.js';
import { AssessmentFiles, AssessmentInputError } from './governance-assessment/readers.js';
import { FileSystemError } from './domain/project/errors.js';
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

type ExecutableValidator = WorkflowContextValidator | 'compose-config';
type ExecutableValidatorReport<Validator extends ExecutableValidator> =
  Omit<WorkflowContextValidatorReport, 'validator'> & { readonly validator: Validator };
export type WorkflowComposeConfigValidatorReport = ExecutableValidatorReport<'compose-config'>;

class ValidatorRefusal extends Error {
  constructor(readonly code: string, message: string, readonly status: 'failed' | 'blocked' = 'blocked') {
    super(message);
  }
}

function isWorkspaceCleanupError(error: unknown): boolean {
  return error instanceof RepairWorkspaceError ||
    error instanceof Error && 'code' in error && typeof error.code === 'string' &&
      'syscall' in error && typeof error.syscall === 'string';
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

function validatorGitOptions(root: string, timeoutMs: number) {
  const options = workflowGitOptions(root, timeoutMs);
  const env: NodeJS.ProcessEnv = { ...options.env };
  for (const key of Object.keys(process.env)) if (key.toUpperCase().startsWith('GIT_')) env[key] = undefined;
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitConfigNullFile(),
    GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' });
  return { ...options, env, ensureProcessTreeSettled: true };
}

async function readCommittedTree(root: string, sourceSha: string, timeoutMs = 10_000) {
  const result = await new NodeCommandRunner().run(
    workflowGitCommand(['ls-tree', '-r', '--full-tree', '-z', sourceSha]),
    validatorGitOptions(root, timeoutMs));
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
  return blobs;
}

async function assertCommittedInputs(root: string, snapshot: ModernLocalSnapshot, sourceSha: string,
  managedPaths: readonly string[], componentRoots: readonly string[]): Promise<string> {
  const blobs = await readCommittedTree(root, sourceSha);
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

export type WorkflowActionReferenceValidatorReport = Omit<WorkflowContextValidatorReport, 'validator'> & {
  readonly validator: 'action-references';
};

/** Private committed-source policy body; no public selector, exception authority or project execution. */
export async function executeWorkflowActionReferenceValidator(
  projectRoot: string, sourceSha: string
): Promise<WorkflowActionReferenceValidatorReport> {
  const cutoff = performance.now() + 180_000;
  const initial = await executeWorkflowContextValidator(projectRoot, { validator: 'source-integrity', sourceSha });
  const inputs = new Map<string, { mode: string; digest: string }>();
  const report = (status: WorkflowContextValidatorReport['status'], code: string, message: string) =>
    freezeModernValue({ ...initial, validator: 'action-references' as const, status, code, message,
      inputDigest: initial.inputDigest === null ? null :
        canonicalSha256({ project: initial.inputDigest, actions: [...inputs].sort(([a], [b]) => a.localeCompare(b, 'en')) }) });
  if (initial.status !== 'passed') return report(initial.status, initial.code, initial.message);
  function remaining(): number {
    const value = cutoff - performance.now();
    if (value <= 0) throw new ValidatorRefusal('validator-actions-deadline',
      'The original bounded source observation expired; no successful action-reference result was issued.');
    return Math.min(10_000, value);
  }
  try {
    const root = await realpath(projectRoot);
    const tree = await readCommittedTree(root, sourceSha, remaining());
    remaining();
    const files = new AssessmentFiles(root);
    const paths = (await files.list(['.github', 'workflows'], ['.yml', '.yaml'])).map(parts => parts.join('/'));
    const committed = [...tree.keys()].filter(name => /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(name)).sort();
    if (!paths.length || paths.length > modernLocalBounds.files ||
      canonicalSha256([...paths].sort()) !== canonicalSha256(committed)) {
      throw new ValidatorRefusal('validator-actions-membership',
        'The complete nonempty actual workflow inventory must match the reviewed commit; missing, untracked or unsafe sources cannot qualify.');
    }
    let bytes = 0;
    async function snapshot(name: string) {
      remaining();
      const captured = await readBoundProjectFileSnapshot(root, name.split('/'), {
        maximumBytes: modernLocalBounds.fileBytes, linkPolicy: 'single-link',
        diagnostics: { pathLabel: 'Action-reference source', invalid() {
          throw new ValidatorRefusal('validator-actions-source', 'Action-reference source has an unsafe or changed filesystem boundary.');
        } }
      });
      remaining();
      return captured;
    }
    async function sourceText(name: string): Promise<string> {
      const blob = tree.get(name);
      if (!blob || !['100644', '100755'].includes(blob.mode)) {
        throw new ValidatorRefusal('validator-actions-source',
          'Each declared action source must already be one exact committed regular file.');
      }
      const captured = await snapshot(name);
      const content = captured.content;
      if (!content ||
        createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex') !== blob.digest ||
        (captured.mode! & 0o111 ? '100755' : '100644') !== blob.mode) {
        throw new ValidatorRefusal('validator-actions-source',
          'Actual action-reference source bytes or modes differ from the exact committed regular file.', 'failed');
      }
      if (!inputs.has(name)) bytes += content.length;
      inputs.set(name, blob);
      if (inputs.size > modernLocalBounds.files || bytes > modernLocalBounds.totalBytes ||
        !Buffer.from(content.toString('utf8')).equals(content)) {
        throw new ValidatorRefusal('validator-actions-source',
          'The complete action-reference closure exceeds the existing source bounds or is not UTF-8 text.');
      }
      remaining();
      return content.toString('utf8');
    }
    async function source(name: string): Promise<ParsedWorkflow> {
      return parseAssessmentWorkflow(await sourceText(name), name);
    }
    async function localActionMetadata(parts: readonly string[]): Promise<string> {
      const candidates = ['action.yml', 'action.yaml'].map(name => [...parts, name].join('/'));
      const committed = candidates.filter(name => tree.has(name)), actual: string[] = [];
      for (const name of candidates) if ((await snapshot(name)).content !== undefined) actual.push(name);
      if (committed.length !== 1 || canonicalSha256(actual) !== canonicalSha256(committed)) {
        throw new ValidatorRefusal('validator-actions-local',
          'Actual local action metadata membership must exactly match one committed safe file; an untracked shadow or alternate metadata cannot qualify.');
      }
      return committed[0]!;
    }
    const views: ParsedWorkflow[] = [];
    const visiting = new Set<string>(), visited = new Set<string>();
    const metadataSources = new Map<string, string>();
    async function visit(workflow: ParsedWorkflow): Promise<void> {
      if (visiting.has(workflow.path)) throw new ValidatorRefusal('validator-actions-cycle',
        'The actual local composite-action reference closure contains a cycle.');
      if (visited.has(workflow.path)) return;
      visiting.add(workflow.path);
      const references = actionReferences([workflow]);
      const jobs = workflow.value.jobs;
      if (!references || !isRecord(jobs)) throw new ValidatorRefusal('validator-actions-unavailable',
        'The complete declared action-reference inventory could not be interpreted.');
      views.push(workflow);
      const localReferences: { reference: string; reusable: boolean }[] = [];
      for (const job of Object.values(jobs)) {
        if (!isRecord(job)) throw new ValidatorRefusal('validator-actions-unavailable',
          'The complete declared action-reference inventory could not be interpreted.');
        if (typeof job.uses === 'string' && job.uses.startsWith('./')) {
          if (job.steps !== undefined) throw new ValidatorRefusal('validator-actions-local',
            'A local reusable workflow job cannot also declare action steps.');
          localReferences.push({ reference: job.uses, reusable: true });
        }
        if (Array.isArray(job.steps)) for (const step of job.steps) {
          if (isRecord(step) && typeof step.uses === 'string' && step.uses.startsWith('./')) {
            localReferences.push({ reference: step.uses, reusable: false });
          }
        }
      }
      for (const { reference, reusable } of localReferences) {
        const parts = localPath(reference.slice(2).split('/'));
        if (reusable) {
          const name = parts.join('/');
          if (!/^\.github\/workflows\/[^/]+\.ya?ml$/u.test(name)) {
            throw new ValidatorRefusal('validator-actions-local',
              'A local reusable workflow must name one exact committed top-level workflow file.');
          }
          await visit(await source(name));
          continue;
        }
        const directory = parts.join('/');
        const metadata = metadataSources.get(directory) ?? await localActionMetadata(parts);
        metadataSources.set(directory, metadata);
        if (visiting.has(metadata)) throw new ValidatorRefusal('validator-actions-cycle',
          'The actual local composite-action reference closure contains a cycle.');
        if (visited.has(metadata)) continue;
        const action = await source(metadata);
        const runs = action.value.runs;
        if (!isRecord(runs) || (runs.using === 'composite'
          ? !Array.isArray(runs.steps) || !runs.steps.length || !runs.steps.every(step => isRecord(step) &&
            (typeof step.uses === 'string' && step.uses.trim().length > 0 && step.run === undefined ||
             typeof step.run === 'string' && step.run.trim().length > 0 && step.uses === undefined &&
               typeof step.shell === 'string' && step.shell.trim().length > 0))
          : runs.steps !== undefined || (runs.using === 'docker'
            ? typeof runs.image !== 'string' || !runs.image.startsWith('docker://')
            : runs.using !== 'node20' && runs.using !== 'node24' ||
              typeof runs.main !== 'string' || !runs.main.trim().length))) {
          throw new ValidatorRefusal('validator-actions-local', 'The actual local action metadata has no supported declared reference interpretation.');
        }
        if (runs.using === 'node20' || runs.using === 'node24') {
          for (const entry of [runs.main, runs.pre, runs.post]) {
            if (entry === undefined) continue;
            if (typeof entry !== 'string' || !entry.trim().length) {
              throw new ValidatorRefusal('validator-actions-local',
                'Declared local Node action entrypoints must name actual committed project files.');
            }
            const name = localPath([...parts, ...(entry.startsWith('./') ? entry.slice(2) : entry).split('/')]).join('/');
            await sourceText(name);
          }
        }
        await visit({ ...action, value: { jobs: { localAction: {
          ...(runs.using === 'composite' ? { steps: runs.steps } :
            runs.using === 'docker' ? { steps: [{ uses: runs.image }] } : {})
        } } } });
      }
      visiting.delete(workflow.path);
      visited.add(workflow.path);
    }
    for (const name of paths) await visit(await source(name));
    const policy = pinnedActions(views);
    for (const directory of metadataSources.keys()) await localActionMetadata(directory.split('/'));
    for (const name of inputs.keys()) await sourceText(name);
    const finalPaths = (await files.list(['.github', 'workflows'], ['.yml', '.yaml'])).map(parts => parts.join('/'));
    const final = await executeWorkflowContextValidator(root, { validator: 'source-integrity', sourceSha });
    remaining();
    if (canonicalSha256(finalPaths) !== canonicalSha256(paths) || final.status !== 'passed' ||
      final.graphHash !== initial.graphHash || final.inputDigest !== initial.inputDigest) {
      throw new ValidatorRefusal('validator-actions-drift', 'The actual project or complete workflow inventory changed during validation.', 'failed');
    }
    if (policy.exceptionResource) return report('blocked', 'validator-actions-exception-unavailable',
      'The exact official SLSA tag reference needs its independently approved current scoped exception reader; source declarations or copied approvals cannot supply it.');
    if (policy.value === null) return report('blocked', 'validator-actions-unavailable',
      'Declared action references are dynamic, empty or uninterpretable; no successful pinning result was substituted.');
    return policy.value ? report('passed', 'validator-actions-passed',
      'Every declared external action reference in the complete committed workflow/local-action closure is content-pinned; no workflow, scan, exception or phase authority was issued.') :
      report('failed', 'validator-actions-unpinned',
        'The actual committed action-reference closure violates the unchanged immutable-reference policy; source contents were withheld.');
  } catch (error) {
    if (error instanceof ValidatorRefusal) return report(error.status, error.code, error.message);
    if (error instanceof AssessmentInputError || error instanceof ModernLocalInputError ||
        error instanceof FileSystemError) return report('blocked', 'validator-actions-source',
      'The complete actual workflow/local-action source could not be safely parsed or observed; source contents were withheld.');
    throw error;
  }
}

/** Explicit runner execution, not a plan reader, host sandbox, approval issuer or provider proof producer. */
export async function executeWorkflowContextValidator(
  projectRoot: string, request: WorkflowContextValidatorRequest
): Promise<WorkflowContextValidatorReport> {
  return executeSelectedValidator(projectRoot, readRequest(request));
}

/** Private configuration subcheck, not full infrastructure qualification or a public selector. */
export async function executeWorkflowComposeConfigValidator(
  projectRoot: string, sourceSha: string
): Promise<WorkflowComposeConfigValidatorReport> {
  const request = readRequest({ validator: 'source-integrity', sourceSha });
  return executeSelectedValidator(projectRoot, { ...request, validator: 'compose-config' });
}

async function executeSelectedValidator<Validator extends ExecutableValidator>(
  projectRoot: string, request: { readonly validator: Validator; readonly sourceSha: string }
): Promise<ExecutableValidatorReport<Validator>> {
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
      const tools = request.validator === 'compose-config' ? await observeModernLocalTools(projectRoot, [selected], []) : null;
      const compose = tools?.find(tool => tool.id === 'docker');
      if (tools && !compose) {
        throw new ValidatorRefusal('validator-compose-tool', 'The independently observed Docker CLI and Compose plugin are unavailable.');
      }
      const executable = compose
        ? { executable: compose.executablePath, args: [...compose.prefixArgs, ...selected.command.args.slice(1)] }
        : selected.command;
      const home = await mkdtemp(path.join(await realpath(os.tmpdir()), 'liftoff-workflow-validator-'));
      let settled = false;
      let commandFailed = false;
      retainedExecutionDirectory = home;
      const homeBoundary = await captureWorkspaceDirectoryChain(home).then(async boundary => {
        await assertWorkspaceDirectorySnapshot(boundary);
        return boundary;
      }).catch(error => {
        if (!isWorkspaceCleanupError(error)) throw error;
        throw new ValidatorRefusal('validator-cleanup',
          'The allocated runner HOME identity could not be captured; its original pathname is retained for review and no workload was started.');
      });
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
        if (tools) {
          Object.assign(env, {
            DOCKER_CONFIG: path.join(home, 'docker'), DOCKER_HOST: `unix://${path.join(home, 'no-daemon.sock')}`,
            DOCKER_CLI_HINTS: 'false'
          });
          await assertModernLocalToolsCurrent(projectRoot, home, tools);
        }
        const result = await runner.run(executable, {
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
        if (tools) await assertModernLocalToolsCurrent(projectRoot, home, tools);
      } finally {
        if (settled) {
          try {
            await assertWorkspaceDirectorySnapshot(homeBoundary);
            await rm(home, { recursive: true });
          } catch (error) {
            if (!isWorkspaceCleanupError(error)) throw error;
            throw new ValidatorRefusal('validator-cleanup',
              'The original runner HOME identity or cleanup could not be verified. Its retained original pathname may be missing or replaced, and the allocated directory may have moved; a replacement is not cleanup authority.');
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
