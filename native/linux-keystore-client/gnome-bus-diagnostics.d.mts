export interface SafeBusDiagnostic {
  readonly stage: 'spawn' | 'standard-fds' | 'socket-bind' | 'configuration' | 'address-output' | 'unclassified';
  readonly reason: 'native-exec' | 'dev-null-open' | 'dev-null-dup' | 'unix-bind' | 'config-read' | 'early-exit' | 'no-guid' | 'unclassified';
  readonly errno: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly addressObserved: boolean;
  readonly nullReadWrite: string;
}
export function safeNativeErrno(value: unknown): string;
export function safeBusDiagnostic(value: unknown): SafeBusDiagnostic | null;
export function consumeBusStartupDiagnostic(stderr: Uint8Array, process: {
  spawnError?: unknown;
  closed?: boolean;
  exitCode?: number | null;
  signal?: string | null;
  addressObserved?: boolean;
  nullReadWrite?: unknown;
}): SafeBusDiagnostic | null;
