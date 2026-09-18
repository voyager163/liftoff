import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { NativeTarget } from '../../src/domain/distribution/contracts.js';
import type { ExternalCommand } from '../../src/domain/project/contracts.js';
import { NodeCommandRunner, type CommandRunner, type RunCommandOptions } from '../../src/process-runner.js';
import { posixLauncher } from '../../scripts/distribution/assemble-native-bundle.mjs';

// Models only the foreign OS execution port. Signed inventory/format admission stays real;
// running installed CLI bytes on the test host is not foreign native-runtime qualification.
export class ForeignHostRuntimeDouble implements CommandRunner {
  readonly runtimeBytes = Buffer.alloc(128);
  readonly bridgedCommands: Array<{ requested: ExternalCommand; executed: ExternalCommand }> = [];
  private readonly runner = new NodeCommandRunner();

  constructor(private readonly root: string, target: NativeTarget) {
    const arm64 = target.endsWith('-arm64');
    if (target.startsWith('darwin-')) {
      this.runtimeBytes.writeUInt32LE(0xfeedfacf, 0);
      this.runtimeBytes.writeUInt32LE(arm64 ? 0x0100000c : 0x01000007, 4);
      this.runtimeBytes.writeUInt32LE(2, 12);
    } else if (target.startsWith('linux-')) {
      this.runtimeBytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
      this.runtimeBytes.writeUInt16LE(2, 16);
      this.runtimeBytes.writeUInt16LE(arm64 ? 183 : 62, 18);
    } else {
      throw new Error('The POSIX source execution double does not model Windows execution.');
    }
    this.runtimeBytes.write('SOURCE TEST DOUBLE - NOT A NATIVE RUNTIME', 64, 'ascii');
  }

  async run(command: ExternalCommand, options?: RunCommandOptions) {
    if (!path.isAbsolute(command.executable) || !['node', 'liftoff'].includes(path.basename(command.executable))) {
      return this.runner.run(command, options);
    }
    const executable = await realpath(command.executable);
    const runtimeInvocation = path.basename(executable) === 'node' && path.basename(path.dirname(executable)) === 'runtime';
    const launcherInvocation = path.basename(executable) === 'liftoff' && path.basename(path.dirname(executable)) === 'bin';
    if (!runtimeInvocation && !launcherInvocation) return this.runner.run(command, options);
    const relative = path.relative(this.root, executable);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('Foreign-host execution double cannot execute outside its exact fixture.');
    }
    const bundle = path.dirname(path.dirname(executable));
    const runtime = path.join(bundle, 'runtime', 'node');
    const cli = path.join(bundle, 'dist', 'cli.js');
    if (!(await readFile(runtime)).equals(this.runtimeBytes)) {
      throw new Error('Foreign-host execution double requires its exact synthetic runtime bytes.');
    }
    let args: string[];
    if (launcherInvocation) {
      if (await readFile(executable, 'utf8') !== posixLauncher() ||
          command.args.length !== 1 || command.args[0] !== '--version') {
        throw new Error('Foreign-host execution double only models the exact packaged version launcher.');
      }
      args = [cli, '--version'];
    } else if (command.args.length === 1 && command.args[0] === '--version') {
      args = ['--version'];
    } else if (command.args.length === 2 && command.args[0] === cli && command.args[1] === '--version') {
      args = [cli, '--version'];
    } else {
      throw new Error('Foreign-host execution double received an unregistered runtime invocation.');
    }
    const executed = { executable: process.execPath, args };
    this.bridgedCommands.push({ requested: command, executed });
    return this.runner.run(executed, options);
  }
}
