export class ApplicationPrivateError extends Error {
  constructor(readonly code: string) {
    super(`Private application execution blocked (${code}); provider and private payload diagnostics were withheld.`);
    this.name = 'ApplicationPrivateError';
  }
}

export function applicationPrivateAssert(value: unknown, code: string): asserts value {
  if (!value) throw new ApplicationPrivateError(code);
}
