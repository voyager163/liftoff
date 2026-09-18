import path from 'node:path';
import { lstat, readdir, realpath } from 'node:fs/promises';
import type { PrivateStateCommandResult, StateExecutionContext } from '../../domain/repair/stateful.js';
import { OwnedPrivateStateProcessRunner } from '../state/owned-process.js';
import { isolatedStateEnvironment } from '../state/native-system.js';
import { readPrivateNativeFile, writePrivateNativeFile } from '../state/native-files.js';
import { stateDigest } from '../../domain/repair/stateful-invariants.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import {
  applicationPrivateAssert as must,
  type ApplicationPrivateCommand, type ApplicationPrivateCommandRunner, type ApplicationPrivateDirectory, type ApplicationPrivateIntent,
  type ApplicationPrivateSavedPlan, type ApplicationPrivateSource
} from '../../application/azure-activation/application-private-contracts.js';
import {
  applicationPrivateNativeRoot, assertApplicationPrivateExecutable, materializeApplicationPrivateSource,
  verifyApplicationPrivateProjection, verifyApplicationPrivateSource
} from '../../application/azure-activation/application-private-source.js';
import { applicationPrivateJson } from '../../application/azure-activation/application-private-plan.js';

export const applicationPrivateNativeFiles = Object.freeze({
  state: 'application.tfstate', plan: 'review.tfplan', variables: 'liftoff.private.tfvars.json',
  backend: 'liftoff-application-backend.tf.json', cli: 'liftoff.private.tfrc'
});

