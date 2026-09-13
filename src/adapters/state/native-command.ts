import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type NativeStateHost, type PrivateStateCommand,
  type PrivateStateCommandResult, type PrivateStateCommandRunner
} from '../../domain/repair/stateful.js';
import { stateAssert, stateDigest } from '../../domain/repair/stateful-invariants.js';
import { OwnedPrivateStateProcessRunner } from './owned-process.js';

export type {
  NativeStateHost, PrivateStateCommand, PrivateStateCommandResult, PrivateStateCommandRunner
} from '../../domain/repair/stateful.js';

const environmentNames = new Set([
  'PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR',
  'ARM_CLIENT_ID', 'ARM_TENANT_ID', 'ARM_SUBSCRIPTION_ID', 'ARM_USE_OIDC',
  'ARM_OIDC_TOKEN', 'ARM_OIDC_TOKEN_FILE_PATH', 'ARM_USE_MSI',
  'ARM_MSI_ENDPOINT', 'ARM_CLIENT_SECRET', 'ARM_USE_AZUREAD',
  'ARM_USE_CLI',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR'
]);

export class SpawnPrivateStateCommandRunner implements PrivateStateCommandRunner {
  readonly identityDigest: string;
  #processes: OwnedPrivateStateProcessRunner;
  #generation = 0;
  constructor(private readonly options: {
    executable: string;
    executableDigest: string;
    host: NativeStateHost;
    timeoutMs?: number;
    maxCaptureBytes?: number;
    cleanupTimeoutMs?: number;
  }) {
    stateAssert(path.isAbsolute(options.executable) && /^[a-f0-9]{64}$/.test(options.executableDigest), 'tool-unavailable');
    this.identityDigest = options.executableDigest;
    this.#processes = new OwnedPrivateStateProcessRunner(options.cleanupTimeoutMs);
  }

  toJSON(): { command: string; identityDigest: string } {
    return { command: 'registered-opentofu', identityDigest: this.identityDigest };
  }

  async run(command: PrivateStateCommand): Promise<PrivateStateCommandResult> {
    const generation = this.#generation;
    stateAssert(!command.signal?.aborted, 'cancelled');
    stateAssert(path.isAbsolute(command.cwd) && ['init', 'plan', 'show', 'state', 'apply'].includes(command.args[0]), 'unsafe-planning-contract');
    stateAssert(command.args.every((arg) => typeof arg === 'string' && !/[\x00\r\n]/.test(arg)), 'unsafe-planning-contract');
    stateAssert(!command.args.some((arg) => /^-+(?:force|force-copy|force-unlock|reconfigure|lock=false|target|replace)(?:=|$)/.test(arg))
      && !(command.args[0] === 'state' && ['push', 'rm', 'replace-provider'].includes(command.args[1])), 'unsafe-planning-contract');
    if (command.operation === 'inspect') {
      stateAssert(command.args[0] !== 'apply' && !command.args.includes('-migrate-state')
        && (command.args[0] !== 'state' || (command.args[1] === 'mv' && command.args.includes('-dry-run'))), 'unsafe-planning-contract');
    }
    stateAssert(stateDigest(await readFile(this.options.executable)) === this.identityDigest, 'tool-unavailable');
    const host = await this.options.host.verify(command.cwd, command.operation);
    stateAssert(host.directory === command.cwd && host.encryptedVolume && host.isolated
      && host.providerIdentityReadOnly && host.providerRegistrationDisabled, 'unsafe-planning-contract');
    const supplied = await this.options.host.privateEnvironment(command.cwd);
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(supplied)) {
      stateAssert(environmentNames.has(name) && !/[\x00]/.test(value), 'unsafe-planning-contract');
      env[name] = value;
    }
    Object.assign(env, {
      HOME: command.cwd, USERPROFILE: command.cwd, XDG_CONFIG_HOME: command.cwd,
      TMPDIR: command.cwd, TMP: command.cwd, TEMP: command.cwd,
      TF_DATA_DIR: path.join(command.cwd, '.terraform'),
      TF_CLI_CONFIG_FILE: path.join(command.cwd, 'liftoff.private.tfrc'),
      TF_IN_AUTOMATION: '1', CHECKPOINT_DISABLE: '1', TF_LOG: 'OFF',
      ARM_SKIP_PROVIDER_REGISTRATION: 'true', ARM_RESOURCE_PROVIDER_REGISTRATIONS: 'none'
    });
    stateAssert(generation === this.#generation && !command.signal?.aborted, 'cancelled');
    try {
      const result = await this.#processes.run({
        executable: this.options.executable, args: command.args, cwd: command.cwd, environment: env,
        stdin: command.stdin, signal: command.signal, timeoutMs: this.options.timeoutMs ?? 60_000,
        maximumBytes: this.options.maxCaptureBytes ?? 32 * 1024 * 1024, captureStderr: false
      });
      result.stderr.fill(0);
      return { exitCode: result.exitCode, stdout: result.stdout };
    } finally { for (const name of Object.keys(env)) delete env[name]; }
  }

  async quiesce(): Promise<void> {
    this.#generation++;
    const stopped = await Promise.allSettled([
      this.#processes.quiesce(),
      this.options.host.quiesce?.() ?? Promise.resolve()
    ]);
    const failure = stopped.find((entry) => entry.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}
