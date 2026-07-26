import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getTelemetryConfigPath,
  nodeTelemetryConfigFileSystem,
  readTelemetryNoticeVersion,
  recordTelemetryNotice,
  type TelemetryConfigFileSystem
} from '../src/telemetry/config.js';

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'liftoff-telemetry-config-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('telemetry config', () => {
  it('resolves XDG, Windows AppData, and Unix fallback paths', () => {
    expect(getTelemetryConfigPath({
      env: { XDG_CONFIG_HOME: '/tmp/config' },
      platform: 'linux',
      homedir: '/home/test'
    })).toBe(path.posix.join('/tmp/config', 'liftoff', 'config.json'));

    expect(getTelemetryConfigPath({
      env: { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' },
      platform: 'win32',
      homedir: 'C:\\Users\\test'
    })).toBe(path.win32.join('C:\\Users\\test\\AppData\\Roaming', 'liftoff', 'config.json'));

    expect(getTelemetryConfigPath({
      env: {},
      platform: 'darwin',
      homedir: '/Users/test'
    })).toBe(path.posix.join('/Users/test', '.config', 'liftoff', 'config.json'));
  });

  it('returns no notice for a missing file', async () => {
    const root = await temporaryRoot();
    expect(await readTelemetryNoticeVersion({ configPath: path.join(root, 'missing.json') })).toBeUndefined();
  });

  it('atomically records only notice state while preserving unrelated fields', async () => {
    const root = await temporaryRoot();
    const configPath = path.join(root, 'config.json');
    await writeFile(configPath, JSON.stringify({ profile: 'existing', telemetry: { future: true } }));

    expect(await recordTelemetryNotice({ configPath })).toBe(true);
    const parsed = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    expect(parsed).toEqual({
      profile: 'existing',
      telemetry: { future: true, noticeVersion: 1 }
    });
    expect(JSON.stringify(parsed)).not.toMatch(/anonymous|identifier|queue/i);
    expect(await readTelemetryNoticeVersion({ configPath })).toBe(1);
  });

  it('does not replace invalid JSON', async () => {
    const root = await temporaryRoot();
    const configPath = path.join(root, 'config.json');
    await writeFile(configPath, '{ invalid json');

    expect(await recordTelemetryNotice({ configPath })).toBe(false);
    expect(await readFile(configPath, 'utf8')).toBe('{ invalid json');
  });

  it('contains read-only write failures', async () => {
    const root = await temporaryRoot();
    const configPath = path.join(root, 'config.json');
    const failingFileSystem: TelemetryConfigFileSystem = {
      ...nodeTelemetryConfigFileSystem,
      writeExclusive: async () => {
        const error = new Error('read only') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
    };

    expect(await recordTelemetryNotice({ configPath, fileSystem: failingFileSystem })).toBe(false);
    await expect(readFile(configPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('converges when first-run writes occur concurrently', async () => {
    const root = await temporaryRoot();
    const configPath = path.join(root, 'nested', 'config.json');
    await mkdir(path.dirname(configPath), { recursive: true });

    const results = await Promise.all([
      recordTelemetryNotice({ configPath }),
      recordTelemetryNotice({ configPath })
    ]);
    expect(results.some(Boolean)).toBe(true);
    expect(await readTelemetryNoticeVersion({ configPath })).toBe(1);
  });
});
