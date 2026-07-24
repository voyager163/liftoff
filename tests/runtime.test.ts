import { describe, expect, it } from 'vitest';
import { minimumNodeVersion, nodeRuntimeError } from '../src/runtime.js';

describe('Node.js runtime guard', () => {
  it.each(['20.19.0', '20.19.1', '21.0.0', '24.0.0'])(
    'accepts supported runtime %s',
    (version) => {
      expect(nodeRuntimeError(version)).toBeUndefined();
    }
  );

  it.each(['18.20.0', '20.18.9'])('rejects unsupported runtime %s with observed and minimum versions', (version) => {
    expect(nodeRuntimeError(version)).toBe(
      `Liftoff requires Node.js ${minimumNodeVersion} or newer; found ${version}. Upgrade Node.js before retrying.`
    );
  });
});
