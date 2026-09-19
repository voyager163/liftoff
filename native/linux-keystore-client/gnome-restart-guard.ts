import { canonicalSha256 } from '../../src/domain/governance/activation/canonical-json.js';
import { StateMigrationError } from '../../src/domain/repair/stateful.js';
import {
  linuxReadonlyNullProcessContract,
  type LinuxReadonlyNullProcessGuard,
  type LinuxReadonlyNullProcessRequest
} from '../../src/adapters/state/linux-readonly-process.js';

type RestartMetadata = Omit<LinuxReadonlyNullProcessRequest, 'stdin' | 'operationDigest'>;
type RestartGuard = Pick<LinuxReadonlyNullProcessGuard, 'plan' | 'run'>;

/** The caller supplies only source-owned nonsecret arguments/configuration here. */
export async function runGnomeNullRestart(
  guard: RestartGuard, metadata: RestartMetadata, privateInput: Uint8Array
): Promise<{ exitCode: 0; stdout: Uint8Array }> {
  const fields = ['python', 'executable', 'args', 'scopeDirectory', 'storeDirectory',
    'writableDirectories', 'timeoutMs', 'maximumBytes', 'signal'];
  if (Object.keys(metadata).some((field) => !fields.includes(field)) ||
      !Number.isSafeInteger(metadata.timeoutMs) || metadata.timeoutMs <= 0 || metadata.timeoutMs > 15000 ||
      !Number.isSafeInteger(metadata.maximumBytes) || metadata.maximumBytes <= 0 || metadata.maximumBytes > 32 * 1024 * 1024 ||
      [metadata.python, metadata.executable].some((tool) =>
        !tool || Object.keys(tool).sort().join(',') !== 'path,sha256' ||
        typeof tool.path !== 'string' || typeof tool.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(tool.sha256)) ||
      !metadata.writableDirectories || Object.keys(metadata.writableDirectories).sort().join(',') !== 'control,runtime,scratch' ||
      [metadata.scopeDirectory, metadata.storeDirectory, ...Object.values(metadata.writableDirectories)].some((value) => typeof value !== 'string') ||
      !Array.isArray(metadata.args) || metadata.args.some((arg) => typeof arg !== 'string')) {
    throw new Error('gnome-source-fixture:nonsecret-restart-metadata-required');
  }
  const { signal, ...publicMetadata } = metadata;
  const selected = Object.freeze({
    ...publicMetadata,
    python: Object.freeze({ ...metadata.python }),
    executable: Object.freeze({ ...metadata.executable }),
    args: Object.freeze([...metadata.args]),
    writableDirectories: Object.freeze({ ...metadata.writableDirectories })
  });
  const operationDigest = canonicalSha256({
    kind: 'gnome-source-fixture-restart-operation/1',
    profile: linuxReadonlyNullProcessContract.kind,
    request: selected
  });
  // Planning is part of the existing outer budget, not an extra execution window.
  const deadline = new AbortController();
  const expiresAt = Date.now() + metadata.timeoutMs;
  const timer = setTimeout(() => deadline.abort(), metadata.timeoutMs);
  timer.unref();
  const request = Object.freeze({
    ...selected, operationDigest,
    signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal
  });
  const current = () => {
    if (Date.now() >= expiresAt) deadline.abort();
    if (request.signal.aborted) throw new StateMigrationError(deadline.signal.aborted ? 'timeout' : 'cancelled');
  };
  try {
    // Do not expose private input (or a verifier of it) to planning.
    current();
    const plan = await guard.plan(request);
    current();
    const result = await guard.run({ ...request, stdin: privateInput }, plan);
    try { current(); } catch (error) { result.stdout.fill(0); throw error; }
    return result;
  } finally { clearTimeout(timer); }
}
