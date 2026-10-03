import { readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applicationConfigurationFiles, createApplicationEnvironment } from '../src/application/repair/application-environment.js';
import { CapturedApplicationProtection } from '../src/application/repair/application-protection.js';
import { NodeCommandRunner } from '../src/process-runner.js';
import { TemporaryDirectories } from './fixtures/repair-branches.js';

const directories = new TemporaryDirectories();
afterEach(() => directories.cleanup());

async function fixture() {
  const root = await directories.make('liftoff application environment ');
  const env = await createApplicationEnvironment(process.env, path.join(root, 'project'), path.join(root, 'stage'), root);
  const mode = path.join(env.HOME!, ...(process.platform === 'darwin' ? ['Library', 'Application Support'] : []),
    'go', 'telemetry', 'mode');
  const protection = new CapturedApplicationProtection({ files: [], directories: [], outputRoles: [], toolchain: [] }, root);
  return { root, env, mode, protection };
}

describe('private application tool configuration', () => {
  it('disables Go counters in the actual private configuration before any tool starts', async () => {
    const { env, mode, protection } = await fixture();
    expect(await readFile(mode, 'utf8')).toBe('off\n');
    expect(env.GOTELEMETRY).toBeUndefined();
    expect(env.GOENV).toBe('off');
    await protection.captureControls();
    await protection.assertCurrent();
  });

  it.each([
    ['darwin', ['Library', 'Application Support', 'go', 'telemetry', 'mode']],
    ['linux', ['go', 'telemetry', 'mode']],
    ['win32', ['go', 'telemetry', 'mode']]
  ] as const)('uses the %s private HOME/APPDATA/XDG configuration, not GOENV', (platform, expected) => {
    const files = applicationConfigurationFiles(platform);
    expect(files).toHaveLength(5);
    expect(files.slice(0, 4)).toEqual(['npm-user.rc', 'npm-global.rc', 'pip.conf', 'gitconfig']
      .map(name => ({ pathParts: [name], content: '' })));
    expect(files[4]).toEqual({ pathParts: expected, content: 'off\n' });
  });

  it('confirms native Go observes off and leaves no counter files in its private profile', async ({ skip }) => {
    const { root, env, mode, protection } = await fixture();
    expect(await readFile(mode, 'utf8')).toBe('off\n');
    await protection.captureControls();
    const result = await new NodeCommandRunner().run({ executable: 'go', args: ['env', 'GOTELEMETRY'] },
      { cwd: root, env, timeoutMs: 10_000, maxOutputBytes: 1024 });
    if (result.errorCode === 'ENOENT') skip('Unrun: Go is not installed on this host.');
    expect(result.status).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout.trim()).toBe('off');
    expect(await readdir(path.dirname(mode))).toEqual(['mode']);
    await protection.assertCurrent();
  });

  it.each(['local\n', 'on\n', ''])('rejects a changed Go telemetry mode %j after control capture', async content => {
    const { mode, protection } = await fixture();
    await protection.captureControls();
    await writeFile(mode, content);
    await expect(protection.assertCurrent()).rejects.toThrow('[changed-private-configuration]');
  });

  it('refuses to treat an already enabled mode as the trusted initial configuration', async () => {
    const { mode, protection } = await fixture();
    await writeFile(mode, 'on\n');
    await expect(protection.captureControls()).rejects.toThrow('[candidate-control]');
  });

  it('requires the telemetry control to exist before admitting a candidate', async () => {
    const { mode, protection } = await fixture();
    await unlink(mode);
    await expect(protection.captureControls()).rejects.toThrow('[candidate-control]');
  });
});
