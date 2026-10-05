export type ProjectInventoryRole = 'application' | 'dependency' | 'dependency-lock' |
  'build-configuration' | 'workflow' | 'agent' | 'ci' | 'infrastructure' |
  'documentation' | 'project-metadata' | 'other';
export type ProjectInventoryExclusion = 'version-control' | 'state-or-credential' |
  'dependency-or-output' | 'nested-project';

const versionControlTrees = new Set(['.git', '.hg', '.svn', '.bzr']);
const privateTrees = new Set([
  '.liftoff', '.terraform', '.tofu', '.terragrunt-cache', 'terraform.tfstate.d',
  'state', 'states', '.state', 'tfstate', 'credentials', '.credentials', 'secrets', '.secrets',
  '.aws', '.azure', '.gcloud', '.kube', '.ssh', '.gnupg', '.docker', '.direnv',
  'certificates'
]);
const outputTrees = new Set([
  'node_modules', 'vendor', '.pnpm-store', '.yarn', '.npm', '.venv', 'venv', '.virtualenv',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.hypothesis', '.cache',
  '.turbo', '.parcel-cache', '.next', '.nuxt', '.svelte-kit', 'dist', 'build', 'target',
  'coverage', 'htmlcov', 'out', 'obj'
]);
const privateFiles = new Set([
  '.env', '.envrc', '.netrc', '_netrc', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pypirc',
  '.terraformrc', 'terraform.rc', '.python_history', '.bash_history', '.zsh_history',
  'liftoff.config.json', 'runtime.config.json', 'local.settings.json', '.liftoff-init.lock',
  'state.json', 'state.yaml', 'state.yml', 'credentials.json', 'secrets.json',
  'service-account.json', 'service_account.json', 'id_rsa', 'id_ed25519', 'id_dsa', 'id_ecdsa'
]);
const dependencyFiles = new Set(['package.json', 'pyproject.toml', 'requirements.txt', 'setup.cfg', 'setup.py', 'go.mod']);
const dependencyLocks = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'uv.lock', 'poetry.lock', 'go.sum']);
const controlTrees = new Set(['.github', '.claude', '.agents', '.copilot', '.codex', '.cursor', '.specify', 'openspec']);
const infrastructureTrees = new Set(['infra', 'infrastructure', 'terraform', 'opentofu']);
const fold = (part: string): string => part.normalize('NFKC').toUpperCase().toLowerCase();

/** Metadata exclusions are distinct from repair's editable application scope. */
export function projectInventoryExclusion(parts: readonly string[]): ProjectInventoryExclusion | null {
  const names = parts.map(fold);
  if (names.some(name => versionControlTrees.has(name))) return 'version-control';
  if (names.some(name => privateTrees.has(name) || privateFiles.has(name) ||
      /^(?:\.env[.-]|.*\.env(?:[.-]|$))/u.test(name) ||
      /\.(?:tfvars|tfstate|tfplan|pem|key|p12|pfx|kdbx|sqlite|sqlite3|db)(?:\.|$)/u.test(name) ||
      /^(?:service[-_]account|credentials?|secrets?|tokens?)[.-]/u.test(name))) return 'state-or-credential';
  if (names.some(name => outputTrees.has(name))) return 'dependency-or-output';
  return null;
}

export function projectInventoryRoles(parts: readonly string[], directory: boolean): ProjectInventoryRole[] {
  const names = parts.map(fold);
  const name = names.at(-1)!;
  const roles = new Set<ProjectInventoryRole>();
  const control = names.some(part => controlTrees.has(part));
  if (!directory && dependencyFiles.has(name) && !control) roles.add('dependency');
  if (!directory && dependencyLocks.has(name) && !control) roles.add('dependency-lock');
  if (name === 'liftoff.manifest.json') roles.add('project-metadata');
  if (names.some(part => part === 'openspec' || part === '.specify')) roles.add('workflow');
  if (names.some(part => ['.claude', '.agents', '.copilot', '.codex', '.cursor'].includes(part)) ||
      names[0] === '.github' && ['skills', 'prompts', 'instructions', 'agents'].includes(names[1] ?? '') ||
      ['agents.md', 'claude.md', 'copilot-instructions.md', '.cursorrules'].includes(name)) roles.add('agent');
  if (names[0] === '.github' && names[1] === 'workflows' ||
      ['azure-pipelines.yml', 'azure-pipelines.yaml', '.gitlab-ci.yml', 'jenkinsfile'].includes(name)) roles.add('ci');
  if (names.some(part => infrastructureTrees.has(part)) ||
      !directory && (/\.(?:tf|bicep)$/u.test(name) || name === '.terraform.lock.hcl')) roles.add('infrastructure');
  if (names.some(part => part === 'docs' || part === 'documentation') ||
      /^(?:readme|contributing|developer|governance|security|support|code_of_conduct)(?:\.|$)/u.test(name)) roles.add('documentation');
  if (!directory && (/^(?:tsconfig|jsconfig)(?:\.|$)/u.test(name) ||
      /^(?:vite|vitest|webpack|rollup|pytest|tox)\.config\./u.test(name) ||
      ['dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml', 'makefile', 'pytest.ini', 'tox.ini'].includes(name))) {
    roles.add('build-configuration');
  }
  if (!directory && !control && !roles.has('infrastructure') &&
      /\.(?:py|go|[cm]?[jt]sx?|vue|svelte)$/u.test(name) && name !== 'setup.py') roles.add('application');
  return roles.size ? [...roles].sort() : ['other'];
}

export function projectDependencyDialect(parts: readonly string[]): 'node' | 'python' | 'go' | null {
  if (!projectInventoryRoles(parts, false).includes('dependency')) return null;
  // Executable setup.py is a presence marker, never an inspection input.
  switch (fold(parts.at(-1)!)) {
    case 'package.json': return 'node';
    case 'pyproject.toml':
    case 'requirements.txt':
    case 'setup.cfg': return 'python';
    case 'go.mod': return 'go';
    default: return null;
  }
}
