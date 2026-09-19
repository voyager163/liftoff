import path from 'node:path';
import { canonicalSha256, isRecord } from '../governance/activation/canonical-json.js';
import { freezeStateValue, stateAssert } from './stateful-invariants.js';
import { parseLinuxReadonlyNullProcessPlan } from './linux-null-process.js';

export const controlledGnomeSourceCommit = 'da00f9621eaf263d5ed4236df9c22798ea8021d2';
export const controlledGnomeLaunchContract = 'linux-gnome-controlled-launch/1';

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  stateAssert(isRecord(value) && Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key)), 'invalid-binding');
  return value;
}

function nativePath(value: unknown): string {
  stateAssert(typeof value === 'string' && value.length <= 4095 && Buffer.byteLength(value, 'utf8') <= 4095 &&
    Buffer.from(value, 'utf8').toString('utf8') === value && !value.endsWith('/') && path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value && value.normalize('NFC') === value &&
    !/[\\\u0000-\u001f\u007f]/u.test(value), 'unsafe-path');
  return value;
}

function digest(value: unknown): string {
  stateAssert(typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value), 'invalid-binding');
  return value;
}

function contains(root: string, target: string): boolean {
  const relative = path.posix.relative(root, target);
  return relative === '' || relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative);
}

function unixBusAddress(socket: string): string {
  stateAssert(Buffer.byteLength(socket, 'utf8') < 108, 'unsafe-path');
  const encoded = [...Buffer.from(socket, 'utf8')].map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join('');
  return `unix:path=${encoded}`;
}

/**
 * A pure launch specification, not native observation, approval or execution.
 * Callers must establish every listed boundary through the registered adapters.
 */
