import type { RunCommandOptions, CommandRunner } from './process-runner.js';
import type { CodingAgentId, ExternalCommand } from './types.js';

export const OPEN_SPEC_PROFILE = 'custom';
export const OPEN_SPEC_DELIVERY = 'both';

export const OPEN_SPEC_WORKFLOW_IDS = [
  'propose',
  'explore',
  'new',
  'continue',
  'apply',
  'update',
  'ff',
  'sync',
  'archive',
  'bulk-archive',
  'verify',
  'onboard'
] as const;

const OPEN_SPEC_SKILL_NAMES: Record<(typeof OPEN_SPEC_WORKFLOW_IDS)[number], string> = {
  propose: 'openspec-propose',
  explore: 'openspec-explore',
  new: 'openspec-new-change',
  continue: 'openspec-continue-change',
  apply: 'openspec-apply-change',
  update: 'openspec-update-change',
  ff: 'openspec-ff-change',
  sync: 'openspec-sync-specs',
  archive: 'openspec-archive-change',
  'bulk-archive': 'openspec-bulk-archive-change',
  verify: 'openspec-verify-change',
  onboard: 'openspec-onboard'
};

export const OPEN_SPEC_COPILOT_CLOUD_PATHS = [
  ['.github', 'workflows', 'copilot-setup-steps.yml'],
  ['.github', 'agents', 'openspec.agent.md']
] as const;

export interface OpenSpecGlobalProfile {
  profile: string;
  delivery: string;
  workflows: string[];
}

export interface OpenSpecProfileInspection {
  state: OpenSpecGlobalProfile;
  compatible: boolean;
  differences: string[];
}

export interface OpenSpecProfileCommandOptions
  extends Pick<RunCommandOptions, 'cwd' | 'env' | 'stdout' | 'stderr'> {
  onCommand?: (command: ExternalCommand) => void;
}

export class OpenSpecProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenSpecProfileError';
  }
}

function commandFailure(
  action: string,
  command: ExternalCommand,
  result: Awaited<ReturnType<CommandRunner['run']>>
): OpenSpecProfileError {
  const display = [command.executable, ...command.args].join(' ');
  const detail = result.timedOut
    ? 'command timed out'
    : result.stderr.trim().split(/\r?\n/)[0] ||
      result.errorMessage ||
      `exit status ${result.status ?? 'unknown'}`;
  return new OpenSpecProfileError(`${action} failed: ${display}: ${detail}`);
}

