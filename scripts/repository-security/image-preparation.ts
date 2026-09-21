import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SecurityEvidenceError } from './evidence.ts';

export const imageUvRelease = Object.freeze({
  version: '0.12.7', pythonVersion: '3.14.7',
  buildCommit: '61291a8ca', buildDate: '2026-08-27',
  assets: {
    'darwin-arm64': ['uv-aarch64-apple-darwin', '127ebdda7ad953cdf198e964b570ea5771b85467ea93eb7cb6d6f8e6f55408f3'],
    'darwin-x64': ['uv-x86_64-apple-darwin', '06b8ae1da8c2661c5434507a66f8c2b0b835933bf955b5958a9ac357a37d1959'],
    'linux-x64': ['uv-x86_64-unknown-linux-gnu', '788f18abea7c5f55d6216e4f5613fd89d4d59b631efeec117b2b07fe72f1da21'],
    'linux-arm64': ['uv-aarch64-unknown-linux-gnu', '66393193038dd7eb108abd7a218d9cec04ac70ab98242b0720fa94de19223b7c']
  } as const
});
type Execute = (file: string, args: readonly string[], options?: {
  cwd?: string; timeoutMs?: number; maxBytes?: number; discardStderr?: boolean;
}) => Promise<Buffer>;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fail(code: string): never { throw new SecurityEvidenceError(`image-preparation-${code}`); }

export function verifyImageUvVersion(output: string, platform: keyof typeof imageUvRelease.assets) {
  const pin = imageUvRelease.assets[platform];
  const target = pin[0].slice('uv-'.length);
  const expected = `uv ${imageUvRelease.version} (${imageUvRelease.buildCommit} ${imageUvRelease.buildDate} ${target})\n`;
  if (output !== expected && output !== expected.replace('\n', '\r\n')) fail('uv-version');
  return { version: imageUvRelease.version, commit: imageUvRelease.buildCommit, target };
}

export function pythonPreparationArguments(python: string, functions: boolean) {
  if (!path.isAbsolute(python) || /[\0\r\n]/.test(python)) fail('python-path');
  return ['sync', '--frozen', '--python', python, '--no-managed-python', '--no-python-downloads',
    '--no-config', '--keyring-provider', 'disabled', '--default-index', 'https://pypi.org/simple',
    '--project', 'backend', '--extra', 'test', ...(functions ? ['--extra', 'functions'] : [])];
}

export async function restoreImagePythonPreparation(root: string, pythonInput: string, execute: Execute) {
  if (!path.isAbsolute(root) || !path.isAbsolute(pythonInput)) fail('absolute-paths-required');
  const python = await realpath(pythonInput), status = await lstat(python);
  if (!status.isFile() || status.size > 128 * 1024 * 1024) fail('python-file');
  const pythonBytes = await readFile(python), pythonDigest = hash(pythonBytes);
  pythonBytes.fill(0);
  const version = await execute(python, ['-I', '-S', '--version'], { timeoutMs: 15_000, maxBytes: 4096 });
  try { if (version.toString().trim() !== `Python ${imageUvRelease.pythonVersion}`) fail('python-version'); }
  finally { version.fill(0); }
  const pin = imageUvRelease.assets[`${process.platform}-${process.arch}` as keyof typeof imageUvRelease.assets];
  if (!pin) fail('host-unqualified');
  let url = new URL(`https://github.com/astral-sh/uv/releases/download/${imageUvRelease.version}/${pin[0]}.tar.gz`);
  let archive: Buffer | undefined;
  try {
    for (let redirects = 0; redirects < 5; redirects++) {
      const response = await fetch(url, { credentials: 'omit', redirect: 'manual', signal: AbortSignal.timeout(120_000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const next = new URL(response.headers.get('location') ?? '', url);
        await response.body?.cancel();
        if (next.protocol !== 'https:' || next.username || next.password ||
            !['github.com', 'release-assets.githubusercontent.com'].includes(next.hostname)) fail('tool-origin');
        url = next;
        continue;
      }
      if (!response.ok || !response.body) fail('tool-download');
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 64 * 1024 * 1024) fail('tool-download-bound');
        chunks.push(Buffer.from(chunk));
      }
      archive = Buffer.concat(chunks);
      break;
    }
    if (!archive || hash(archive) !== pin[1]) fail('tool-digest');
    const file = path.join(root, 'tool', 'uv.tar.gz');
    await writeFile(file, archive, { flag: 'wx', mode: 0o600 });
    const binary = await execute('/usr/bin/tar', ['-xOzf', file, `${pin[0]}/uv`], {
      timeoutMs: 60_000, maxBytes: 128 * 1024 * 1024
    });
    const uv = path.join(root, 'tool', 'uv'), uvDigest = hash(binary);
    try { await writeFile(uv, binary, { flag: 'wx', mode: 0o700 }); } finally { binary.fill(0); }
    const output = await execute(uv, ['--version'], { timeoutMs: 15_000, maxBytes: 4096 });
    try { verifyImageUvVersion(output.toString(), `${process.platform}-${process.arch}` as keyof typeof imageUvRelease.assets); }
    finally { output.fill(0); }
    return {
      identity: { uvVersion: imageUvRelease.version, archiveDigest: `sha256:${pin[1]}`,
        binaryDigest: `sha256:${uvDigest}`, pythonVersion: imageUvRelease.pythonVersion,
        pythonDigest: `sha256:${pythonDigest}`, interpreterDownloads: false },
      async prepare(project: string, functions: boolean) {
        const relative = path.relative(path.join(root, 'contexts'), project);
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
            await realpath(project) !== project) fail('project-outside-context');
        for (const [file, expected] of [[uv, uvDigest], [python, pythonDigest]] as const) {
          const bytes = await readFile(file);
          try { if (hash(bytes) !== expected) fail('runtime-drift'); } finally { bytes.fill(0); }
        }
        const result = await execute(uv, pythonPreparationArguments(python, functions), {
          cwd: project, timeoutMs: 20 * 60_000, maxBytes: 1024 * 1024, discardStderr: true
        });
        result.fill(0);
      }
    };
  } catch (error) {
    if (error instanceof SecurityEvidenceError) throw error;
    return fail('tool-restore-failed');
  } finally { archive?.fill(0); }
}
