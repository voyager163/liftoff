import { access } from 'node:fs/promises';
import path from 'node:path';
import { stdin as processInput, stdout as processOutput } from 'node:process';
import { createInterface } from 'node:readline/promises';
import type { Readable } from 'node:stream';
import {
  apiStacks,
  codingAgents,
  environments,
  getApiStack,
  getCodingAgent,
  getFrameworkDefinition,
  getPattern,
  getProjectType,
  getProvider,
  getSpecWorkflow,
  patterns,
  projectTypes,
  providers,
  resolveRegion,
  specWorkflows
} from './catalogs.js';
import type { DependencyCommandPlan } from './project-dependencies.js';
import { projectPlanEntries } from './planner.js';
import { formatCommand, type CommandRunner } from './process-runner.js';
import { PresentationSession } from './terminal.js';
import type { UpdateImpact } from './update-impact.js';
import type {
  CodingAgentId,
  ProjectOptions,
  ProjectPlan,
  RegionDefinition,
  SpecWorkflowId
} from './types.js';

interface AgentCheckboxChoice {
  name: string;
  value: CodingAgentId;
  checked: boolean;
}

export type AgentCheckboxPrompt = (
  config: {
    message: string;
    choices: AgentCheckboxChoice[];
    required: boolean;
    validate: (selected: readonly CodingAgentId[]) => true | string;
  },
  context: {
    input: Readable;
    output: NodeJS.WritableStream;
  }
) => Promise<CodingAgentId[]>;

export interface InteractiveDependencies {
  input?: Readable;
  output?: NodeJS.WritableStream;
  presentation?: PresentationSession;
  cwd?: string;
  configuredRoot?: string;
  runner?: CommandRunner;
  checkboxPrompt?: AgentCheckboxPrompt;
}

export interface ToolInstallationPrompt {
  label: string;
  severity: string;
  purpose: string;
  requirement: string;
  observed: string;
  command?: string;
  remedy?: string;
}

interface SelectableChoice {
  value: string;
  label: string;
  disabled: boolean;
}

interface AgentDiscovery {
  configured: Set<CodingAgentId>;
  detected: Set<CodingAgentId>;
  defaults: CodingAgentId[];
}

