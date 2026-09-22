import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertWindowsNativeCwd, windowsNativeCwdUnits, WindowsNativeCwdError
} from '../src/adapters/process/windows-native-cwd.js';
import { assertRepairWorkspaceNativeCwds } from '../src/adapters/filesystem/repair-workspaces.js';
import { NodeCommandRunner } from '../src/process-runner.js';
import { runWindowsJobCommand } from '../src/adapters/process/windows-job-runner.js';
import { applicationCommandFailure } from '../src/application/repair/application-diagnostics.js';

afterEach(() => vi.restoreAllMocks());
describe('Windows native cwd admission without workspace relocation', () => {
  const at = (length: number) => `C:\\${'a'.repeat(length - 3)}`;
  it('counts the separator and NUL at the exact UTF-16 native limit', () => {
    expect(windowsNativeCwdUnits(at(258))).toBe(260);
    expect(() => assertWindowsNativeCwd(at(258), 'win32')).not.toThrow();
    expect(() => assertWindowsNativeCwd(at(259), 'win32')).toThrow(WindowsNativeCwdError);
    expect(windowsNativeCwdUnits(at(258) + '\\')).toBe(260);
    expect(() => assertWindowsNativeCwd(at(259) + '\\', 'win32')).toThrow();
    expect(windowsNativeCwdUnits('C:\\')).toBe(4);
  });
  it('measures WCHAR units rather than UTF-8 bytes or Unicode code points', () => {
    const bmp = `C:\\${'\u4e2d'.repeat(255)}`;
    expect(Buffer.byteLength(bmp)).toBeGreaterThan(260);
    expect(() => assertWindowsNativeCwd(bmp, 'win32')).not.toThrow();
    const pair = `C:\\${'\u{1f680}'.repeat(127)}a`;
    expect(pair.length).toBe(258);
    expect(() => assertWindowsNativeCwd(pair, 'win32')).not.toThrow();
    expect(() => assertWindowsNativeCwd(pair + 'b', 'win32')).toThrow();
  });
  it('does not broaden ordinary paths through unresolved or extended-prefix fallbacks', () => {
    for (const value of ['relative', '\\drive-relative', 'C:\\x\\..\\y', '\\\\?\\C:\\long', '\\\\.\\C:\\long', 'C:\\x\0']) {
      expect(() => windowsNativeCwdUnits(value)).toThrow();
    }
    expect(() => assertWindowsNativeCwd('/a/'.repeat(1000), 'linux')).not.toThrow();
    expect(() => assertWindowsNativeCwd('/a/'.repeat(1000), 'darwin')).not.toThrow();
    expect(() => assertWindowsNativeCwd('\\\\server\\share\\folder with spaces', 'win32')).not.toThrow();
  });
  it('covers full project/run identities and all nested preparation/check directories before allocation', () => {
    const root = path.win32.join('C:\\s', 'p'.repeat(64));
    const base = path.win32.join(root, '0'.repeat(64), 'project');
    const remaining = 258 - base.length - 1;
    expect(() => assertRepairWorkspaceNativeCwds(root, [[], ['a'.repeat(remaining)]], 'win32')).not.toThrow();
    expect(() => assertRepairWorkspaceNativeCwds(root, [[], ['a'.repeat(remaining + 1)]], 'win32')).toThrow(WindowsNativeCwdError);
    expect(() => assertRepairWorkspaceNativeCwds(root, [['..', 'outside']], 'win32')).toThrow();
    expect(() => assertRepairWorkspaceNativeCwds(root, [['safe'], ['nested', 'b'.repeat(remaining)]], 'win32')).toThrow(WindowsNativeCwdError);
  });
  it('returns an explicit no-spawn limit result before resolving or launching a requested executable', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
    const command = { executable: 'nonexistent-tool.exe', args: [] };
    const options = { cwd: at(283), timeoutMs: 10_000 };
    for (const result of [
      await new NodeCommandRunner().run(command, options),
      await runWindowsJobCommand(command, options)
    ]) {
      expect(result).toMatchObject({ errorCode: 'UNSUPPORTED_NATIVE_CWD', processSpawned: false, processTreeSettled: false, timedOut: false });
      expect(result.errorMessage).toContain('UTF-16');
      expect(result.errorMessage).not.toContain(options.cwd);
      expect(applicationCommandFailure({ executable: 'node', args: [], cwdPathParts: [], timeoutMs: 10000,
        maxOutputBytes: 1024, network: false }, result)?.message).toContain('[unsupported-native-cwd]');
    }
    } finally { Object.defineProperty(process, 'platform', { value: original, configurable: true }); }
  });
});
