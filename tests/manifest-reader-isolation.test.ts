import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parseManifest, parseProjectManifest } from '../src/file-system.js';

const source = vi.hoisted(() => ({
  modern: vi.fn(() => { throw new Error('Modern source deliberately unavailable.'); })
}));
vi.mock('../src/domain/governance/policy/identity.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/domain/governance/policy/identity.js')>(),
  modernActivationSourceContracts: source.modern
}));

describe('historical manifest source isolation', () => {
  it('imports the filesystem facade and parses historical source without constructing a modern reader', () => {
    const raw: unknown = JSON.parse(readFileSync(new URL('./fixtures/contract-baseline-0.12.3/manifests/0.12.3-standard-go.json', import.meta.url), 'utf8'));
    expect(parseProjectManifest(raw)).toEqual(parseManifest(raw));
    expect(source.modern).not.toHaveBeenCalled();
  });

  it('rejects an unsupported family before consulting modern source contracts', () => {
    expect(() => parseProjectManifest({ artifactVersion: 99 })).toThrow(/Unsupported manifest artifactVersion 99/);
    expect(source.modern).not.toHaveBeenCalled();
  });

  it('does not fall back to a historical reader when the selected modern source is unavailable', () => {
    expect(() => parseProjectManifest({ artifactVersion: 8 })).toThrow('Modern source deliberately unavailable.');
    expect(source.modern).toHaveBeenCalledOnce();
  });
});