export class InteractiveCancelledError extends Error {
  constructor(message = 'Interactive initialization was cancelled.') {
    super(message);
    this.name = 'InteractiveCancelledError';
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

function isPromptCancellation(error: unknown): boolean {
  return error instanceof Error && (
    error.name === 'ExitPromptError' ||
    error.name === 'AbortPromptError' ||
    error.message.includes('User force closed the prompt')
  );
}

export function isInteractiveTerminal(
  input: Readable | undefined = processInput,
  output: NodeJS.WritableStream = processOutput
): boolean {
  const resolvedInput = input ?? processInput;
  const ttyInput = resolvedInput as Readable & { isTTY?: boolean };
  const ttyOutput = output as NodeJS.WritableStream & { isTTY?: boolean };
  return ttyInput.isTTY === true && ttyOutput.isTTY === true;
}

function supportsRawMode(input: Readable): boolean {
  return typeof (input as Readable & {
    setRawMode?: (mode: boolean) => void;
  }).setRawMode === 'function';
}

export class InteractivePrompter {
  private readonly input: Readable;
  private readonly output: NodeJS.WritableStream;
  private readonly presentation: PresentationSession;
  private readonly cwd: string;
  private readonly configuredRoot?: string;
  private readonly runner?: CommandRunner;
  private readonly checkboxPrompt?: AgentCheckboxPrompt;
  private rl?: ReturnType<typeof createInterface>;
  private lines?: AsyncIterator<string>;
  private closed = false;

  constructor(dependencies: InteractiveDependencies = {}) {
    this.input = dependencies.input ?? processInput;
    this.output = dependencies.output ?? processOutput;
    this.presentation = dependencies.presentation ?? new PresentationSession({
      stdout: this.output,
      stderr: this.output
    });
    this.cwd = dependencies.cwd ?? process.cwd();
    this.configuredRoot = dependencies.configuredRoot;
    this.runner = dependencies.runner;
    this.checkboxPrompt = dependencies.checkboxPrompt;
  }

  close(): void {
    this.closed = true;
    this.releaseLineInput();
  }

  async promptForInitOptions(initial: ProjectOptions): Promise<ProjectOptions> {
    const projectName = initial.projectName ?? await this.askRequired('Project name');
    const inferredProjectType = initial.projectType ?? (initial.pattern ? 'genai' : initial.apiStack ? 'standard' : undefined);
    const projectType = inferredProjectType ??
      await this.choose('Select workload', projectTypes.map((workload) => ({
        value: workload.id,
        label: workload.label,
        disabled: false
      })), 'genai');
    const pattern = projectType === 'genai'
      ? initial.pattern ?? await this.choose('Select GenAI pattern', patterns.map((pattern) => ({
          value: pattern.id,
          label: `${pattern.label} (${pattern.scaffoldStatus})`,
          disabled: false
        })))
      : initial.pattern;
    const apiStack = projectType === 'standard'
      ? initial.apiStack ?? await this.choose('Select API stack', apiStacks.map((stack) => ({
          value: stack.id,
          label: `${stack.label} (${stack.databaseTooling})`,
          disabled: false
        })), 'python-fastapi')
      : projectType === 'genai'
        ? initial.apiStack ?? 'python-fastapi'
        : initial.apiStack;
    const cloud = projectType === 'power-apps-code-app'
      ? initial.cloud
      : initial.cloud ?? await this.choose('Target cloud', providers.map((provider) => ({
          value: provider.id,
          label: `${provider.label}${provider.status === 'planned' ? ' - planned' : ''}`,
          disabled: provider.status === 'planned'
        })));
    const region = projectType === 'power-apps-code-app'
      ? initial.region
      : initial.region ?? await this.promptForRegion(cloud!);
    const includeFrontend = projectType === 'power-apps-code-app'
      ? initial.includeFrontend
      : initial.includeFrontend ?? await this.confirm('Include frontend? (Vue 3 + Tailwind)', false);
    const specWorkflow = initial.specWorkflow ?? await this.choose(
      'Select spec-driven workflow',
      specWorkflows.map((workflow) => ({
        value: workflow.id,
        label: workflow.label,
        disabled: false
      })),
      'openspec'
    );
    const selectedAgents = initial.agents ?? await this.askAgents(specWorkflow as SpecWorkflowId);
    const normalizedAgents = selectedAgents
      .map((agent) => getCodingAgent(agent)?.id)
      .filter((agent): agent is NonNullable<typeof agent> => agent !== undefined);
    const defaultAgent = specWorkflow === 'spec-kit' && normalizedAgents.length > 1
      ? initial.defaultAgent ?? await this.choose(
          'Select the default Spec Kit agent',
          codingAgents
            .filter((agent) => normalizedAgents.includes(agent.id))
            .map((agent) => ({ value: agent.id, label: agent.label, disabled: false })),
          normalizedAgents[0]
        )
      : specWorkflow === 'spec-kit'
        ? normalizedAgents[0]
        : undefined;
    const codeAppsPlugin = projectType === 'power-apps-code-app'
      ? initial.codeAppsPlugin ??
        await this.confirm('Include Microsoft Code Apps preview plugin guidance?', false)
      : initial.codeAppsPlugin;
    const selectedEnvironments = projectType === 'power-apps-code-app'
      ? initial.environments
      : initial.environments ?? await this.askEnvironments();

    return {
      ...initial,
      projectName,
      projectType,
      apiStack,
      pattern,
      cloud,
      region,
      includeFrontend,
      specWorkflow,
      agents: normalizedAgents,
      ...(defaultAgent ? { defaultAgent } : {}),
      ...(selectedEnvironments ? { environments: selectedEnvironments } : {}),
      ...(codeAppsPlugin !== undefined ? { codeAppsPlugin } : {})
    };
  }

  async confirmPlan(
    plan: ProjectPlan,
    yes?: boolean,
    actionLabel = 'Initialize project?'
  ): Promise<boolean> {
    this.presentation.definitions('Resolved project plan', projectPlanEntries(plan));
    return yes ? true : this.confirm(actionLabel, true);
  }

  async confirmToolInstallation(prompt: ToolInstallationPrompt | string): Promise<boolean> {
    if (typeof prompt === 'string') {
      this.presentation.section('Workstation tool requiring action', prompt.split(/\r?\n/));
    } else {
      this.presentation.definitions('Workstation tool requiring action', [
        { label: 'Tool', value: `${prompt.label} [${prompt.severity}]` },
        { label: 'Purpose', value: prompt.purpose },
        { label: 'Requirement', value: prompt.requirement },
        { label: 'Observed', value: prompt.observed }
      ]);
      if (prompt.command) {
        this.presentation.command(prompt.command);
      }
      if (prompt.remedy) {
        this.presentation.remedy(prompt.remedy);
      }
    }
    return this.confirm('Run this allowlisted installation command?', false);
  }

  async confirmFileReplacements(paths: readonly string[]): Promise<boolean> {
    this.presentation.bullets('Existing regular files with different content', paths);
    return this.confirm('Replace every listed file?', false);
  }

  presentUpdateImpact(impact: UpdateImpact): void {
    const safeParts = [
      this.impactPart(impact.creates.length, 'create', 'creates'),
      this.impactPart(impact.restores.length, 'restore', 'restores'),
      this.impactPart(impact.replacements.length, 'replace', 'replaces'),
      this.impactPart(impact.moves.length, 'move', 'moves'),
      this.impactPart(
        impact.recordedStateRefreshes.length,
        'recorded-state refresh',
        'recorded-state refreshes'
      )
    ].filter((part): part is string => part !== undefined);
    const removedPaths = impact.managedPathsRemovedOnOverwrite.length > 0
      ? `${impact.managedPathsRemoved.length} safe, ${impact.managedPathsRemovedOnOverwrite.length} more if conflicts are approved`
      : `${impact.managedPathsRemoved.length}`;

    this.presentation.definitions('Update impact', [
      {
        label: 'Safe actions',
        value: impact.safeActionCount > 0
          ? `${impact.safeActionCount} (${safeParts.join(', ')})`
          : 'None'
      },
      {
        label: 'Local or user-owned files at risk',
        value: impact.localOrUserOwnedFilesAtRisk > 0
          ? `${impact.localOrUserOwnedFilesAtRisk} (requires separate consent)`
          : '0'
      },
      { label: 'Managed old paths removed', value: removedPaths },
      {
        label: 'Orphans preserved',
        value: `${impact.orphansPreserved.length} (never deleted automatically)`
      },
      {
        label: 'Manifest updated',
        value: impact.manifestWillUpdate ? 'Yes, after an accepted update' : 'No'
      },
      {
        label: 'Dependency definitions',
        value: impact.dependencyDefinitions.length > 0
          ? impact.dependencyDefinitions.join(', ')
          : 'None'
      },
      { label: 'Dependencies installed', value: 'No' },
      {
        label: 'Liftoff backup after success',
        value: 'No; rollback is available only if the transaction fails'
      }
    ]);
  }

  async confirmSafeUpdate(actionCount: number): Promise<boolean> {
    const noun = actionCount === 1 ? 'action' : 'actions';
    return this.confirm(`Apply these ${actionCount} safe update ${noun} now?`, false);
  }

  async confirmConflictOverwrite(
    paths: readonly string[],
    managedPathsRemoved: readonly string[]
  ): Promise<boolean> {
    this.presentation.bullets('Local or user-owned files at risk', paths);
    if (managedPathsRemoved.length > 0) {
      this.presentation.bullets(
        'Managed old paths removed on overwrite',
        managedPathsRemoved
      );
    }
    this.presentation.warning(
      'A successful overwrite permanently replaces the listed local content. ' +
      'Liftoff keeps no backup after success; commit or copy local work first.'
    );
    const noun = paths.length === 1 ? 'conflict' : 'conflicts';
    return this.confirm(`Overwrite all ${paths.length} listed ${noun}?`, false);
  }

  async confirmDependencyInstallation(commands: DependencyCommandPlan[]): Promise<boolean> {
    this.presentation.table(
      'Project dependency commands',
      ['Purpose', 'Working directory', 'Command'],
      commands.map((command) => [
        command.label,
        command.cwd,
        formatCommand(command.command)
      ])
    );
    return this.confirm('Install project-local dependencies now?', false);
  }

  private async askRequired(label: string): Promise<string> {
    while (true) {
      const answer = (await this.question(label)).trim();
      if (answer) {
        return answer;
      }
      this.presentation.warning(`${label} is required.`);
    }
  }

  private async choose(
    label: string,
    options: SelectableChoice[],
    defaultValue?: string
  ): Promise<string> {
    while (true) {
      this.presentation.choices(label, options.map((option) => ({
        label: option.label,
        value: option.value,
        disabled: option.disabled,
        default: option.value === defaultValue
      })));
      const answer = (await this.question('Select option', defaultValue)).trim();
      if (!answer && defaultValue) {
        return defaultValue;
      }
      const selectedIndex = Number(answer) - 1;
      const selected = options[selectedIndex] ?? options.find((option) => option.value === answer);
      if (!selected) {
        this.presentation.warning('Please choose a valid option.');
        continue;
      }
      if (selected.disabled) {
        this.presentation.warning(`${selected.label} is not available in V1.`);
        continue;
      }
      return selected.value;
    }
  }

  private async confirm(label: string, defaultValue: boolean): Promise<boolean> {
    const suffix = defaultValue ? 'Y/n' : 'y/N';
    const answer = (await this.question(label, suffix)).trim().toLowerCase();
    if (!answer) {
      return defaultValue;
    }
    return answer === 'y' || answer === 'yes';
  }

  private async promptForRegion(cloud: string): Promise<string> {
    const provider = getProvider(cloud);
    if (!provider || provider.id !== 'azure') {
      return '';
    }

    while (true) {
      const answer = (await this.question('Azure region', 'East US / eastus')).trim();
      const resolution = resolveRegion(provider.id, answer);
      if (resolution.status === 'resolved') {
        return resolution.region.slug;
      }
      if (resolution.status === 'ambiguous') {
        const selected = await this.chooseRegion(resolution.matches);
        return selected.slug;
      }
      this.presentation.warning(
        `Unknown Azure region: ${resolution.input}. Try a region name such as eastus or korea.`
      );
    }
  }

  private async chooseRegion(matches: RegionDefinition[]): Promise<RegionDefinition> {
    this.presentation.table(
      'Matching Azure regions',
      ['Option', 'Region', 'Identifier'],
      matches.map((region, index) => [`${index + 1}`, region.displayName, region.slug])
    );
    while (true) {
      const answer = (await this.question('Select deployment region')).trim();
      const selected = matches[Number(answer) - 1] ??
        matches.find((region) => region.slug === answer);
      if (selected) {
        return selected;
      }
      this.presentation.warning('Please choose a valid deployment region.');
    }
  }

  private async askEnvironments(): Promise<string[]> {
    const answer = (await this.question('Environments', 'dev,test,prod')).trim();
    if (!answer) {
      return environments.map((environment) => environment.id);
    }
    return answer.split(',').map((value) => value.trim()).filter(Boolean);
  }

  private async askAgents(specWorkflow: SpecWorkflowId): Promise<string[]> {
    const discovery = await this.discoverAgents(specWorkflow);
    if (
      isInteractiveTerminal(this.input, this.output) &&
      supportsRawMode(this.input)
    ) {
      return this.askAgentsWithCheckbox(discovery);
    }
    return this.askAgentsWithLines(discovery);
  }

  private async askAgentsWithLines(discovery: AgentDiscovery): Promise<string[]> {
    while (true) {
      this.presentation.choices('Select one or more AI coding agents', codingAgents.map((agent) => ({
        label: this.agentChoiceLabel(agent.id, discovery),
        value: agent.id,
        default: discovery.defaults.includes(agent.id),
        selected: discovery.defaults.includes(agent.id)
      })));
      const defaultSelection = discovery.defaults
        .map((agentId) => `${codingAgents.findIndex((agent) => agent.id === agentId) + 1}`)
        .join(',');
      const answer = (await this.question(
        'Select comma-separated options',
        defaultSelection
      )).trim() || defaultSelection;
      const selected = answer.split(',').map((value) => value.trim()).filter(Boolean);
      const resolved = selected.map((value) => {
        const byIndex = codingAgents[Number(value) - 1];
        return byIndex ?? getCodingAgent(value);
      });
      if (resolved.some((agent) => !agent)) {
        this.presentation.warning('Please choose valid agent options.');
        continue;
      }
      return codingAgents
        .filter((agent) => resolved.some((selectedAgent) => selectedAgent?.id === agent.id))
        .map((agent) => agent.id);
    }
  }

  private async askAgentsWithCheckbox(discovery: AgentDiscovery): Promise<CodingAgentId[]> {
    this.releaseLineInput();
    try {
      const checkbox = this.checkboxPrompt ?? (await import('@inquirer/prompts')).checkbox;
      const selected = await checkbox({
        message: 'Select one or more AI coding agents',
        choices: codingAgents.map((agent) => ({
          name: this.agentChoiceLabel(agent.id, discovery),
          value: agent.id,
          checked: discovery.defaults.includes(agent.id)
        })),
        required: true,
        validate: (values) => values.length > 0 || 'Select at least one AI coding agent.'
      }, {
        input: this.input,
        output: this.output
      });
      return codingAgents
        .filter((agent) => selected.includes(agent.id))
        .map((agent) => agent.id);
    } catch (error) {
      if (isPromptCancellation(error)) {
        throw new InteractiveCancelledError();
      }
      throw error;
    }
  }

  private async discoverAgents(specWorkflow: SpecWorkflowId): Promise<AgentDiscovery> {
    const configured = new Set<CodingAgentId>();
    const detected = new Set<CodingAgentId>();
    const framework = getFrameworkDefinition(specWorkflow);

    await Promise.all(codingAgents.map(async (agent) => {
      if (this.configuredRoot) {
        const markerStates = await Promise.all(framework.agentMarkers[agent.id].map(
          async (pathParts) => this.pathExists(path.join(this.configuredRoot!, ...pathParts))
        ));
        if (markerStates.some(Boolean)) {
          configured.add(agent.id);
        }
      }
      if (this.runner) {
        const probe = await this.runner.run(
          { executable: agent.executable, args: ['--version'] },
          { cwd: this.cwd, timeoutMs: 10_000 }
        );
        if (probe.status === 0 && !probe.timedOut) {
          detected.add(agent.id);
        }
      }
    }));

    const defaults = codingAgents
      .filter((agent) => configured.size > 0
        ? configured.has(agent.id)
        : detected.size > 0
          ? detected.has(agent.id)
          : agent.id === 'github-copilot')
      .map((agent) => agent.id);
    return { configured, detected, defaults };
  }

  private async pathExists(file: string): Promise<boolean> {
    try {
      await access(file);
      return true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') {
        return false;
      }
      throw error;
    }
  }

  private agentChoiceLabel(agentId: CodingAgentId, discovery: AgentDiscovery): string {
    const agent = codingAgents.find((candidate) => candidate.id === agentId);
    if (!agent) {
      throw new Error(`Unknown coding agent: ${agentId}`);
    }
    const states = [
      discovery.configured.has(agentId) ? 'configured' : undefined,
      discovery.detected.has(agentId) ? 'detected' : undefined
    ].filter((state): state is string => state !== undefined);
    return `${agent.label} (${states.length > 0 ? states.join(', ') : 'not observable'})`;
  }

  private impactPart(
    count: number,
    singular: string,
    plural: string
  ): string | undefined {
    if (count === 0) {
      return undefined;
    }
    return `${count} ${count === 1 ? singular : plural}`;
  }

  private async question(label: string, defaultValue?: string): Promise<string> {
    this.presentation.prompt(label, defaultValue);
    const answer = await this.lineIterator().next();
    if (answer.done) {
      throw new InteractiveCancelledError(
        `Interactive input closed before answering: ${label}.`
      );
    }
    return answer.value;
  }

  private lineIterator(): AsyncIterator<string> {
    if (this.closed) {
      throw new InteractiveCancelledError();
    }
    if (!this.rl || !this.lines) {
      this.rl = createInterface({ input: this.input, terminal: false });
      this.rl.on('SIGINT', () => this.rl?.close());
      this.lines = this.rl[Symbol.asyncIterator]();
    }
    return this.lines;
  }

  private releaseLineInput(): void {
    this.rl?.close();
    this.rl = undefined;
    this.lines = undefined;
  }
}

async function withPrompter<T>(
  dependencies: InteractiveDependencies | undefined,
  callback: (prompter: InteractivePrompter) => Promise<T>
): Promise<T> {
  const prompter = new InteractivePrompter(dependencies);
  try {
    return await callback(prompter);
  } finally {
    prompter.close();
  }
}

export async function promptForInitOptions(
  initial: ProjectOptions,
  dependencies?: InteractiveDependencies
): Promise<ProjectOptions> {
  return withPrompter(dependencies, (prompter) => prompter.promptForInitOptions(initial));
}

export async function confirmPlan(
  plan: ProjectPlan,
  yes?: boolean,
  dependencies?: InteractiveDependencies,
  actionLabel?: string
): Promise<boolean> {
  return withPrompter(dependencies, (prompter) => prompter.confirmPlan(plan, yes, actionLabel));
}

export async function confirmToolInstallation(
  prompt: ToolInstallationPrompt | string,
  dependencies?: InteractiveDependencies
): Promise<boolean> {
  return withPrompter(dependencies, (prompter) => prompter.confirmToolInstallation(prompt));
}

export async function confirmFileReplacements(
  paths: readonly string[],
  dependencies?: InteractiveDependencies
): Promise<boolean> {
  return withPrompter(dependencies, (prompter) => prompter.confirmFileReplacements(paths));
}

export async function confirmDependencyInstallation(
  commands: DependencyCommandPlan[],
  dependencies?: InteractiveDependencies
): Promise<boolean> {
  return withPrompter(dependencies, (prompter) => prompter.confirmDependencyInstallation(commands));
}

export function resolveCatalogInput(options: ProjectOptions): ProjectOptions {
  return {
    ...options,
    projectType: options.projectType && getProjectType(options.projectType)?.id,
    apiStack: options.apiStack && getApiStack(options.apiStack)?.id,
    pattern: options.pattern && getPattern(options.pattern)?.id,
    cloud: options.cloud && getProvider(options.cloud)?.id,
    specWorkflow: options.specWorkflow && getSpecWorkflow(options.specWorkflow)?.id,
    agents: options.agents?.map((agent) => getCodingAgent(agent)?.id ?? agent),
    defaultAgent: options.defaultAgent && getCodingAgent(options.defaultAgent)?.id
  };
}
