import path from 'node:path';
import {
  readStringFlag
} from '../args/readers.js';
import {
  getEnvironment
} from '../../application/project/catalog.js';
import {
  findProjectRoot
} from '../../adapters/filesystem/project-discovery.js';
import {
  loadManifest
} from '../../application/project/manifest.js';
import {
  PlanValidationError
} from '../../domain/project/planning.js';
import {
  commandShellForPlatform,
  formatShellCommand
} from '../../adapters/process/shell-command.js';
import type {
  ExecutionContext
} from '../../application/context.js';
import type {
  ParsedArgs
} from '../../domain/project/contracts.js';
import {
  assessInfrastructureLayout,
  type InfrastructureLayoutKind
} from '../../domain/project/infrastructure-layout.js';

export async function helperCommand(
  parsed: ParsedArgs,
  context: ExecutionContext,
  tool: 'docker compose' | 'tofu'
): Promise<number> {
  const projectRoot = await findProjectRoot(context.cwd);
  let infraProject: {
    root: string;
    environments: readonly string[];
    layout: InfrastructureLayoutKind;
    layoutReason: string;
  } | undefined;
  if (projectRoot) {
    const manifest = await loadManifest(projectRoot);
    const infrastructureLayout = assessInfrastructureLayout(manifest);
    infraProject = {
      root: projectRoot,
      environments: manifest.project.workload.environments,
      layout: infrastructureLayout.kind,
      layoutReason: infrastructureLayout.reason
    };
  }

  if (
    parsed.command === 'infra' &&
    infraProject &&
    infraProject.layout !== 'independent'
  ) {
    context.presentation.commandIdentity(
      'infra',
      'OpenTofu helper command'
    );
    context.presentation.error(
      `Infrastructure layout is ${infraProject.layout}; no environment-switch command was emitted.`,
      `${infraProject.layoutReason} Plan an explicit reviewed migration before using Liftoff infrastructure helpers.`
    );
    return 1;
  }

  const command = parsed.command === 'dev'
    ? buildDevCommand(parsed)
    : buildInfraCommand(parsed, infraProject);
  context.presentation.commandIdentity(
    parsed.command ?? tool,
    `${tool} helper command`
  );
  context.presentation.section(
    `${tool} helper command (${process.platform === 'win32' ? 'PowerShell' : 'POSIX shell'})`,
    []
  );
  context.presentation.command(command);
  return 0;
}

export function buildDevCommand(parsed: ParsedArgs): string {
  const shell = commandShellForPlatform(process.platform);
  switch (parsed.subcommand) {
    case 'down':
      return formatShellCommand(
        { executable: 'docker', args: ['compose', 'down'] },
        shell
      );
    case 'logs':
      return formatShellCommand(
        { executable: 'docker', args: ['compose', 'logs', '-f'] },
        shell
      );
    case 'reset':
      return formatShellCommand(
        { executable: 'docker', args: ['compose', 'down', '--volumes'] },
        shell
      );
    case 'up':
    default: {
      const profile = readStringFlag(parsed.flags, 'profile');
      return formatShellCommand({
        executable: 'docker',
        args: [
          'compose',
          ...(profile ? ['--profile', profile] : []),
          'up',
          '--build'
        ]
      }, shell);
    }
  }
}

export function buildInfraCommand(
  parsed: ParsedArgs,
  project?: {
    root: string;
    environments: readonly string[];
  }
): string {
  const requestedEnvironment = readStringFlag(parsed.flags, 'env');
  const env = requestedEnvironment ?? project?.environments[0] ?? 'dev';
  const environment = getEnvironment(env);
  if (!environment) {
    throw new PlanValidationError([
      `Unsupported environment: ${env}. Supported environments: dev, staging, prod.`
    ]);
  }
  if (
    project &&
    requestedEnvironment !== undefined &&
    !project.environments.includes(environment.id)
  ) {
    throw new PlanValidationError([
      `Environment ${environment.id} is not selected for this project. ` +
      `Selected environments: ${project.environments.join(', ')}.`
    ]);
  }
  const infrastructureRoot = path.join(
    ...(project ? [project.root] : []),
    'infrastructure',
    'opentofu',
    'azure',
    'environments',
    environment.id
  );
  const args = [`-chdir=${infrastructureRoot}`];
  switch (parsed.subcommand) {
    case 'apply':
      args.push('apply', `-var-file=${environment.id}.tfvars`);
      break;
    case 'output':
      args.push('output');
      break;
    case 'init':
      args.push('init');
      break;
    case 'plan':
    default:
      args.push('plan', `-var-file=${environment.id}.tfvars`);
      break;
  }
  return formatShellCommand(
    { executable: 'tofu', args },
    commandShellForPlatform(process.platform)
  );
}
