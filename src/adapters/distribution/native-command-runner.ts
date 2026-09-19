import path from 'node:path';
import type { ExternalCommand } from '../../domain/project/contracts.js';
import { NodeCommandRunner, type CommandResult, type CommandRunner, type RunCommandOptions } from '../../process-runner.js';
import { DistributionError } from '../../domain/distribution/errors.js';

export function assertNativeCommandInvocation(
  command: ExternalCommand, options: RunCommandOptions, platform: NodeJS.Platform = process.platform
): void {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (!paths.isAbsolute(command.executable) || !options.cwd || !paths.isAbsolute(options.cwd)) {
    throw new DistributionError('Native installer processes require an exact executable and neutral absolute working directory.', 'unsafe_path');
  }
  if (platform === 'win32' && /\.(?:cmd|bat|ps1|js|mjs|cjs|sh)$/iu.test(command.executable)) {
    throw new DistributionError(
      'Raw Windows script launchers have no qualified native launch contract. Bind an exact native interpreter and verified script arguments; no cmd expansion or policy bypass was attempted.',
      'qualification_required'
    );
  }
}

export class NativeCommandRunner implements CommandRunner {
  private readonly posix = new NodeCommandRunner();

  async run(command: ExternalCommand, options: RunCommandOptions = {}): Promise<CommandResult> {
    assertNativeCommandInvocation(command, options);
    if (process.platform === 'win32') {
      const { runWindowsJobCommand } = await import('../process/windows-job-runner.js');
      return runWindowsJobCommand(command, { ...options, ensureProcessTreeSettled: true });
    }
    return this.posix.run(command, { ...options, ensureProcessTreeSettled: true });
  }
}
