import { stdin as processInput, stdout as processOutput } from 'node:process';
import { createInterface } from 'node:readline/promises';
import type { Readable } from 'node:stream';
import {
  apiStacks,
  codingAgents,
  environments,
  getApiStack,
  getCodingAgent,
  getPattern,
  getProjectType,
  getProvider,
  getSpecWorkflow,
  patterns,
  providers,
  resolveRegion,
  specWorkflows
} from './catalogs.js';
import type { DependencyCommandPlan } from './project-dependencies.js';
import { projectPlanEntries } from './planner.js';
import { formatCommand } from './process-runner.js';
import { PresentationSession } from './terminal.js';
import type { ProjectOptions, ProjectPlan, RegionDefinition } from './types.js';

export interface InteractiveDependencies {
  input?: Readable;
  output?: NodeJS.WritableStream;
  presentation?: PresentationSession;
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

export class InteractivePrompter {
  private readonly output: NodeJS.WritableStream;
  private readonly presentation: PresentationSession;
  private readonly rl: ReturnType<typeof createInterface>;
  private readonly lines: AsyncIterator<string>;

  constructor(dependencies: InteractiveDependencies = {}) {
    const input = dependencies.input ?? processInput;
    this.output = dependencies.output ?? processOutput;
    this.presentation = dependencies.presentation ?? new PresentationSession({
      stdout: this.output,
      stderr: this.output
    });
    this.rl = createInterface({ input, terminal: false });
    this.lines = this.rl[Symbol.asyncIterator]();
  }

  close(): void {
    this.rl.close();
  }

  async promptForInitOptions(initial: ProjectOptions): Promise<ProjectOptions> {
    const projectName = initial.projectName ?? await this.askRequired('Project name');
    const inferredProjectType = initial.projectType ?? (initial.pattern ? 'genai' : initial.apiStack ? 'standard' : undefined);
    const projectType = inferredProjectType ??
      (await this.confirm('Is this a GenAI project?', true) ? 'genai' : 'standard');
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
      : initial.apiStack ?? 'python-fastapi';
    const cloud = initial.cloud ?? await this.choose('Target cloud', providers.map((provider) => ({
      value: provider.id,
      label: `${provider.label}${provider.status === 'planned' ? ' - planned' : ''}`,
      disabled: provider.status === 'planned'
    })));
    const region = initial.region ?? await this.promptForRegion(cloud);
    const includeFrontend = initial.includeFrontend ??
      await this.confirm('Include frontend? (Vue 3 + Tailwind)', false);
    const specWorkflow = initial.specWorkflow ?? await this.choose(
      'Select spec-driven workflow',
      specWorkflows.map((workflow) => ({
        value: workflow.id,
        label: workflow.label,
        disabled: false
      })),
      'openspec'
    );
    const selectedAgents = initial.agents ?? await this.askAgents();
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
    const selectedEnvironments = initial.environments ?? await this.askEnvironments();

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
      environments: selectedEnvironments
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

  private async askAgents(): Promise<string[]> {
    while (true) {
      this.presentation.choices('Select one or more AI coding agents', codingAgents.map((agent) => ({
        label: agent.label,
        value: agent.id,
        default: agent.id === 'github-copilot'
      })));
      const answer = (await this.question('Select comma-separated options', '1')).trim() || '1';
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

  private async question(label: string, defaultValue?: string): Promise<string> {
    this.presentation.prompt(label, defaultValue);
    const answer = await this.lines.next();
    if (answer.done) {
      throw new Error(`Interactive input closed before answering: ${label}.`);
    }
    return answer.value;
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