export function planControlledGnomeLaunch(value: unknown) {
  const input = exact(value, [
    'operation', 'projectId', 'projectRoot', 'hostId', 'principalUid', 'scopeRoot',
    'daemon', 'sourceCommit', 'dependencyInventoryDigest'
  ]);
  stateAssert(input.operation === 'enroll' || input.operation === 'restart', 'invalid-binding');
  stateAssert(typeof input.projectId === 'string' && /^[a-zA-Z0-9_.:@/-]{1,256}$/u.test(input.projectId) &&
    typeof input.hostId === 'string' && /^native-host:[a-f0-9]{64}$/u.test(input.hostId) &&
    typeof input.principalUid === 'number' && Number.isSafeInteger(input.principalUid) &&
    input.principalUid >= 0 && input.principalUid <= 0xffffffff, 'invalid-binding');
  stateAssert(input.sourceCommit === controlledGnomeSourceCommit, 'unqualified-combination');
  const projectRoot = nativePath(input.projectRoot);
  const scopeRoot = nativePath(input.scopeRoot);
  stateAssert(!contains(projectRoot, scopeRoot) && !contains(scopeRoot, projectRoot), 'unsafe-path');
  const suppliedDaemon = exact(input.daemon, ['path', 'sha256']);
  const daemon = { path: nativePath(suppliedDaemon.path), sha256: digest(suppliedDaemon.sha256) };
  stateAssert(!contains(scopeRoot, daemon.path) && !contains(projectRoot, daemon.path), 'tool-unavailable');
  const dependencyInventoryDigest = digest(input.dependencyInventoryDigest);
  const paths = {
    scopeRoot,
    home: path.posix.join(scopeRoot, 'home'),
    data: path.posix.join(scopeRoot, 'data'),
    config: path.posix.join(scopeRoot, 'config'),
    runtime: path.posix.join(scopeRoot, 'runtime'),
    control: path.posix.join(scopeRoot, 'control'),
    scratch: path.posix.join(scopeRoot, 'scratch'),
    keyrings: path.posix.join(scopeRoot, 'data', 'keyrings'),
    sessionSocket: path.posix.join(scopeRoot, 'runtime', 'bus'),
    disabledSystemSocket: path.posix.join(scopeRoot, 'runtime', 'no-system-bus')
  };
  const sessionAddress = unixBusAddress(paths.sessionSocket);
  const disabledSystemAddress = unixBusAddress(paths.disabledSystemSocket);
  unixBusAddress(path.posix.join(paths.control, 'control'));
  const specification = {
    schemaVersion: 1 as const,
    kind: 'controlled-linux-keystore-launch' as const,
    contract: controlledGnomeLaunchContract,
    operation: input.operation,
    projectId: input.projectId,
    projectRoot,
    hostId: input.hostId,
    principalUid: input.principalUid,
    paths,
    software: { daemon, sourceCommit: controlledGnomeSourceCommit, dependencyInventoryDigest },
    upstreamBehavior: {
      unlockCreatesMissingLoginCollection: true,
      unlockMayInitializeOtherNativeSlots: true,
      failedUnlockMayLeaveDaemonRunning: true,
      invalidControlDirectoryMayFallBack: true
    } as const,
    request: {
      executable: daemon.path,
      args: ['--foreground', '--components=secrets', '--control-directory', paths.control, '--unlock'],
      cwd: scopeRoot,
      environment: {
        PATH: '/usr/bin:/bin', HOME: paths.home, USERPROFILE: paths.home,
        XDG_DATA_HOME: paths.data, XDG_CONFIG_HOME: paths.config,
        XDG_CACHE_HOME: paths.scratch, XDG_RUNTIME_DIR: paths.runtime,
        TMPDIR: paths.scratch, TMP: paths.scratch, TEMP: paths.scratch,
        DBUS_SESSION_BUS_ADDRESS: sessionAddress, DBUS_SYSTEM_BUS_ADDRESS: disabledSystemAddress,
        GNOME_KEYRING_PARANOID: '1', LANG: 'C', LC_ALL: 'C'
      }
    },
    input: { kind: 'protected-master-password-stdin' as const, maximumBytes: 4096, trim: false },
    observation: 'unperformed' as const,
    execution: 'not-authorized' as const,
    beforeDispatch: [
      'exact-operation-approval', 'native-linux-principal-and-protected-path-custody',
      'registered-daemon-and-dependency-identity', 'private-owned-bus-and-socket-identity',
      'exact-owned-private-directory-layout', 'exact-existing-control-directory', 'disabled-system-socket-absent',
      'all-native-slot-storage-confined', 'private-bounded-stdio',
      ...(input.operation === 'enroll'
        ? ['fresh-absence-bound-store-scope']
        : ['original-enrollment-and-generation-binding', 'existing-store-required', 'persisted-store-write-denial'])
    ],
    beforeReadiness: [
      'actual-control-location-readback', 'actual-collection-key-and-persistence-binding',
      'independent-durable-readback', 'owned-session-settlement', 'fresh-process-key-bound-readback'
    ],
    daemonStartupProvesReadiness: false as const
  };
  return freezeStateValue({ ...specification, fingerprint: canonicalSha256(specification) });
}

/** Binds an explicitly selected guard plan, without granting execution authority. */
export function planControlledGnomeNullRestart(value: unknown) {
  const input = exact(value, [
    'operation', 'projectId', 'projectRoot', 'hostId', 'principalUid', 'scopeRoot',
    'daemon', 'sourceCommit', 'dependencyInventoryDigest', 'guardPlan'
  ]);
  const { guardPlan: suppliedGuard, ...launchInput } = input;
  const { fingerprint: launchFingerprint, ...launch } = planControlledGnomeLaunch(launchInput);
  const guardPlan = parseLinuxReadonlyNullProcessPlan(suppliedGuard);
  stateAssert(launch.operation === 'restart' && guardPlan.operationDigest === launchFingerprint &&
    guardPlan.hostId === launch.hostId && guardPlan.principalUid === launch.principalUid, 'invalid-binding');
  const specification = {
    ...launch, kind: 'controlled-linux-keystore-null-restart' as const,
    contract: 'linux-gnome-controlled-null-restart/1' as const, guardPlan,
    beforeDispatch: [...launch.beforeDispatch, 'exact-null-sink-profile-plan-binding', 'current-native-null-device-identity']
  };
  return freezeStateValue({ ...specification, fingerprint: canonicalSha256(specification) });
}
