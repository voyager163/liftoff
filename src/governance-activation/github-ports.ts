import type { GitHubActivationTransport } from '../adapters/github/activation-rest.js';
import type { ProtectedCredentialChannel } from '../adapters/credentials/protected-input.js';
import type { GitHubSecretWriter } from '../adapters/credentials/github-enrollment.js';
import type { PhaseAdapterExecutionInput, PhasePlanningInput } from './transition-ports.js';

export interface GitHubActivationPorts {
  transport?: GitHubActivationTransport;
  protectedCredentialChannel?: ProtectedCredentialChannel;
  credentialTransport?: (credential: Uint8Array) => GitHubActivationTransport;
  secretWriter?: GitHubSecretWriter;
  pollAttempts?: number;
}

export function githubPorts(input: PhasePlanningInput | PhaseAdapterExecutionInput): GitHubActivationPorts {
  return (input as PhasePlanningInput & {
    adapters?: { githubActivation?: GitHubActivationPorts }
  }).adapters?.githubActivation ?? {};
}
