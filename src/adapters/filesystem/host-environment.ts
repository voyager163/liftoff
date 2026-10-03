import { readFile } from 'node:fs/promises';
import type { HostEnvironment } from '../../domain/workstation/contracts.js';
import { parseLinuxFamily } from '../../domain/workstation/remediation.js';

export async function detectHostEnvironment(
  platform: NodeJS.Platform = process.platform,
  osReleasePath = '/etc/os-release'
): Promise<HostEnvironment> {
  if (platform === 'darwin' || platform === 'win32') {
    return { platform, linuxFamily: 'unknown' };
  }
  let osRelease = '';
  try {
    osRelease = await readFile(osReleasePath, 'utf8');
  } catch {
    // The exact distribution is optional; unknown still yields a safe manual remedy.
  }
  return { platform: 'linux', linuxFamily: parseLinuxFamily(osRelease) };
}
