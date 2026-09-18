import { canonicalDefaultEnvironmentIds } from '../project/catalog.js';
import type { CommandDefinition, FlagDefinition, FlagGroup } from './command-contracts.js';
import { skillsSubcommands } from '../skills/contracts.js';

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
  capabilities: {
    description: 'Inspect installed engine capabilities and command contracts without project or provider probes',
    usage: '',
    group: 'Reference',
    flags: {
      json: booleanFlag('Emit the strict schema-1 capability envelope without changing existing command reports', 'Output'),
      ...helpFlag
    },
    defaultMaxPositionals: 0
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
  repair: {
    description: 'Review and repair supported project files with separate default-No approval',
    usage: '[project-path]',
    group: 'Maintenance',
    flags: {
      project: valueFlag('Exact Liftoff project path', 'Project', 'path'),
      check: booleanFlag('Preview only; explicit dependency preparation previews include bounded installed-tool identity probes, never project scripts or installs', 'Command'),
      capabilities: booleanFlag('List repair contracts, recipes, preparation support, schemas and modes without a project or tool probes', 'Command'),
      'inspect-layout': booleanFlag('Inventory actual application paths and current targets without scripts or writes', 'Command'),
      'application-patch': valueFlag('Review an exact application patch authored in external staging, not a starter replacement', 'Project', 'patch.json'),
      live: booleanFlag('Allow bounded Azure metadata reads with existing authentication; never read state', 'Consent'),
      subscription: valueFlag('Exact Azure subscription ID for live absence checks', 'Project', 'id'),
      'approve-plan': valueFlag('Optional automation: approve the exact saved plan; ordinary TTY repair asks instead', 'Consent', 'fingerprint'),
      'verify-plan': valueFlag('Optional automation: run exact staged checks; declared preparation/network require separate permissions, never file commit', 'Consent', 'fingerprint'),
      'allow-dependency-preparation': booleanFlag('Separately permit only declared locked private preparation with --verify-plan; not global tools or file writes', 'Consent'),
      'allow-network': booleanFlag('Additionally authorize declared network effects for exact --verify-plan checks', 'Consent'),
      recover: booleanFlag('Recover only eligible recorded repair effects; live, uncertain or changed private workspace identities stay blocked', 'Command'),
      recipe: valueFlag('Select registered repair recipe (azure-local-layout, azure-baseline-settings)', 'Command', 'recipe'),
      json: booleanFlag('Emit one schema-2 result (capabilities schema 1); never prompt or implicitly execute', 'Output'),
      ...helpFlag
    },
    arguments: [{ syntax: 'project-path', description: 'Existing Liftoff project; never an initialization destination' }],
    defaultMaxPositionals: 1
  },
  upgrade: {
    description: 'Upgrade the CLI through its verified installation owner; owner migration and project update are separate',
    usage: '',
    group: 'Maintenance',
    flags: {
      check: booleanFlag('Check for an installable stable CLI update without changing anything', 'Command'),
      json: booleanFlag('Emit one machine-readable result object', 'Output'),
      ...helpFlag
    },
    defaultMaxPositionals: 0
  },
  installation: {
    description: 'Inspect native installation ownership or plan and apply one-time legacy npm migration',
    usage: '<inspect|migrate> [options]',
    group: 'Maintenance',
    flags: {
      to: valueFlag('Target installation owner: homebrew-cask, winget, or direct', 'Command', 'owner'),
      candidate: valueFlag('Path to verified unlinked native candidate bundle', 'Command', 'path'),
      destination: valueFlag('Custom installation destination directory', 'Project', 'path'),
      launcher: valueFlag('Custom launcher path', 'Project', 'path'),
      check: booleanFlag('Preview the schema-1 migration plan without installation or configuration changes', 'Command'),
      'approve-plan': valueFlag('Approve the exact current migration fingerprint; never generic permission to replace another owner', 'Consent', 'fingerprint'),
      recover: booleanFlag('Inspect an interrupted migration and its owner-specific recovery boundary without executing recovery', 'Command'),
      json: booleanFlag('Emit machine-readable JSON', 'Output'),
      ...helpFlag
    },
    subcommands: ['inspect', 'migrate'],
    defaultMaxPositionals: 0,
    subcommandMaxPositionals: { inspect: 0, migrate: 0 }
  },
  skills: {
    description: 'Inspect canonical agent skills and review exact personal or project delivery',
    usage: '[list|plan|inspect|install|update|remove|migrate]',
    group: 'Maintenance',
    flags: {
      host: valueFlag('Explicit comma-separated hosts: copilot, claude, codex; shared roots are disclosed', 'Framework', 'hosts'),
      scope: valueFlag('Target user or project scope; defaults to user unless --project is explicit', 'Command', 'scope'),
      project: valueFlag('Explicit project target; never implicitly initialize it', 'Project', 'path'),
      skill: valueFlag('Select one canonical workflow; omit to select the catalog for the requested hosts', 'Command', 'id'),
      check: booleanFlag('Preview the selected install, update, remove, or migration without writes', 'Command'),
      'approve-plan': valueFlag('Approve only the exact current operation fingerprint; ordinary TTY approval defaults to No', 'Consent', 'fingerprint'),
      json: booleanFlag('Emit one schema-1 result; never implicitly approve or prompt', 'Output'),
      ...helpFlag
    },
    subcommands: skillsSubcommands,
    defaultMaxPositionals: 0
  },
  adopt: {
    description: 'Review in-place adoption of a supported existing application without replacing its business code',
    usage: '<project-path>',
    group: 'Onboarding',
    flags: {
      project: valueFlag('Explicit existing project or component boundary', 'Project', 'path'),
      profile: valueFlag('Installed supported standards profile target; never a framework conversion', 'Project', 'id'),
      component: valueFlag('Confined existing component path within the project', 'Project', 'path'),
      proposal: valueFlag('Exact reviewed application mappings and additions from external staging', 'Project', 'file'),
      check: booleanFlag('Preview without project writes, preparation, scripts, or network effects', 'Command'),
      'approve-plan': valueFlag('Approve only the exact saved file/metadata plan after its required verification', 'Consent', 'fingerprint'),
      'verify-plan': valueFlag('Authorize only the exact saved private verification scope, not file commit', 'Consent', 'fingerprint'),
      'allow-dependency-preparation': booleanFlag('Separately permit declared locked preparation with --verify-plan', 'Consent'),
      'allow-network': booleanFlag('Separately permit declared verification/preparation network effects with --verify-plan', 'Consent'),
      recover: booleanFlag('Recover only attributable recorded adoption effects; never start a new plan', 'Command'),
      json: booleanFlag('Emit one schema-1 adoption result without prompting or implicit consent', 'Output'),
      ...helpFlag
    },
    arguments: [{ syntax: 'project-path', description: 'Existing supported application; never a fresh scaffold destination' }],
    defaultMaxPositionals: 1
  },
  assess: {
    description: 'Read-only whole-project standards assessment without initialization, scripts, or provider access',
    usage: '[project-path]',
    group: 'Onboarding',
    flags: {
      project: valueFlag('Explicit existing project or repository boundary; otherwise use the nearest applicable boundary', 'Project', 'path'),
      component: valueFlag('Confined existing component within the selected boundary', 'Project', 'path'),
      profile: valueFlag('Installed standards profile target; unsupported source remains diagnostic-only', 'Project', 'id'),
      inputs: valueFlag('Bounded public configuration reference, resolved from the invocation directory', 'Project', 'file'),
      json: booleanFlag('Emit one schema-1 assessment with observed facts, limitations, and scoped outcomes', 'Output'),
      ...helpFlag
    },
    arguments: [{ syntax: 'project-path', description: 'Existing directory; no Git or Liftoff manifest is required' }],
    defaultMaxPositionals: 1
  },
  migrate: {
    description: 'Create a fresh migration target while preserving the existing source; not in-place adoption',
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
    description: 'Plan, approve, execute, recover, and inspect scoped governance work',
    usage: '<status|plan|approve|apply-next|credential-enroll|recover|resume|verify|assess> [project-path]',
    group: 'Operations',
    flags: {
      project: valueFlag('Liftoff project path', 'Project', 'path'),
      scope: valueFlag('Execution/verification boundary: local, repository, activation, or lifecycle', 'Command', 'scope', 'activation'),
      inputs: valueFlag('Public activation configuration JSON; never credentials or state', 'Project', 'file'),
      plan: valueFlag('Exact project-bound fingerprint from governance plan', 'Consent', 'fingerprint'),
      'recover-phase': valueFlag('Plan explicit recovery of one failed or interrupted phase without executing it', 'Command', 'phase'),
      'protected-stdin': booleanFlag('Read credential enrollment material from explicitly protected stdin instead of a private TTY', 'Consent'),
      execute: booleanFlag('Execute the reviewed governance apply-next plan; required for any mutation', 'Consent'),
      live: booleanFlag('Assess only: request bounded read-only GitHub/Azure metadata with existing permissions', 'Consent'),
      json: booleanFlag('Emit machine-readable JSON', 'Output'),
      ...helpFlag
    },
    subcommands: ['status', 'plan', 'approve', 'apply-next', 'credential-enroll', 'recover', 'resume', 'verify', 'assess'],
    arguments: [{ syntax: 'project-path', description: 'Liftoff project to inspect' }],
    defaultMaxPositionals: 0,
    subcommandMaxPositionals: {
      status: 1,
      plan: 1,
      approve: 1,
      'apply-next': 1,
      'credential-enroll': 1,
      recover: 1,
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
