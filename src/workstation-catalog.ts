import type { ExternalCommand } from './types.js';

export type WorkstationRequirementId =
  | 'node'
  | 'python'
  | 'go'
  | 'uv'
  | 'docker'
  | 'opentofu'
  | 'azure-cli'
  | 'openspec'
  | 'spec-kit'
  | 'github-copilot'
  | 'claude';

export type RequirementSeverity = 'blocking' | 'advisory';
export type SupportedPlatform = 'darwin' | 'win32' | 'linux';
export type LinuxFamily = 'debian' | 'fedora' | 'arch' | 'unknown';

export interface InstallRecipe {
  command: ExternalCommand;
  manager: 'brew' | 'winget' | 'npm' | 'uv';
}

export interface WorkstationRequirementDefinition {
  id: WorkstationRequirementId;
  label: string;
  severity: RequirementSeverity;
  probes: ExternalCommand[];
  minimumVersion?: string;
  exactVersion?: string;
  install: Partial<Record<SupportedPlatform, InstallRecipe>>;
  linuxRemedies: Record<LinuxFamily, string>;
}

const linuxRemedies = (url: string): Record<LinuxFamily, string> => ({
  debian: `Follow the official Debian/Ubuntu installation guide: ${url}`,
  fedora: `Follow the official Fedora/RHEL installation guide: ${url}`,
  arch: `Follow the official Arch Linux installation guide: ${url}`,
  unknown: `Follow the official Linux installation guide: ${url}`
});

const winget = (id: string): InstallRecipe => ({
  manager: 'winget',
  command: { executable: 'winget', args: ['install', '--id', id, '--exact', '--accept-package-agreements', '--accept-source-agreements'] }
});

const brew = (name: string, cask = false): InstallRecipe => ({
  manager: 'brew',
  command: { executable: 'brew', args: ['install', ...(cask ? ['--cask'] : []), name] }
});

export const workstationRequirementCatalog: Record<WorkstationRequirementId, WorkstationRequirementDefinition> = {
  node: {
    id: 'node',
    label: 'Node.js',
    severity: 'blocking',
    probes: [{ executable: 'node', args: ['--version'] }],
    minimumVersion: '20.19.0',
    install: { darwin: brew('node'), win32: winget('OpenJS.NodeJS.LTS') },
    linuxRemedies: linuxRemedies('https://nodejs.org/en/download/package-manager')
  },
  python: {
    id: 'python',
    label: 'Python',
    severity: 'blocking',
    probes: [
      { executable: 'python3', args: ['--version'] },
      { executable: 'python', args: ['--version'] },
      { executable: 'py', args: ['-3', '--version'] }
    ],
    minimumVersion: '3.11.0',
    install: { darwin: brew('python@3.12'), win32: winget('Python.Python.3.12') },
    linuxRemedies: linuxRemedies('https://www.python.org/downloads/')
  },
  go: {
    id: 'go',
    label: 'Go',
    severity: 'blocking',
    probes: [{ executable: 'go', args: ['version'] }],
    minimumVersion: '1.23.0',
    install: { darwin: brew('go'), win32: winget('GoLang.Go') },
    linuxRemedies: linuxRemedies('https://go.dev/doc/install')
  },
  uv: {
    id: 'uv',
    label: 'uv',
    severity: 'blocking',
    probes: [{ executable: 'uv', args: ['--version'] }],
    install: { darwin: brew('uv'), win32: winget('astral-sh.uv') },
    linuxRemedies: linuxRemedies('https://docs.astral.sh/uv/getting-started/installation/')
  },
  docker: {
    id: 'docker',
    label: 'Docker',
    severity: 'advisory',
    probes: [{ executable: 'docker', args: ['--version'] }],
    install: { darwin: brew('docker', true), win32: winget('Docker.DockerDesktop') },
    linuxRemedies: linuxRemedies('https://docs.docker.com/engine/install/')
  },
  opentofu: {
    id: 'opentofu',
    label: 'OpenTofu',
    severity: 'advisory',
    probes: [{ executable: 'tofu', args: ['--version'] }],
    install: { darwin: brew('opentofu'), win32: winget('OpenTofu.OpenTofu') },
    linuxRemedies: linuxRemedies('https://opentofu.org/docs/intro/install/')
  },
  'azure-cli': {
    id: 'azure-cli',
    label: 'Azure CLI',
    severity: 'advisory',
    probes: [{ executable: 'az', args: ['version', '--output', 'json'] }],
    install: { darwin: brew('azure-cli'), win32: winget('Microsoft.AzureCLI') },
    linuxRemedies: linuxRemedies('https://learn.microsoft.com/cli/azure/install-azure-cli-linux')
  },
  openspec: {
    id: 'openspec',
    label: 'OpenSpec',
    severity: 'blocking',
    probes: [{ executable: 'openspec', args: ['--version'] }],
    exactVersion: '1.6.0',
    install: {
      darwin: { manager: 'npm', command: { executable: 'npm', args: ['install', '-g', '@fission-ai/openspec@1.6.0'] } },
      win32: { manager: 'npm', command: { executable: 'npm', args: ['install', '-g', '@fission-ai/openspec@1.6.0'] } },
      linux: { manager: 'npm', command: { executable: 'npm', args: ['install', '-g', '@fission-ai/openspec@1.6.0'] } }
    },
    linuxRemedies: linuxRemedies('https://github.com/Fission-AI/OpenSpec')
  },
  'spec-kit': {
    id: 'spec-kit',
    label: 'Spec Kit',
    severity: 'blocking',
    probes: [{ executable: 'specify', args: ['--version'] }],
    exactVersion: '0.14.1',
    install: {
      darwin: { manager: 'uv', command: { executable: 'uv', args: ['tool', 'install', 'specify-cli==0.14.1'] } },
      win32: { manager: 'uv', command: { executable: 'uv', args: ['tool', 'install', 'specify-cli==0.14.1'] } },
      linux: { manager: 'uv', command: { executable: 'uv', args: ['tool', 'install', 'specify-cli==0.14.1'] } }
    },
    linuxRemedies: linuxRemedies('https://github.com/github/spec-kit')
  },
  'github-copilot': {
    id: 'github-copilot',
    label: 'GitHub Copilot',
    severity: 'blocking',
    probes: [{ executable: 'copilot', args: ['--version'] }],
    install: { darwin: brew('copilot-cli', true), win32: winget('GitHub.Copilot') },
    linuxRemedies: linuxRemedies('https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli')
  },
  claude: {
    id: 'claude',
    label: 'Claude Code',
    severity: 'blocking',
    probes: [{ executable: 'claude', args: ['--version'] }],
    install: { darwin: brew('claude-code', true), win32: winget('Anthropic.ClaudeCode') },
    linuxRemedies: linuxRemedies('https://docs.anthropic.com/en/docs/claude-code/setup')
  }
};
