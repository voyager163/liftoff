import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';
import type {
  CommandResult,
  CommandRunner,
  RunCommandOptions
} from '../src/process-runner.js';
import type { ExternalCommand } from '../src/types.js';

export class CaptureStream extends Writable {
  chunks: string[] = [];

  override _write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(String(chunk));
    callback();
  }

  text(): string {
    return this.chunks.join('');
  }
}

export class ReadyInitRunner implements CommandRunner {
    calls: ExternalCommand[] = [];
    callDetails: Array<{ command: ExternalCommand; options?: RunCommandOptions }> = [];
    private readonly missing: Set<string>;
    private readonly specKitState = new Map<string, { defaultIntegration: string; installed: string[] }>();

    constructor(options: { gitRoot?: string; missing?: string[] } = {}) {
      this.gitRoot = options.gitRoot;
      this.missing = new Set(options.missing ?? []);
    }

    readonly gitRoot?: string;

    async run(command: ExternalCommand, options?: RunCommandOptions): Promise<CommandResult> {
      this.calls.push(command);
      this.callDetails.push({ command, options });
      if (command.executable === 'git') {
        return this.gitRoot
          ? this.result(command, { stdout: `${this.gitRoot}\n` })
          : this.result(command, { status: 128, stderr: 'not a git repository' });
      }
      if (command.executable === 'npm' && command.args[0] === 'install') {
        if (command.args.some((argument) => argument.includes('@fission-ai/openspec'))) {
          this.missing.delete('openspec');
        }
        return this.result(command, { stdout: 'installed\n' });
      }
      if (command.executable === 'npm') {
        return this.result(command, { stdout: '10.0.0\n' });
      }
      if (this.missing.has(command.executable)) {
        return this.result(command, {
          status: null,
          errorCode: 'ENOENT',
          errorMessage: `${command.executable} not found`
        });
      }

      if (command.executable === 'openspec' && command.args[0] === 'init') {
        await this.writeOpenSpec(options?.cwd, command);
        return this.result(command);
      }
      if (command.executable === 'specify' && (command.args[0] === 'init' || command.args[0] === 'integration')) {
        await this.writeSpecKit(options?.cwd, command);
        return this.result(command);
      }

      const key = `${command.executable} ${command.args.join(' ')}`;
      if (key.startsWith('node ')) return this.result(command, { stdout: 'v20.19.0\n' });
      if (key.startsWith('python3 ') || key.startsWith('python ') || key.startsWith('py ')) {
        return this.result(command, { stdout: 'Python 3.12.0\n' });
      }
      if (key.startsWith('go ')) return this.result(command, { stdout: 'go version go1.23.0 test\n' });
      if (key.startsWith('uv ')) return this.result(command, { stdout: 'uv 0.6.0\n' });
      if (key === 'docker --version') return this.result(command, { stdout: 'Docker version 27.0.0\n' });
      if (key.startsWith('docker info')) return this.result(command, { stdout: '27.0.0\n' });
      if (key.startsWith('tofu ')) return this.result(command, { stdout: 'OpenTofu v1.9.0\n' });
      if (key.startsWith('az version')) return this.result(command, { stdout: '{"azure-cli":"2.70.0"}\n' });
      if (key.startsWith('az account show')) return this.result(command);
      if (key === 'openspec --version') return this.result(command, { stdout: '1.6.0\n' });
      if (key === 'specify --version') return this.result(command, { stdout: 'Specify CLI 0.14.1\n' });
      if (key === 'copilot --version') return this.result(command, { stdout: 'GitHub Copilot CLI 1.0.0\n' });
      if (key === 'claude --version') return this.result(command, { stdout: 'Claude Code 1.0.0\n' });
      if (key === 'claude doctor') return this.result(command, { stdout: 'healthy\n' });
      if (key.startsWith('brew ') || key.startsWith('winget ')) {
        return this.result(command, { stdout: 'package manager ready\n' });
      }
      return this.result(command, { stdout: '1.0.0\n' });
    }

    private result(command: ExternalCommand, values: Partial<CommandResult> = {}): CommandResult {
      return {
        command,
        displayCommand: [command.executable, ...command.args].join(' '),
        status: 0,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        ...values
      };
    }

    private async writeOpenSpec(cwd: string | undefined, command: ExternalCommand): Promise<void> {
      if (!cwd) throw new Error('OpenSpec fixture command requires cwd');
      const tools = command.args[command.args.indexOf('--tools') + 1]?.split(',') ?? [];
      await this.write(path.join(cwd, 'openspec', 'config.yaml'), 'schema: spec-driven\n');
      if (tools.includes('github-copilot')) {
        await this.write(path.join(cwd, '.github', 'skills', 'openspec-apply-change', 'SKILL.md'), 'copilot\n');
      }
      if (tools.includes('claude')) {
        await this.write(path.join(cwd, '.claude', 'skills', 'openspec-apply-change', 'SKILL.md'), 'claude\n');
      }
    }

    private async writeSpecKit(cwd: string | undefined, command: ExternalCommand): Promise<void> {
      if (!cwd) throw new Error('Spec Kit fixture command requires cwd');
      let state = this.specKitState.get(cwd);
      if (command.args[0] === 'init') {
        const defaultIntegration = command.args[command.args.indexOf('--integration') + 1];
        state = { defaultIntegration, installed: [defaultIntegration] };
        this.specKitState.set(cwd, state);
        await this.write(path.join(cwd, '.specify', 'init-options.json'), '{}\n');
        await this.write(path.join(cwd, '.specify', 'templates', 'spec-template.md'), 'official\n');
        await this.write(path.join(cwd, '.specify', 'templates', 'plan-template.md'), 'official\n');
      } else if (state) {
        const integration = command.args[2];
        if (!state.installed.includes(integration)) state.installed.push(integration);
      }
      if (!state) throw new Error('Spec Kit fixture integration ran before init');
      for (const integration of state.installed) {
        const root = integration === 'copilot' ? '.github' : '.claude';
        await this.write(path.join(cwd, root, 'skills', 'speckit-specify', 'SKILL.md'), `${integration}\n`);
      }
      await this.write(path.join(cwd, '.specify', 'integration.json'), `${JSON.stringify({
        integration_state_schema: 1,
        integration: state.defaultIntegration,
        default_integration: state.defaultIntegration,
        installed_integrations: state.installed,
        integration_settings: {}
      }, null, 2)}\n`);
    }

    private async write(file: string, content: string): Promise<void> {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
}