import { canonicalDefaultEnvironmentIds } from '../../application/project/catalog.js';
import type { CommandDefinition, FlagDefinition, FlagGroup } from './contracts.js';

export const booleanFlag = (
  description: string,
  group: FlagGroup,
  negatable = false,
  defaultValue?: string
): FlagDefinition => ({ kind: 'boolean', description, group, negatable, ...(defaultValue ? { defaultValue } : {}) });
const valueFlag = (
  description: string,
  group: FlagGroup,
  metavar = 'value',
  defaultValue?: string
): FlagDefinition => ({ kind: 'value', description, group, metavar, ...(defaultValue ? { defaultValue } : {}) });
export const helpFlag = { help: booleanFlag('Show command-specific help', 'General') };

const projectFlags = {
  project: valueFlag('Project name or project path', 'Project', 'path'),
  type: valueFlag('Project workload type', 'Project', 'workload'),
  genai: booleanFlag('Create a GenAI project; use --no-genai for a standard API', 'Project', true),
  api: valueFlag('Backend API stack', 'Project', 'stack'),
  pattern: valueFlag('GenAI application pattern', 'Project', 'pattern'),
  cloud: valueFlag('Cloud provider', 'Project', 'provider', 'azure'),
  region: valueFlag('Cloud deployment region', 'Project', 'region', 'eastus'),
  frontend: booleanFlag('Include the Vue frontend starter', 'Project', true, 'false'),
  environments: valueFlag('Comma-separated environments', 'Project', 'list', canonicalDefaultEnvironmentIds.join(',')),
  spec: valueFlag('Spec-driven framework', 'Framework', 'framework', 'openspec'),
  agents: valueFlag('Comma-separated AI coding agents', 'Framework', 'list', 'copilot'),
  'default-agent': valueFlag('Primary agent for Spec Kit when multiple agents are selected', 'Framework', 'agent'),
  governance: valueFlag(
    'Repository-governance profile',
    'Framework',
    'profile',
    'single-maintainer-gitflow'
  ),
  'copilot-cloud': booleanFlag(
    'Set up the GitHub-hosted Copilot coding agent for OpenSpec',
    'Framework',
    true,
    'false'
  ),
  'configure-openspec-profile': booleanFlag(
    'Authorize the required global OpenSpec workflow profile',
    'Consent'
  ),
  config: valueFlag('Load deterministic project options from JSON', 'Project', 'file')
} as const;

