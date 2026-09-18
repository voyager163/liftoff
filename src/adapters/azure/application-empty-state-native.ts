import path from 'node:path';
import { lstat, readdir } from 'node:fs/promises';
import { canonicalSha256, isRecord } from '../../domain/governance/activation/canonical-json.js';
import { stateDigest } from '../../domain/repair/stateful-invariants.js';
import type { NativeLocalStateTools } from '../../domain/repair/stateful.js';
import { nativeLocalStateProtocol, isolatedStateEnvironment, verifyStateExecutable } from '../state/native-system.js';
import { readPrivateNativeFile, writePrivateNativeFile } from '../state/native-files.js';
import { OwnedPrivateStateProcessRunner } from '../state/owned-process.js';
import {
  applicationPrivateAssert as must, type ApplicationPrivateDirectory
} from '../../application/azure-activation/application-private-contracts.js';

const workspaceName = 'liftoff-initial-empty';
const configuration = `terraform {\n  required_version = "= ${nativeLocalStateProtocol.tofuVersion}"\n}\n`;
const cliConfiguration = 'disable_checkpoint = true\n';
const commands = Object.freeze(([
  ['init', '-backend=false', '-get=false', '-input=false', '-no-color'],
  ['workspace', 'new', '-no-color', workspaceName],
  ['plan', '-refresh=false', '-input=false', '-no-color', '-out=empty.tfplan'],
  ['show', '-json', 'empty.tfplan'],
  ['apply', '-input=false', '-no-color', 'empty.tfplan'],
  ['state', 'pull']
] as const).map((command) => Object.freeze(command)));

export const applicationEmptyNativeRecipe = Object.freeze({
  protocol: 'opentofu-provider-free-empty-state/1',
  tofuVersion: nativeLocalStateProtocol.tofuVersion,
  configurationDigest: stateDigest(configuration),
  cliConfigurationDigest: stateDigest(cliConfiguration),
  commands
} as const);

export interface CandidateEmptyState {
  bytes: Uint8Array;
  digest: string;
  lineage: string;
  serial: number;
  payload: Record<string, unknown>;
}

function json(bytes: Uint8Array): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(Buffer.from(bytes).toString('utf8')); }
  catch { must(false, 'empty-native-json'); }
  must(isRecord(value), 'empty-native-json');
  return value;
}

export function readCandidateEmptyState(bytes: Uint8Array): CandidateEmptyState {
  const payload = json(bytes);
  must(payload.version === 4 && payload.terraform_version === nativeLocalStateProtocol.tofuVersion &&
    payload.serial === 1 && typeof payload.lineage === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(payload.lineage) &&
    Array.isArray(payload.resources) && payload.resources.length === 0 &&
    isRecord(payload.outputs) && Object.keys(payload.outputs).length === 0 && payload.check_results === null &&
    Object.keys(payload).sort().join(',') === 'check_results,lineage,outputs,resources,serial,terraform_version,version',
  'empty-native-state');
  return { bytes, digest: stateDigest(bytes), lineage: payload.lineage, serial: payload.serial, payload };
}

function verifyEmptyPlan(bytes: Uint8Array): void {
  const plan = json(bytes);
  must(plan.terraform_version === nativeLocalStateProtocol.tofuVersion && plan.format_version === '1.2' &&
    canonicalSha256(plan.planned_values) === canonicalSha256({ root_module: {} }), 'empty-native-plan');
  for (const field of ['resource_changes', 'resource_drift', 'deferred_changes']) {
    must(plan[field] === undefined || Array.isArray(plan[field]) && plan[field].length === 0, 'empty-native-plan');
  }
  must(plan.output_changes === undefined || isRecord(plan.output_changes) && Object.keys(plan.output_changes).length === 0,
    'empty-native-plan');
}

