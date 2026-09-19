import { createHash } from 'node:crypto';

export function githubSourceFixture(path: string, content: string | Uint8Array) {
  const bytes = Buffer.from(content);
  return {
    type: 'file', path, encoding: 'base64', content: bytes.toString('base64'), size: bytes.length,
    sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  };
}
