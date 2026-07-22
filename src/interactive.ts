import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  apiStacks,
  environments,
  getApiStack,
  getPattern,
  getProjectType,
  getProvider,
  getSpecWorkflow,
  patterns,
  providers,
  resolveRegion,
  specWorkflows
} from './catalogs.js';
import type { ProjectOptions, ProjectPlan, RegionDefinition } from './types.js';
import { formatProjectPlan } from './planner.js';

export async function promptForCreateOptions(initial: ProjectOptions): Promise<ProjectOptions> {
  const rl = createInterface({ input, output });
  try {
    const projectName = initial.projectName ?? await askRequired(rl, 'Project name');
    const inferredProjectType = initial.projectType ?? (initial.pattern ? 'genai' : initial.apiStack ? 'standard' : undefined);
    const projectType = inferredProjectType ?? (await confirm(rl, 'Is this a GenAI project?', true) ? 'genai' : 'standard');
    const pattern = projectType === 'genai'
      ? initial.pattern ?? await choose(rl, 'Select GenAI pattern', patterns.map((pattern) => ({
        value: pattern.id,
        label: `${pattern.label} (${pattern.scaffoldStatus})`,
        disabled: false
      })))
      : initial.pattern;
    const apiStack = projectType === 'standard'
      ? initial.apiStack ?? await choose(rl, 'Select API stack', apiStacks.map((stack) => ({
        value: stack.id,
        label: `${stack.label} (${stack.databaseTooling})`,
        disabled: false
      })), 'python-fastapi')
      : initial.apiStack ?? 'python-fastapi';
    const cloud = initial.cloud ?? await choose(rl, 'Target cloud', providers.map((provider) => ({
      value: provider.id,
      label: `${provider.label}${provider.status === 'planned' ? ' - planned' : ''}`,
      disabled: provider.status === 'planned'
    })));
    const region = initial.region ?? await promptForRegion(rl, cloud);
    const includeFrontend = initial.includeFrontend ?? await confirm(rl, 'Include frontend? (Vue 3 + Tailwind)', false);
    const specWorkflow = initial.specWorkflow ?? await choose(rl, 'Select spec-driven workflow', specWorkflows.map((workflow) => ({
      value: workflow.id,
      label: `${workflow.label}${workflow.default ? ' (default)' : ''}`,
      disabled: false
    })), 'openspec');
    const selectedEnvironments = initial.environments ?? await askEnvironments(rl);

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
      environments: selectedEnvironments
    };
  } finally {
    rl.close();
  }
}

export async function confirmPlan(plan: ProjectPlan, yes?: boolean): Promise<boolean> {
  if (yes) {
    return true;
  }

  const rl = createInterface({ input, output });
  try {
    output.write(`\nGenerated plan:\n${formatProjectPlan(plan)}\n\n`);
    return await confirm(rl, 'Create project?', true);
  } finally {
    rl.close();
  }
}

async function askRequired(rl: ReturnType<typeof createInterface>, label: string): Promise<string> {
  while (true) {
    const answer = (await rl.question(`? ${label}: `)).trim();
    if (answer) {
      return answer;
    }
  }
}

async function choose(
  rl: ReturnType<typeof createInterface>,
  label: string,
  options: Array<{ value: string; label: string; disabled: boolean }>,
  defaultValue?: string
): Promise<string> {
  while (true) {
    output.write(`? ${label}:\n`);
    options.forEach((option, index) => {
      output.write(`  ${index + 1}. ${option.label}\n`);
    });
    const answer = (await rl.question('Select option: ')).trim();
    if (!answer && defaultValue) {
      return defaultValue;
    }
    const selectedIndex = Number(answer) - 1;
    const selected = options[selectedIndex] ?? options.find((option) => option.value === answer);
    if (!selected) {
      output.write('Please choose a valid option.\n');
      continue;
    }
    if (selected.disabled) {
      output.write(`${selected.label} is not available in V1.\n`);
      continue;
    }
    return selected.value;
  }
}

async function confirm(rl: ReturnType<typeof createInterface>, label: string, defaultValue: boolean): Promise<boolean> {
  const suffix = defaultValue ? 'Y/n' : 'y/N';
  const answer = (await rl.question(`? ${label} [${suffix}]: `)).trim().toLowerCase();
  if (!answer) {
    return defaultValue;
  }
  return answer === 'y' || answer === 'yes';
}

async function promptForRegion(rl: ReturnType<typeof createInterface>, cloud: string): Promise<string> {
  const provider = getProvider(cloud);
  if (!provider || provider.id !== 'azure') {
    return '';
  }

  while (true) {
    const answer = (await rl.question('? Azure region [East US / eastus]: ')).trim();
    const resolution = resolveRegion(provider.id, answer);
    if (resolution.status === 'resolved') {
      return resolution.region.slug;
    }
    if (resolution.status === 'ambiguous') {
      const selected = await chooseRegion(rl, resolution.matches);
      return selected.slug;
    }
    output.write(`Unknown Azure region: ${resolution.input}. Try a region name such as eastus or korea.\n`);
  }
}

async function chooseRegion(rl: ReturnType<typeof createInterface>, matches: RegionDefinition[]): Promise<RegionDefinition> {
  output.write('Found matching Azure regions:\n');
  matches.forEach((region, index) => {
    output.write(`  ${index + 1}. ${region.displayName}    ${region.slug}\n`);
  });
  while (true) {
    const answer = (await rl.question('Select deployment region: ')).trim();
    const selected = matches[Number(answer) - 1] ?? matches.find((region) => region.slug === answer);
    if (selected) {
      return selected;
    }
  }
}

async function askEnvironments(rl: ReturnType<typeof createInterface>): Promise<string[]> {
  const answer = (await rl.question('? Environments [dev,test,prod]: ')).trim();
  if (!answer) {
    return environments.map((environment) => environment.id);
  }
  return answer.split(',').map((value) => value.trim()).filter(Boolean);
}

export function resolveCatalogInput(options: ProjectOptions): ProjectOptions {
  return {
    ...options,
    projectType: options.projectType && getProjectType(options.projectType)?.id,
    apiStack: options.apiStack && getApiStack(options.apiStack)?.id,
    pattern: options.pattern && getPattern(options.pattern)?.id,
    cloud: options.cloud && getProvider(options.cloud)?.id,
    specWorkflow: options.specWorkflow && getSpecWorkflow(options.specWorkflow)?.id
  };
}