export async function createCandidateEmptyState(options: {
  directory: ApplicationPrivateDirectory;
  tools: NativeLocalStateTools;
  maxCommandMs: number;
  assertDirectory(directory: ApplicationPrivateDirectory): Promise<void>;
  authorize(): Promise<void>;
  started(): Promise<void>;
  settled(): Promise<void>;
}): Promise<CandidateEmptyState> {
  const root = options.directory.path;
  must(options.tools.tofuVersion === nativeLocalStateProtocol.tofuVersion &&
    Number.isSafeInteger(options.maxCommandMs) && options.maxCommandMs > 0 && options.maxCommandMs <= 300_000,
  'empty-native-tools');
  await options.authorize();
  await options.assertDirectory(options.directory);
  must((await readdir(root)).length === 0, 'empty-native-directory');
  await writePrivateNativeFile(path.join(root, 'empty.tf'), configuration, true);
  await writePrivateNativeFile(path.join(root, 'liftoff.private.tfrc'), cliConfiguration, true);
  const statePath = path.join(root, 'terraform.tfstate.d', workspaceName, 'terraform.tfstate');
  const planPath = path.join(root, 'empty.tfplan');
  const processes = new OwnedPrivateStateProcessRunner();
  let planDigest: string | undefined;
  let stateBytes: Uint8Array | undefined;
  let retained = false;
  const verifyInputs = async () => {
    await options.authorize();
    await options.assertDirectory(options.directory);
    await verifyStateExecutable(options.tools.tofu);
    const entries = await readdir(root, { withFileTypes: true });
    must(entries.every((entry) => !entry.isSymbolicLink() &&
      (['empty.tf', 'liftoff.private.tfrc', 'empty.tfplan'].includes(entry.name) ? entry.isFile() :
        ['.terraform', 'terraform.tfstate.d', 'opentofu'].includes(entry.name) && entry.isDirectory())), 'empty-native-directory');
    if (entries.some((entry) => entry.name === 'opentofu')) {
      must((await readdir(path.join(root, 'opentofu'))).length === 0, 'empty-native-ambient-configuration');
    }
    for (const [filename, expected] of [['empty.tf', configuration], ['liftoff.private.tfrc', cliConfiguration]]) {
      const bytes = await readPrivateNativeFile(path.join(root, filename!), 4096);
      try { must(stateDigest(bytes) === stateDigest(expected!), 'empty-native-source-changed'); }
      finally { bytes.fill(0); }
    }
    const dataDirectory = entries.find((entry) => entry.name === '.terraform');
    if (dataDirectory) {
      must(canonicalSha256(await readdir(path.join(root, '.terraform'))) === canonicalSha256(['environment']),
        'empty-native-backend-or-provider');
      const selected = await readPrivateNativeFile(path.join(root, '.terraform', 'environment'), 128);
      try { must(Buffer.from(selected).toString('utf8').trim() === workspaceName, 'empty-native-workspace'); }
      finally { selected.fill(0); }
    }
    if (planDigest) {
      const bytes = await readPrivateNativeFile(planPath, 1024 * 1024);
      try { must(stateDigest(bytes) === planDigest, 'empty-native-plan-changed'); }
      finally { bytes.fill(0); }
    }
  };
  try {
    await options.started();
    for (const args of commands) {
      await verifyInputs();
      if (args[0] === 'apply') {
        const existing = await lstat(statePath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        must(!existing && planDigest, 'empty-native-state-already-exists');
      }
      const result = await processes.run({
        executable: options.tools.tofu.path, args, cwd: root, environment: isolatedStateEnvironment(root),
        timeoutMs: options.maxCommandMs, maximumBytes: 1024 * 1024, captureStderr: false
      });
      try {
        must(result.exitCode === 0, `empty-native-${args[0]}-failed`);
        if (args[0] === 'plan') {
          const bytes = await readPrivateNativeFile(planPath, 1024 * 1024);
          try { planDigest = stateDigest(bytes); } finally { bytes.fill(0); }
        } else if (args[0] === 'show') {
          verifyEmptyPlan(result.stdout);
        } else if (args[0] === 'apply') {
          stateBytes = await readPrivateNativeFile(statePath, 1024 * 1024);
          readCandidateEmptyState(stateBytes);
        } else if (args[0] === 'state') {
          must(stateBytes && canonicalSha256(json(result.stdout)) === canonicalSha256(readCandidateEmptyState(stateBytes).payload),
            'empty-native-readback');
        }
      } finally { result.stdout.fill(0); result.stderr.fill(0); }
    }
    await verifyInputs();
    must(stateBytes, 'empty-native-state-missing');
    const final = await readPrivateNativeFile(statePath, 1024 * 1024);
    try { must(stateDigest(final) === stateDigest(stateBytes), 'empty-native-state-changed'); }
    finally { final.fill(0); }
    await processes.quiesce();
    await options.settled();
    retained = true;
    return readCandidateEmptyState(stateBytes);
  } finally {
    try { await processes.quiesce(); }
    finally { if (!retained) stateBytes?.fill(0); }
  }
}