function inside(root: string, name: string): boolean {
  const relative = path.relative(root, name);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function applicationPrivateNativeCommands(root: string, intent?: ApplicationPrivateIntent) {
  return {
    init: ['init', '-input=false', '-no-color', '-lockfile=readonly'],
    plan: ['plan', '-input=false', '-no-color', '-refresh=true', '-parallelism=1', '-lock=true', '-lock-timeout=5s',
      '-detailed-exitcode',
      ...(intent && !['foundation', 'staging', 'rehearsal-rollout', 'rehearsal-rollback'].includes(intent.scope)
        ? intent.targets.map((target) => `-target=${target.address}`) : []),
      `-var-file=${path.join(root, applicationPrivateNativeFiles.variables)}`,
      `-out=${path.join(root, applicationPrivateNativeFiles.plan)}`],
    show: ['show', '-json', path.join(root, applicationPrivateNativeFiles.plan)],
    refresh: ['plan', '-refresh-only', '-input=false', '-no-color', '-parallelism=1', '-lock=true', '-lock-timeout=5s',
      '-detailed-exitcode', `-var-file=${path.join(root, applicationPrivateNativeFiles.variables)}`],
    apply: ['apply', '-input=false', '-no-color', '-json', '-parallelism=1', '-lock=true', '-lock-timeout=5s',
      path.join(root, applicationPrivateNativeFiles.plan)]
  } as const;
}

/** Uses the existing owned-process supervisor without the state-only read-only-host fiction. */
export class SpawnApplicationPrivateCommandRunner implements ApplicationPrivateCommandRunner {
  readonly purpose = 'application-resource-changes' as const;
  readonly identityDigest: string;
  readonly #processes = new OwnedPrivateStateProcessRunner();
  #generation = 0;
  constructor(private readonly options: {
    intent: ApplicationPrivateIntent;
    verify(cwd: string): Promise<void>;
    privateEnvironment(signal?: AbortSignal): Promise<Record<string, string>>;
    authorize(): Promise<void>;
    quiescePrivateHelpers?(): Promise<void>;
  }) {
    this.identityDigest = options.intent.custody.tools.tofu.sha256;
  }

  toJSON() { return { runner: 'fixed-private-application-opentofu', identityDigest: this.identityDigest }; }

  async run(command: ApplicationPrivateCommand): Promise<PrivateStateCommandResult> {
    const generation = this.#generation;
    must(!command.signal?.aborted && command.stdin === undefined, 'native-command-input');
    const allowed = applicationPrivateNativeCommands(command.cwd, this.options.intent);
    const name = command.args[0];
    must(name === 'init' || name === 'plan' || name === 'show' || name === 'apply', 'native-command');
    const expected = name === 'plan' && command.args.includes('-refresh-only') ? allowed.refresh : allowed[name];
    must(canonicalSha256(command.args) === canonicalSha256(expected) &&
      command.operation === (name === 'apply' ? 'transform' : 'inspect'), 'native-command');
    must(name === 'apply' ? command.privatePlan !== undefined : command.privatePlan === undefined, 'exact-private-plan-required');
    await this.options.authorize();
    await this.options.verify(command.cwd);
    await assertApplicationPrivateExecutable(this.options.intent.custody.tools.tofu);
    await assertApplicationPrivateExecutable(this.options.intent.source.provider.binary);
    const environment: NodeJS.ProcessEnv = isolatedStateEnvironment(command.cwd);
    try {
      if (name === 'plan' || name === 'apply') {
        const credentials = await this.options.privateEnvironment(command.signal);
        try {
          must(Object.keys(credentials).sort().join(',') === [
            'ARM_CLIENT_ID', 'ARM_CLIENT_SECRET', 'ARM_SUBSCRIPTION_ID', 'ARM_TENANT_ID',
            'ARM_USE_CLI', 'ARM_USE_MSI', 'ARM_USE_OIDC'
          ].sort().join(',') && credentials.ARM_CLIENT_ID === this.options.intent.writer.clientId &&
            credentials.ARM_TENANT_ID === this.options.intent.binding.tenantId &&
            credentials.ARM_SUBSCRIPTION_ID === this.options.intent.binding.subscriptionId &&
            credentials.ARM_USE_CLI === 'false' && credentials.ARM_USE_MSI === 'false' && credentials.ARM_USE_OIDC === 'false' &&
            Object.values(credentials).every((value) => typeof value === 'string' && !value.includes('\0')), 'native-environment');
          Object.assign(environment, credentials);
        } finally { for (const key of Object.keys(credentials)) delete credentials[key]; }
      }
      Object.assign(environment, {
        ARM_SKIP_PROVIDER_REGISTRATION: 'true', ARM_RESOURCE_PROVIDER_REGISTRATIONS: 'none',
        TF_LOG: 'OFF', TF_LOG_CORE: 'OFF', TF_LOG_PROVIDER: 'OFF'
      });
      await this.options.authorize();
      must(generation === this.#generation && !command.signal?.aborted, 'native-command-cancelled');
      await this.options.verify(command.cwd);
      if (command.privatePlan) {
        const expected = command.privatePlan;
        must(path.join(expected.directory, ...this.options.intent.source.rootPathParts.slice(3)) === command.cwd,
          'saved-plan-directory');
        must(canonicalSha256(await inspectApplicationPrivateInstallation(command.cwd, expected.directory, this.options.intent)) ===
          canonicalSha256(expected.installedFiles), 'provider-installation-changed');
        for (const [filename, digest] of [
          [path.join(command.cwd, applicationPrivateNativeFiles.plan), expected.savedPlanDigest],
          [path.join(command.cwd, applicationPrivateNativeFiles.variables), expected.variablesDigest],
          [path.join(expected.directory, applicationPrivateNativeFiles.state), expected.originalDigest]
        ]) {
          const bytes = await readPrivateNativeFile(filename, 64 * 1024 * 1024);
          try { must(stateDigest(bytes) === digest, 'last-moment-saved-input-change'); }
          finally { bytes.fill(0); }
        }
      }
      const result = await this.#processes.run({
        executable: this.options.intent.custody.tools.tofu.path, args: command.args, cwd: command.cwd,
        environment, signal: command.signal, timeoutMs: this.options.intent.maxCommandMs,
        maximumBytes: 32 * 1024 * 1024, captureStderr: false
      });
      result.stderr.fill(0);
      return { exitCode: result.exitCode, stdout: result.stdout };
    } finally { for (const key of Object.keys(environment)) delete environment[key]; }
  }

  async quiesce(): Promise<void> {
    this.#generation++;
    const results = await Promise.allSettled([
      this.#processes.quiesce(), this.options.quiescePrivateHelpers?.() ?? Promise.resolve()
    ]);
    const failure = results.find((entry) => entry.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}

export async function inspectApplicationPrivateInstallation(
  root: string, directory: string, intent: ApplicationPrivateIntent
): Promise<ApplicationPrivateSavedPlan['installedFiles']> {
  const files: ApplicationPrivateSavedPlan['installedFiles'][number][] = [];
  let entriesSeen = 0, providerSeen = false;
  async function visit(filename: string): Promise<void> {
    must(++entriesSeen <= 256, 'provider-installation-bound');
    const info = await lstat(filename);
    const resolved = await realpath(filename);
    must(inside(directory, resolved) || inside(intent.source.provider.mirrorDirectory, resolved), 'provider-installation-path');
    if (info.isSymbolicLink()) {
      must(inside(intent.source.provider.mirrorDirectory, resolved) &&
        inside(path.join(root, '.terraform', 'providers'), filename), 'provider-installation-link');
      for (const entry of await readdir(resolved, { withFileTypes: true })) {
        must(entry.isFile() && !entry.isSymbolicLink(), 'provider-installation-package');
        await visit(path.join(filename, entry.name));
      }
    } else if (info.isDirectory()) {
      for (const entry of await readdir(filename)) await visit(path.join(filename, entry));
    } else {
      must(info.isFile() && info.nlink === 1 && info.size <= 512 * 1024 * 1024, 'provider-installation-file');
      const bytes = await readPrivateNativeFile(resolved, 512 * 1024 * 1024);
      try {
        const digest = stateDigest(bytes);
        if (resolved === intent.source.provider.binary.path) {
          must(digest === intent.source.provider.binary.sha256, 'provider-binary-changed');
          providerSeen = true;
        } else if (path.basename(filename).startsWith('terraform-provider-')) must(false, 'additional-provider-binary');
        if (filename === path.join(root, '.terraform', 'modules', 'modules.json')) {
          const modules = applicationPrivateJson(bytes).Modules;
          must(Array.isArray(modules) && modules.length <= 33, 'installed-modules');
          for (const module of modules) {
            must(module && typeof module === 'object' && typeof module.Dir === 'string' &&
              (module.Source === '' || typeof module.Source === 'string' && /^\.\.?\//u.test(module.Source)),
            'installed-modules');
            const modulePath = path.resolve(root, module.Dir);
            must(inside(directory, modulePath), 'installed-module-escape');
          }
        }
        files.push({ path: path.relative(root, filename), realPath: resolved, digest });
      } finally { bytes.fill(0); }
    }
  }
  await visit(path.join(root, '.terraform'));
  must(providerSeen, 'provider-installation-missing');
  await assertApplicationPrivateExecutable(intent.source.provider.binary);
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

export class ApplicationPrivateOpenTofu {
  constructor(private readonly options: {
    runner: ApplicationPrivateCommandRunner;
    intent: ApplicationPrivateIntent;
    context: StateExecutionContext;
    source: ApplicationPrivateSource;
    assertDirectory(directory: ApplicationPrivateDirectory): Promise<void>;
    authorize(): Promise<void>;
  }) {
    must(options.runner.purpose === 'application-resource-changes' &&
      options.runner.identityDigest === options.intent.custody.tools.tofu.sha256, 'separate-application-runner-required');
  }

  private async run(root: string, args: readonly string[], signal?: AbortSignal) {
    await this.options.authorize();
    return this.options.runner.run({ cwd: root, args, operation: args[0] === 'apply' ? 'transform' : 'inspect', signal });
  }

  async prepare(directory: ApplicationPrivateDirectory, original: Uint8Array, variables: Uint8Array, signal?: AbortSignal) {
    await this.options.assertDirectory(directory);
    const root = await materializeApplicationPrivateSource(this.options.context.projectRoot, this.options.source, directory.path);
    const statePath = path.join(directory.path, applicationPrivateNativeFiles.state);
    applicationPrivateJson(variables);
    await writePrivateNativeFile(statePath, original, true);
    await writePrivateNativeFile(path.join(root, applicationPrivateNativeFiles.variables), variables, true);
    await writePrivateNativeFile(path.join(root, applicationPrivateNativeFiles.backend),
      JSON.stringify({ terraform: { backend: { local: { path: statePath } } } }), true);
    await writePrivateNativeFile(path.join(root, applicationPrivateNativeFiles.cli),
      `disable_checkpoint = true\nprovider_installation {\n filesystem_mirror {\n path = ${JSON.stringify(this.options.intent.source.provider.mirrorDirectory)}\n include = ["registry.opentofu.org/hashicorp/azurerm"]\n }\n}\n`, true);
    const commands = applicationPrivateNativeCommands(root, this.options.intent);
    const init = await this.run(root, commands.init, signal);
    init.stdout.fill(0);
    must(init.exitCode === 0, 'native-init-failed');
    await verifyApplicationPrivateProjection(this.options.source, directory.path);
    const installedFiles = await inspectApplicationPrivateInstallation(root, directory.path, this.options.intent);
    const plan = await this.run(root, commands.plan, signal);
    plan.stdout.fill(0);
    must(plan.exitCode === 0 || plan.exitCode === 2, 'native-plan-failed');
    const saved = await readPrivateNativeFile(path.join(root, applicationPrivateNativeFiles.plan), 64 * 1024 * 1024);
    let shown: Uint8Array | undefined;
    let retained = false;
    try {
      const display = await this.run(root, commands.show, signal);
      shown = display.stdout;
      must(display.exitCode === 0, 'native-show-failed');
      const current = await readPrivateNativeFile(path.join(root, applicationPrivateNativeFiles.plan), 64 * 1024 * 1024);
      try { must(stateDigest(current) === stateDigest(saved), 'saved-plan-changed-during-show'); }
      finally { current.fill(0); }
      const state = await readPrivateNativeFile(statePath, 32 * 1024 * 1024);
      try { must(stateDigest(state) === stateDigest(original), 'planning-changed-state'); }
      finally { state.fill(0); }
      await verifyApplicationPrivateSource(this.options.context.projectRoot, this.options.source);
      await verifyApplicationPrivateProjection(this.options.source, directory.path);
      must(canonicalSha256(await inspectApplicationPrivateInstallation(root, directory.path, this.options.intent)) ===
        canonicalSha256(installedFiles), 'provider-installation-changed');
      retained = true;
      return { saved, shown, installedFiles };
    } finally { if (!retained) { saved.fill(0); shown?.fill(0); } }
  }

  async verifySaved(plan: ApplicationPrivateSavedPlan, saved: Uint8Array, original: Uint8Array, variables: Uint8Array): Promise<void> {
    await this.options.assertDirectory(plan.directory);
    await verifyApplicationPrivateSource(this.options.context.projectRoot, plan.source);
    await verifyApplicationPrivateProjection(plan.source, plan.directory.path);
    const root = applicationPrivateNativeRoot(plan.directory.path, plan.source);
    must(canonicalSha256(await inspectApplicationPrivateInstallation(root, plan.directory.path, this.options.intent)) ===
      canonicalSha256(plan.installedFiles), 'provider-installation-changed');
    for (const [filename, expected] of [
      [path.join(root, applicationPrivateNativeFiles.plan), saved],
      [path.join(root, applicationPrivateNativeFiles.variables), variables],
      [path.join(plan.directory.path, applicationPrivateNativeFiles.state), original]
    ] as const) {
      const bytes = await readPrivateNativeFile(filename, 64 * 1024 * 1024);
      try { must(stateDigest(bytes) === stateDigest(expected), 'saved-native-input-changed'); }
      finally { bytes.fill(0); }
    }
  }

  async applySaved(plan: ApplicationPrivateSavedPlan, signal?: AbortSignal): Promise<number> {
    await this.options.assertDirectory(plan.directory);
    const root = applicationPrivateNativeRoot(plan.directory.path, plan.source);
    await this.options.authorize();
    const result = await this.options.runner.run({
      cwd: root, args: applicationPrivateNativeCommands(root, this.options.intent).apply, operation: 'transform', signal,
      privatePlan: {
        directory: plan.directory.path, savedPlanDigest: plan.savedPlan.digest, variablesDigest: plan.variables.digest,
        originalDigest: plan.original.digest, installedFiles: plan.installedFiles
      }
    });
    result.stdout.fill(0);
    return result.exitCode;
  }

  async candidate(directory: ApplicationPrivateDirectory): Promise<Uint8Array> {
    await this.options.assertDirectory(directory);
    return readPrivateNativeFile(path.join(directory.path, applicationPrivateNativeFiles.state), 32 * 1024 * 1024);
  }

  async verifyReadback(directory: ApplicationPrivateDirectory, candidate: Uint8Array, signal?: AbortSignal): Promise<void> {
    await this.options.assertDirectory(directory);
    await verifyApplicationPrivateProjection(this.options.source, directory.path);
    const before = await this.candidate(directory);
    try { must(stateDigest(before) === stateDigest(candidate), 'private-readback-state-changed'); }
    finally { before.fill(0); }
    const root = applicationPrivateNativeRoot(directory.path, this.options.source);
    const result = await this.run(root, applicationPrivateNativeCommands(root, this.options.intent).refresh, signal);
    result.stdout.fill(0);
    must(result.exitCode === 0, 'independent-private-refresh-drift');
    const after = await this.candidate(directory);
    try { must(stateDigest(after) === stateDigest(candidate), 'private-readback-mutated-state'); }
    finally { after.fill(0); }
    await this.options.authorize();
  }

  async quiesce(): Promise<void> { await this.options.runner.quiesce(); }
}
