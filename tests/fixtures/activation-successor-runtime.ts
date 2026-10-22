import type { Plugin } from 'vite';

function forbiddenProviderEntrypoint(name: string) {
  return () => {
    throw new Error(`Identity migration attempted a forbidden provider entrypoint: ${name}`);
  };
}

export function activationSuccessorAzureBoundary() {
  return {
    planAzurePhase: forbiddenProviderEntrypoint('planAzurePhase'),
    executeAzurePhase: forbiddenProviderEntrypoint('executeAzurePhase')
  };
}

export function activationSuccessorGitHubBoundary() {
  return {
    planGitHubPhase: forbiddenProviderEntrypoint('planGitHubPhase'),
    executeGitHubPhase: forbiddenProviderEntrypoint('executeGitHubPhase')
  };
}

export function activationSuccessorProviderBoundary(): Plugin {
  return {
    name: 'activation-successor-no-provider-access',
    enforce: 'pre',
    resolveId(id) {
      if (id.endsWith('/phase-azure.js') || id === './phase-azure.js') return '\0successor-no-azure';
      if (id.endsWith('/phase-github.js') || id === './phase-github.js') return '\0successor-no-github';
    },
    load(id) {
      const names = id === '\0successor-no-azure' ? ['planAzurePhase', 'executeAzurePhase']
        : id === '\0successor-no-github' ? ['planGitHubPhase', 'executeGitHubPhase'] : undefined;
      if (names) return names.map((name) =>
        `export function ${name}() { throw new Error("Identity migration attempted a forbidden provider entrypoint: ${name}"); }`
      ).join('\n');
    }
  };
}
