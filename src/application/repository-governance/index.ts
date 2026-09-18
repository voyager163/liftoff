import { assessGovernance } from '../../governance-assessment/engine.js';
import { planGitHubPhase, executeGitHubPhase } from '../../governance-activation/phase-github.js';
import { repositoryGovernanceEngine } from './capabilities.js';

export const repositoryGovernanceRuntime = Object.freeze({
  descriptor: repositoryGovernanceEngine,
  assessGovernance,
  planPhase: planGitHubPhase,
  executePhase: executeGitHubPhase
});

export * from './capabilities.js';
