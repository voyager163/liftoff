import { digest, SecurityEvidenceError } from './evidence.ts';

export interface LocalImageIdentity {
  tag: string;
  id: string;
  platform: 'linux/amd64' | 'linux/arm64';
}

export interface LocalImageOperations {
  inspect(tag: string): Promise<LocalImageIdentity>;
  removeTag(tag: string): Promise<void>;
}

export function createImageRegistry(runId: string, cases: readonly string[]) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(runId) ||
      cases.length === 0 || cases.length > 100 || new Set(cases).size !== cases.length ||
      cases.some(id => !/^[a-z][a-z0-9-]{0,63}$/.test(id))) {
    throw new SecurityEvidenceError('invalid-image-inventory');
  }
  const tags = new Map(cases.map(id => [id, `liftoff-security-${runId}:${id}`]));
  const images = new Map<string, LocalImageIdentity>();
  let closed = false;

  function tagFor(id: string) {
    if (closed) throw new SecurityEvidenceError('image-registry-closed');
    const tag = tags.get(id);
    if (!tag) throw new SecurityEvidenceError('unregistered-image-case');
    return tag;
  }

  function validate(identity: LocalImageIdentity, expectedTag: string) {
    if (identity.tag !== expectedTag || !['linux/amd64', 'linux/arm64'].includes(identity.platform)) {
      throw new SecurityEvidenceError('image-identity-mismatch');
    }
    digest(identity.id);
    return { tag: expectedTag, id: identity.id, platform: identity.platform };
  }

  return {
    tagFor,
    register(id: string, identity: LocalImageIdentity) {
      const tag = tagFor(id);
      if (images.has(id)) throw new SecurityEvidenceError('duplicate-image-registration');
      images.set(id, validate(identity, tag));
    },
    records(): ReadonlyArray<Readonly<LocalImageIdentity>> {
      return [...images.values()].map(image => Object.freeze({ ...image }));
    },
    async verify(id: string, operations: LocalImageOperations) {
      const tag = tagFor(id), expected = images.get(id);
      if (!expected) throw new SecurityEvidenceError('image-not-built');
      let observed: LocalImageIdentity;
      try { observed = validate(await operations.inspect(tag), tag); }
      catch { throw new SecurityEvidenceError('image-inspection-failed'); }
      if (observed.id !== expected.id || observed.platform !== expected.platform) {
        throw new SecurityEvidenceError('image-content-or-platform-drift');
      }
      return Object.freeze({ ...observed });
    },
    async cleanup(operations: LocalImageOperations) {
      if (closed) throw new SecurityEvidenceError('image-registry-closed');
      for (const [id, expected] of images) {
        let observed: LocalImageIdentity;
        try { observed = validate(await operations.inspect(tagFor(id)), expected.tag); }
        catch { throw new SecurityEvidenceError('image-cleanup-precondition-failed'); }
        if (observed.id !== expected.id || observed.platform !== expected.platform) {
          throw new SecurityEvidenceError('image-cleanup-drift');
        }
      }
      for (const [id, image] of images) {
        try { await operations.removeTag(image.tag); }
        catch { throw new SecurityEvidenceError('image-cleanup-failed'); }
        images.delete(id);
      }
      closed = true;
    }
  };
}
