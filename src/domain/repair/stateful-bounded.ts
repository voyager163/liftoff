import { StateMigrationError } from './stateful.js';

export function boundedStateOperation<T>(
  signal: AbortSignal,
  action: () => Promise<T>,
  lateResult?: (value: T) => Promise<void>
): Promise<T> {
  const cancelled = (): StateMigrationError => new StateMigrationError(signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled');
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const abort = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      reject(cancelled());
    };
    signal.addEventListener('abort', abort, { once: true });
    void Promise.resolve().then(() => {
      if (signal.aborted) throw cancelled();
      return action();
    }).then((value) => {
      if (settled) {
        void lateResult?.(value).catch(() => undefined);
        return;
      }
      settled = true;
      signal.removeEventListener('abort', abort);
      resolve(value);
    }, (error: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}
