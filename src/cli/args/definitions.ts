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
  spec: valueFlag('Development workflow: openspec, spec-kit, or manual', 'Framework', 'workflow', 'openspec'),
  agents: valueFlag('Comma-separated AI coding agents; none is valid only for Manual', 'Framework', 'list', 'copilot; none for Manual'),
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
  capabilities: {
    description: 'Inspect installed public capabilities without project or readiness probes',
    usage: '',
    group: 'Reference',
    flags: { json: booleanFlag('Emit the schema-1 installed capability catalog', 'Output'), ...helpFlag },
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
  assess: {
    description: 'Read-only whole-project comparison against explicitly displayed installed targets',
    usage: '[project-path] [--governance <profile>] [--json]',
    group: 'Maintenance',
    flags: {
      project: valueFlag('One exact project path; explicitly select non-Git applications', 'Project', 'path'),
      governance: valueFlag('Advisory comparison profile: none, single-maintainer-gitflow, or team-gitflow; never changes recorded selection', 'Project', 'profile'),
      json: booleanFlag('Emit one schema-1 read-only report; unknown coverage is not a pass', 'Output'),
      live: booleanFlag('Explicit bounded GitHub metadata reads with existing permissions; no enrollment, scripts, Azure discovery or conformance proof', 'Command'),
      ...helpFlag
    },
    arguments: [{ syntax: 'project-path', description: 'Selected Liftoff, Git or explicitly identified non-Git project boundary' }],
    defaultMaxPositionals: 1
  },
  adopt: {
    description: 'Preview reviewed in-place adoption for a supported non-Liftoff application',
    usage: '[project-path]',
    group: 'Maintenance',
    flags: {
      type: projectFlags.type,
      genai: projectFlags.genai,
      api: projectFlags.api,
      pattern: projectFlags.pattern,
      cloud: projectFlags.cloud,
      region: projectFlags.region,
      frontend: projectFlags.frontend,
      environments: projectFlags.environments,
      spec: projectFlags.spec,
      agents: projectFlags.agents,
      'default-agent': projectFlags['default-agent'],
      governance: projectFlags.governance,
      'copilot-cloud': projectFlags['copilot-cloud'],
      config: projectFlags.config,
      project: valueFlag(
        'Exact project path; explicitly select non-Git applications',
        'Project',
        'path'
      ),
      check: booleanFlag(
        'Preview only and save bounded review records outside the repository',
        'Command'
      ),
      'approve-plan': valueFlag(
        'Approve one complete current public adoption plan by its full lowercase 64-hex SHA-256 fingerprint',
        'Consent',
        'fingerprint'
      ),
      recover: booleanFlag(
        'Inspect or continue only the authenticated recovery owned by --approve-plan',
        'Consent'
      ),
      json: booleanFlag(
        'Emit one schema-1 adoption result on stdout; bare JSON always previews',
        'Output'
      ),
      ...helpFlag
    },
    arguments: [{
      syntax: 'project-path',
      description: 'Supported non-Liftoff Git project or explicitly identified non-Git application'
    }],
    defaultMaxPositionals: 1
  },
  workflow: {
    description: 'Review an explicit development-workflow transition',
    usage: 'set <openspec|spec-kit|manual> [project-path]',
    group: 'Maintenance',
    flags: {
      project: valueFlag('Exact current Liftoff project path', 'Project', 'path'),
      agents: projectFlags.agents,
      'default-agent': projectFlags['default-agent'],
      check: booleanFlag('Create or refresh the exact external transition plan without project writes', 'Command'),
      'approve-plan': valueFlag('Select one exact saved transition plan by its full lowercase 64-hex SHA-256 fingerprint', 'Consent', 'fingerprint'),
      recover: booleanFlag('Inspect only recovery attributable to the exact selected transition plan', 'Consent'),
      'install-tools': booleanFlag('Separately authorize allowlisted pinned framework-tool preparation before project review', 'Consent'),
      'configure-openspec-profile': booleanFlag('Separately authorize the exact required OpenSpec global-profile fields before project review', 'Consent'),
      json: booleanFlag('Emit one schema-1 workflow-transition report', 'Output'),
      ...helpFlag
    },
    subcommands: ['set'],
    arguments: [
      { syntax: 'openspec|spec-kit|manual', description: 'Explicit target development workflow' },
      { syntax: 'project-path', description: 'Current manifest-v8 Liftoff project' }
    ],
    defaultMaxPositionals: 0,
    subcommandMaxPositionals: { set: 2 }
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
      recover: booleanFlag(
        'Recover only the interrupted update selected by --approve-plan; use the exact project root or an explicit project path',
        'Consent'
      ),
      json: booleanFlag(
        'Emit one schema-4 v8 update result on stdout; interactive approval uses stderr and still defaults to no',
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
      agents: valueFlag('Comma-separated agents to add without removing existing selections; none is invalid', 'Framework', 'list', 'codex'),
      'default-agent': valueFlag('Explicit new Spec Kit default; the agent is also added when absent', 'Framework', 'agent'),
      check: booleanFlag('Preview only; explicit dependency preparation previews include bounded installed-tool identity probes, never project scripts or installs', 'Command'),
      capabilities: booleanFlag('List repair contracts, recipes, preparation support, schemas and modes without a project or tool probes', 'Command'),
      'inspect-layout': booleanFlag('Inventory actual application paths and current targets without scripts or writes', 'Command'),
      'application-patch': valueFlag('Review an exact application patch authored in external staging, not a starter replacement', 'Project', 'patch.json'),
      live: booleanFlag('Allow bounded Azure metadata reads with existing authentication; never read state', 'Consent'),
      subscription: valueFlag('Exact Azure subscription ID for live absence checks', 'Project', 'id'),
      'approve-plan': valueFlag('Optional automation: approve one exact saved application, binding, infrastructure, or additive-agent plan; ordinary TTY repair asks instead', 'Consent', 'fingerprint'),
      'verify-plan': valueFlag('Optional automation: run exact staged checks; declared preparation/network require separate permissions, never file commit', 'Consent', 'fingerprint'),
      'allow-dependency-preparation': booleanFlag('Separately permit only declared locked private preparation with --verify-plan; not global tools or file writes', 'Consent'),
      'allow-network': booleanFlag('Additionally authorize declared network effects for exact --verify-plan checks', 'Consent'),
      'install-tools': booleanFlag('Separately authorize pinned framework-tool preparation for an additive agent request', 'Consent'),
      'configure-openspec-profile': booleanFlag('Separately authorize the required global OpenSpec profile for an additive OpenSpec agent request', 'Consent'),
      recover: booleanFlag('Recover only eligible recorded repair effects; additive-agent recovery also requires its exact --approve-plan fingerprint', 'Command'),
      json: booleanFlag('Emit one schema-2 result (capabilities schema 1); never prompt or implicitly execute', 'Output'),
      ...helpFlag
    },
    arguments: [{ syntax: 'project-path', description: 'Existing Liftoff project; never an initialization destination' }],
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
    description: 'Plan, approve, execute, recover, and inspect scoped governance work',
    usage: '<status|plan|approve|apply-next|credential-enroll|recover|resume|verify|assess> [project-path]',
    group: 'Operations',
    flags: {
      project: valueFlag('Liftoff project path', 'Project', 'path'),
      scope: valueFlag('Execution/verification boundary: local, activation, or lifecycle', 'Command', 'scope', 'activation'),
      inputs: valueFlag('Public activation configuration or explicit local request/consent JSON; never credentials or state', 'Project', 'file'),
      plan: valueFlag('Exact project-bound fingerprint from governance plan', 'Consent', 'fingerprint'),
      'local-operation': valueFlag('v8 only: verify, finalize, publish, or revalidate-successor with --scope local; publication operations also support recover', 'Command', 'operation'),
      'revalidation-publication': valueFlag('Inspect one exact v8 successor publication; not approval or execution', 'Command', 'fingerprint'),
      'recover-phase': valueFlag('Plan explicit recovery of one failed or interrupted phase without executing it', 'Command', 'phase'),
      'protected-stdin': booleanFlag('Credential enrollment is currently unavailable; this flag reads no secret', 'Consent'),
      execute: booleanFlag('Execute the reviewed apply-next/recover operation; planning and approval save external metadata separately', 'Consent'),
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