function parseProfileOutput(value: string): OpenSpecGlobalProfile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new OpenSpecProfileError(
      `OpenSpec global profile output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new OpenSpecProfileError('OpenSpec global profile output must be a JSON object.');
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.profile !== 'string') {
    throw new OpenSpecProfileError('OpenSpec global profile output is missing string field "profile".');
  }
  if (typeof record.delivery !== 'string') {
    throw new OpenSpecProfileError('OpenSpec global profile output is missing string field "delivery".');
  }
  if (
    record.workflows !== undefined &&
    (!Array.isArray(record.workflows) ||
      record.workflows.some((workflow) => typeof workflow !== 'string'))
  ) {
    throw new OpenSpecProfileError(
      'OpenSpec global profile field "workflows" must be a string array when present.'
    );
  }
  return {
    profile: record.profile,
    delivery: record.delivery,
    workflows: record.workflows === undefined ? [] : [...record.workflows] as string[]
  };
}

export function compareOpenSpecProfile(state: OpenSpecGlobalProfile): OpenSpecProfileInspection {
  const required = new Set<string>(OPEN_SPEC_WORKFLOW_IDS);
  const observed = new Set(state.workflows);
  const missing = OPEN_SPEC_WORKFLOW_IDS.filter((workflow) => !observed.has(workflow));
  const extra = [...observed].filter((workflow) => !required.has(workflow)).sort();
  const duplicates = state.workflows.filter((workflow, index) => state.workflows.indexOf(workflow) !== index);
  const differences = [
    ...(state.profile === OPEN_SPEC_PROFILE
      ? []
      : [`profile ${JSON.stringify(state.profile)} -> ${JSON.stringify(OPEN_SPEC_PROFILE)}`]),
    ...(state.delivery === OPEN_SPEC_DELIVERY
      ? []
      : [`delivery ${JSON.stringify(state.delivery)} -> ${JSON.stringify(OPEN_SPEC_DELIVERY)}`]),
    ...(missing.length > 0 ? [`add workflows: ${missing.join(', ')}`] : []),
    ...(extra.length > 0 ? [`remove workflows: ${extra.join(', ')}`] : []),
    ...(duplicates.length > 0 ? [`remove duplicate workflows: ${[...new Set(duplicates)].join(', ')}`] : [])
  ];
  return {
    state,
    compatible: differences.length === 0 &&
      state.workflows.length === OPEN_SPEC_WORKFLOW_IDS.length,
    differences
  };
}

export function buildOpenSpecProfileReadCommand(executable = 'openspec'): ExternalCommand {
  return { executable, args: ['config', 'list', '--json'] };
}

export function buildOpenSpecProfileWriteCommands(executable = 'openspec'): ExternalCommand[] {
  return [
    {
      executable,
      args: ['config', 'set', 'workflows', JSON.stringify(OPEN_SPEC_WORKFLOW_IDS)]
    },
    {
      executable,
      args: ['config', 'set', 'delivery', OPEN_SPEC_DELIVERY]
    },
    {
      executable,
      args: ['config', 'set', 'profile', OPEN_SPEC_PROFILE]
    }
  ];
}

export async function inspectOpenSpecProfile(
  executable: string,
  runner: CommandRunner,
  options: OpenSpecProfileCommandOptions = {}
): Promise<OpenSpecProfileInspection> {
  const command = buildOpenSpecProfileReadCommand(executable);
  options.onCommand?.(command);
  const result = await runner.run(command, {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: 30_000
  });
  if (result.status !== 0 || result.timedOut) {
    throw commandFailure('OpenSpec global profile inspection', command, result);
  }
  return compareOpenSpecProfile(parseProfileOutput(result.stdout));
}

export async function configureOpenSpecProfile(
  executable: string,
  runner: CommandRunner,
  options: OpenSpecProfileCommandOptions = {}
): Promise<OpenSpecProfileInspection> {
  for (const command of buildOpenSpecProfileWriteCommands(executable)) {
    options.onCommand?.(command);
    const result = await runner.run(command, {
      cwd: options.cwd,
      env: options.env,
      timeoutMs: 30_000,
      stream: true,
      stdout: options.stdout,
      stderr: options.stderr
    });
    if (result.status !== 0 || result.timedOut) {
      throw commandFailure('OpenSpec global profile configuration', command, result);
    }
  }

  const inspection = await inspectOpenSpecProfile(executable, runner, options);
  if (!inspection.compatible) {
    throw new OpenSpecProfileError(
      `OpenSpec global profile verification failed: ${inspection.differences.join('; ')}`
    );
  }
  return inspection;
}

export function openSpecIntegrationPaths(agent: CodingAgentId): string[][] {
  if (agent === 'github-copilot') {
    return OPEN_SPEC_WORKFLOW_IDS.flatMap((workflow) => [
      ['.github', 'skills', OPEN_SPEC_SKILL_NAMES[workflow], 'SKILL.md'],
      ['.github', 'prompts', `opsx-${workflow}.prompt.md`]
    ]);
  }
  if (agent === 'claude') {
    return OPEN_SPEC_WORKFLOW_IDS.flatMap((workflow) => [
      ['.claude', 'skills', OPEN_SPEC_SKILL_NAMES[workflow], 'SKILL.md'],
      ['.claude', 'commands', 'opsx', `${workflow}.md`]
    ]);
  }
  const unsupported: never = agent;
  throw new OpenSpecProfileError(`Unsupported OpenSpec agent: ${unsupported}`);
}
