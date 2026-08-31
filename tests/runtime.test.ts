import { describe, expect, it } from 'vitest';
import { minimumNodeVersion, nodeRuntimeError } from '../src/runtime.js';

describe('Node.js runtime guard', () => {
  it.each(['24.20.0', '24.20.1', '25.0.0', '26.0.0'])(
    'accepts supported runtime %s',
    (version) => {
      expect(nodeRuntimeError(version)).toBeUndefined();
    }
  );

  it.each(['20.19.0', '22.12.0', '24.19.9'])('rejects unsupported runtime %s with observed and minimum versions', (version) => {
    expect(nodeRuntimeError(version)).toBe(
      `Liftoff requires Node.js ${minimumNodeVersion} or newer; found ${version}. Upgrade Node.js before retrying.`
    );
  });
});
