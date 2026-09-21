import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createImageRegistry, type LocalImageIdentity } from '../scripts/repository-security/images.ts';

const id = `sha256:${'a'.repeat(64)}`;

describe('explicit owned image lifecycle', () => {
  it('tracks exact tags and removes only owned tags, not shared image IDs or arbitrary patterns', async () => {
    const registry = createImageRegistry(randomUUID(), ['node', 'python']);
    const image: LocalImageIdentity = { tag: registry.tagFor('node'), id, platform: 'linux/amd64' };
    registry.register('node', image);
    const removed: string[] = [];
    const operations = { inspect: async () => image, removeTag: async (tag: string) => { removed.push(tag); } };
    expect(await registry.verify('node', operations)).toEqual(image);
    await registry.cleanup(operations);
    expect(removed).toEqual([image.tag]);
    expect(removed).not.toContain(id);
    expect(registry.records()).toEqual([]);
    await expect(registry.cleanup(operations)).rejects.toThrow('image-registry-closed');
  });

  it('rejects unknown, duplicate or unbuilt cases and forged identity metadata', async () => {
    const registry = createImageRegistry(randomUUID(), ['node']);
    expect(() => registry.tagFor('unrelated')).toThrow('unregistered-image-case');
    expect(() => registry.register('node', { tag: 'shared:latest', id, platform: 'linux/amd64' }))
      .toThrow('image-identity-mismatch');
    await expect(registry.verify('node', {
      inspect: async () => ({ tag: registry.tagFor('node'), id, platform: 'linux/amd64' }),
      removeTag: async () => {}
    })).rejects.toThrow('image-not-built');
    registry.register('node', { tag: registry.tagFor('node'), id, platform: 'linux/amd64' });
    expect(() => registry.register('node', { tag: registry.tagFor('node'), id, platform: 'linux/amd64' }))
      .toThrow('duplicate-image-registration');
  });

  it.each(['digest', 'platform'] as const)('does not delete anything when %s changes', async kind => {
    const registry = createImageRegistry(randomUUID(), ['node']);
    const image: LocalImageIdentity = { tag: registry.tagFor('node'), id, platform: 'linux/amd64' };
    registry.register('node', image);
    let removed = 0;
    const drifted: LocalImageIdentity = kind === 'digest'
      ? { ...image, id: `sha256:${'b'.repeat(64)}` }
      : { ...image, platform: 'linux/arm64' };
    await expect(registry.cleanup({
      inspect: async () => drifted, removeTag: async () => { removed++; }
    })).rejects.toThrow('image-cleanup-drift');
    expect(removed).toBe(0);
    expect(registry.records()).toEqual([image]);
  });

  it('retains pending cleanup identities after a partial failure without erasing errors', async () => {
    const registry = createImageRegistry(randomUUID(), ['first', 'second']);
    const images = new Map(['first', 'second'].map(name => {
      const image: LocalImageIdentity = { tag: registry.tagFor(name), id, platform: 'linux/amd64' };
      registry.register(name, image);
      return [image.tag, image] as const;
    }));
    const removed: string[] = [];
    const operations = {
      inspect: async (tag: string) => images.get(tag)!,
      removeTag: async (tag: string) => {
        if (tag.endsWith(':second')) throw new Error('PRIVATE_TOOL_ERROR');
        removed.push(tag);
      }
    };
    await expect(registry.cleanup(operations)).rejects.toThrow('image-cleanup-failed');
    expect(removed).toHaveLength(1);
    expect(registry.records().map(image => image.tag)).toEqual([registry.tagFor('second')]);
  });
});
