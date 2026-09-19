import { canonicalSha256 } from '../governance/activation/canonical-json.js';
import { controlledGnomeSourceCommit } from './controlled-keystore.js';
import { linuxNullProcessProfile } from './linux-null-process.js';
import { freezeStateValue } from './stateful-invariants.js';

export const managedLinuxKeystoreProvider = 'managed-linux-gnome/1';
export const managedLinuxKeystoreKinds = Object.freeze({
  enrollment: 'managed-linux-keystore-enrollment/1',
  checkpoint: 'managed-linux-keystore-recovery-checkpoint/1',
  keyReference: 'managed-linux-keystore-key-reference/1'
} as const);

export const managedLinuxKeystoreOperations = Object.freeze({
  inspect: 'managed-linux-keystore-inspect/1',
  enroll: 'managed-linux-keystore-enroll/1',
  unlock: 'managed-linux-keystore-unlock/1',
  keyRead: 'managed-linux-keystore-key-read/1',
  recover: 'managed-linux-keystore-recover/1',
  dispose: 'managed-linux-keystore-dispose/1'
} as const);

/** Registered source/interface facts, not storage, process or execution evidence. */
export const managedLinuxKeystoreContract = freezeStateValue({
  kind: 'managed-linux-keystore-contract/1',
  provider: managedLinuxKeystoreProvider,
  platform: 'linux',
  sourceTestedArchitectures: ['x64', 'arm64'],
  minimumDependencies: { glib: '2.80', gck: '3.3.4', gcrBase: '3.27.90', cpython: '3.14', landlockAbi: 3 },
  daemonSourceCommit: controlledGnomeSourceCommit,
  libsecretSourceCommit: 'a5cd57f103038c06b64d5f6ebfd0e627bb40af4e',
  clientProtocol: 'liftoff-linux-keystore-client/1',
  restartProfile: linuxNullProcessProfile,
  algorithms: {
    transport: 'dh-ietf1024-sha256-aes128-cbc-pkcs7',
    keyBytes: 32,
    requestContentType: 'application/octet-stream',
    responseContentType: 'text/plain',
    valueInterpretation: 'opaque-bytes-not-text'
  },
  interfaces: {
    daemon: ['--foreground', '--components=secrets', '--control-directory', '--unlock'],
    password: 'protected-stdin-nonempty-no-public-verifier',
    bus: ['explicit-private-unix-address', 'authentication-guid-not-GetId', 'GetNameOwner', 'GetConnectionCredentials'],
    secretService: ['OpenSession', 'Collection.SearchItems', 'Collection.CreateItem(replace=false)',
      'Properties.Get', 'Properties.GetAll', 'Service.GetSecrets(exact-item-path)'],
    prompts: 'refused',
    libsecretBinding: 'explicit-GDBusConnection-unique-name-constructor-before-init-and-rechecked',
    backingObject: 'independent-native-open-lstat-fstat-read-not-a-Secret-Service-property',
    persistedFormat: 'gnome-keyring-binary-0.0',
    persistedProperties: {
      headerBytes: 16, cipher: 'aes-128-cbc', derivation: 'gnome-simple-sha256',
      contentChecksum: 'md5-not-authentication', authenticated: false,
      inspectionScope: 'one-managed-application-key-not-general-keyring-adoption'
    },
    nativeWriter: {
      source: 'pkcs11/gkm/gkm-transaction.c',
      publication: 'same-directory-temp-write-close-rename',
      fileSync: 'HAVE_FSYNC-conditional-errors-propagated',
      directorySync: 'not-provided'
    },
    keyBinding: 'liftoff-managed-linux-key-binding/1',
    durability: ['independent-fsync-exact-file', 'independent-fsync-parent-directory',
      'owned-process-settlement', 'discard-application-key-cache', 'fresh-process-cryptographic-readback']
  },
  limitations: [
    'unlock-can-create-missing-login-collection-and-initialize-other-slots',
    'failed-unlock-can-leave-daemon-running',
    'invalid-control-path-can-fall-back',
    'Secret-Service-does-not-identify-backing-file-or-saved-generation',
    'pinned-libsecret-open-sync-ignores-service-bus-name-argument',
    'CKA_TRUSTED-is-not-persistence',
    'CreateItem-success-is-not-durability',
    'binary-format-and-MD5-checksum-are-not-authentication',
    'fsync-and-source-restart-tests-are-not-power-loss-or-encrypted-host-qualification',
    'guard-does-not-cover-metadata-IPC-passed-descriptors-or-external-writers'
  ],
  remainingAdmission: [
    'native-protected-storage-contract-and-observation',
    'exact-operation-approval-and-protected-operator-input',
    'current-software-helper-principal-path-and-private-IPC-admission',
    'native-backing-object-generation-durability-and-process-observations',
    'fresh-key-binding-verification',
    'minimum-host-and-installed-artifact-qualification'
  ],
  registration: 'source-audit-only',
  execution: 'not-authorized',
  readiness: false
} as const);

export const managedLinuxKeystoreContractDigest = canonicalSha256(managedLinuxKeystoreContract);