export const commandDefinitions: Readonly<Record<string, CommandDefinition>> = {
  help: {
    description: 'Show general or command-specific help',
    usage: '[command]',
    group: 'Reference',
    flags: helpFlag,
    arguments: [{ syntax: 'command', description: 'Command to describe' }],
    defaultMaxPositionals: 1
  },
  init: {
    description: 'Initialize a project and prepare its workstation',
    usage: '[project-name]',
    group: 'Onboarding',
    flags: {
      ...projectFlags,
      yes: booleanFlag('Accept project defaults and plan confirmation', 'Consent'),
      force: booleanFlag('Authorize replacement of listed regular-file conflicts', 'Consent'),
      'install-tools': booleanFlag('Authorize allowlisted workstation tool installation', 'Consent'),
      'install-dependencies': booleanFlag('Authorize project-local dependency installation', 'Consent'),
      ...helpFlag
    },
    arguments: [{ syntax: 'project-name', description: 'Project identity or child directory name' }],
    defaultMaxPositionals: 1
  },
  plan: {
    description: 'Preview generated artifacts',
    usage: '',
    group: 'Onboarding',
    flags: { ...projectFlags, ...helpFlag },
    defaultMaxPositionals: 0
  },
  patterns: {
    description: 'List GenAI patterns',
    usage: '',
    group: 'Reference',
    flags: helpFlag,
    defaultMaxPositionals: 0
  },
  providers: {
    description: 'List cloud providers',
    usage: '',
    group: 'Reference',
    flags: helpFlag,
    defaultMaxPositionals: 0
  },
  regions: {
    description: 'List or search provider regions',
    usage: '[search <query>]',
    group: 'Reference',
    flags: {
      cloud: valueFlag('Cloud provider', 'Project', 'provider', 'azure'),
      region: valueFlag('Exact region identifier', 'Project', 'region'),
      ...helpFlag
    },
    subcommands: ['search'],
    arguments: [{ syntax: 'query', description: 'Region name, slug, geography, or alias to search' }],
    defaultMaxPositionals: 0,
    subcommandMaxPositionals: { search: 1 }
  },
  validate: {
    description: 'Validate a generated project manifest',
    usage: '[project-path]',
    group: 'Maintenance',
    flags: {
      project: valueFlag('Project path', 'Project', 'path'),
      json: booleanFlag('Emit machine-readable JSON', 'Output'),
      ...helpFlag
    },
    arguments: [{ syntax: 'project-path', description: 'Generated project to validate' }],
    defaultMaxPositionals: 1
  },
  update: {
    description: 'Preview and explicitly approve scoped project updates',
    usage: '[project-path]',
    group: 'Maintenance',
    flags: {
      project: valueFlag('Project path', 'Project', 'path'),
      check: booleanFlag(
        'Preview normal and eligible forced plans without project writes; save an external preview receipt',
        'Command'
      ),
      force: booleanFlag(
        'Select the separately previewed forced plan for exact owned-core conflicts and retired aliases; still requires approval',
        'Consent'
      ),
      'approve-plan': valueFlag(
        'Approve the exact effective plan from check using its full lowercase 64-hex SHA-256 fingerprint',
        'Consent',
        'fingerprint'
      ),
      json: booleanFlag(
        'Emit one schema-3 result on stdout; interactive approval uses stderr and still defaults to no',
        'Output'
      ),
      ...helpFlag
    },
    arguments: [{ syntax: 'project-path', description: 'Generated project to reconcile' }],
    defaultMaxPositionals: 1
  },
  upgrade: {
    description: 'Replace the supported global npm Liftoff CLI; project templates use update separately',
    usage: '',
    group: 'Maintenance',
    flags: {
      check: booleanFlag('Check for an installable stable CLI update without changing anything', 'Command'),
      json: booleanFlag('Emit one machine-readable result object', 'Output'),
      ...helpFlag
    },
    defaultMaxPositionals: 0
  },
  migrate: {
    description: 'Adopt an existing project',
    usage: '<source-path>',
    group: 'Onboarding',
    flags: {
      ...projectFlags,
      yes: booleanFlag('Accept project defaults and plan confirmation', 'Consent'),
      force: booleanFlag('Retained for parity; never overrides the fresh migration target guard', 'Consent'),
      'install-tools': booleanFlag('Authorize allowlisted workstation tool installation', 'Consent'),
      'install-dependencies': booleanFlag('Authorize project-local dependency installation', 'Consent'),
      ...helpFlag
    },
    arguments: [{ syntax: 'source-path', description: 'Existing application to migrate without modifying it' }],
    defaultMaxPositionals: 1
  },
  doctor: {
    description: 'Check local and project readiness',
    usage: '',
    group: 'Maintenance',
    flags: {
      cloud: valueFlag('Cloud provider to inspect', 'Project', 'provider', 'azure'),
      json: booleanFlag('Emit machine-readable JSON', 'Output'),
      ...helpFlag
    },
    defaultMaxPositionals: 0
  },
  governance: {
    description: 'Inspect governance activation and assess policy alignment',
    usage: '<status|plan|apply-next|resume|verify|assess> [project-path]',
    group: 'Operations',
    flags: {
      project: valueFlag('Liftoff project path', 'Project', 'path'),
      execute: booleanFlag('Execute the reviewed governance apply-next plan; required for any mutation', 'Consent'),
      live: booleanFlag('Assess only: request bounded read-only GitHub/Azure metadata with existing permissions', 'Consent'),
      json: booleanFlag('Emit machine-readable JSON', 'Output'),
      ...helpFlag
    },
    subcommands: ['status', 'plan', 'apply-next', 'resume', 'verify', 'assess'],
    arguments: [{ syntax: 'project-path', description: 'Liftoff project to inspect' }],
    defaultMaxPositionals: 0,
    subcommandMaxPositionals: {
      status: 1,
      plan: 1,
      'apply-next': 1,
      resume: 1,
      verify: 1,
      assess: 1
    }
  },
  dev: {
    description: 'Print Docker Compose helper commands',
    usage: '[up|down|logs|reset]',
    group: 'Operations',
    flags: { profile: valueFlag('Docker Compose profile', 'Command', 'name'), ...helpFlag },
    subcommands: ['up', 'down', 'logs', 'reset'],
    defaultMaxPositionals: 0,
    subcommandMaxPositionals: { up: 0, down: 0, logs: 0, reset: 0 }
  },
  infra: {
    description: 'Print OpenTofu helper commands',
    usage: '[init|plan|apply|output]',
    group: 'Operations',
    flags: { env: valueFlag('Target environment', 'Command', 'environment', 'dev'), ...helpFlag },
    subcommands: ['init', 'plan', 'apply', 'output'],
    defaultMaxPositionals: 0,
    subcommandMaxPositionals: { init: 0, plan: 0, apply: 0, output: 0 }
  }
};
