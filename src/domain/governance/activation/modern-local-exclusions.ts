const hiddenTrees = new Set([
  '.git', '.hg', '.svn', '.terraform', '.tofu', '.terragrunt-cache', 'node_modules', 'vendor',
  '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.cache',
  'dist', 'build', 'target', 'coverage', '.next', '.nuxt', '.npm', '.yarn', '.pnpm-store',
  '.aws', '.azure', '.gcloud', '.kube', '.ssh', '.gnupg', '.docker', '.direnv',
  'credentials', '.credentials', 'secrets', '.secrets', 'state', 'states', '.state'
]);
const hiddenFiles = new Set([
  '.env', '.envrc', '.npmrc', '.netrc', '.pypirc', '.yarnrc', '.yarnrc.yml', '.terraformrc', 'terraform.rc',
  'local.settings.json', 'credentials.json', 'secrets.json', 'service-account.json', 'service_account.json'
]);

export function modernLocalInputExclusion(parts: readonly string[]): string | null {
  const folded = parts.map(part => part.toLowerCase());
  if (folded.some(part => hiddenTrees.has(part))) return 'dependency-output-state-or-credential-tree';
  if (folded.some(part => hiddenFiles.has(part) || /^\.env[.-]/u.test(part) ||
      /\.(?:tfstate|tfplan|tfvars|pem|key|p12|pfx|kdbx|sqlite|db)(?:\.|$)/u.test(part))) {
    return 'live-configuration-or-sensitive-file';
  }
  return null;
}
