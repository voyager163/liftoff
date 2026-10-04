import { describe, expect, it } from 'vitest';
import { isContainerPortPending } from '../scripts/generated-container-startup.mjs';

describe('generated container port publication', () => {
  const name = 'liftoff-verify-owned-genai-worker';

  it.each([80, 8000])('waits for the exact %i/tcp mapping while Docker starts the container', port => {
    expect(isContainerPortPending(`Error: No public port '${port}/tcp' published for ${name}\n`, name, port)).toBe(true);
  });

  it.each([
    `Error response from daemon: No such container: ${name}`,
    `Error: No such object: ${name}`
  ])('retains the existing container-creation wait: %s', message => {
    expect(isContainerPortPending(message, name, 8000)).toBe(true);
  });

  it.each([
    `Error: No public port '80/tcp' published for ${name}`,
    `Error: No public port '8000/udp' published for ${name}`,
    "Error: No public port '8000/tcp' published for another-container",
    `Error: No public port '8000/tcp' published for ${name}-other`,
    `Permission denied: Error: No public port '8000/tcp' published for ${name}`,
    `Error: No public port '8000/tcp' published for ${name}\nDocker daemon unavailable`,
    'Cannot connect to the Docker daemon',
    'permission denied',
    ''
  ])('does not hide a different Docker error: %s', message => {
    expect(isContainerPortPending(message, name, 8000)).toBe(false);
  });
});
