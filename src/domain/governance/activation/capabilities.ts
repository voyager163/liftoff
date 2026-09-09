import type { PhaseId } from './types.js';

export interface PhaseCapability {
  executor: 'built-in' | 'injected-only' | 'unavailable';
  retry: 'explicit-local' | 'none';
  blocker?: string;
}

const builtIn = { executor: 'built-in', retry: 'none' } as const;
const local = { executor: 'built-in', retry: 'explicit-local' } as const;
const unavailable = { executor: 'unavailable', retry: 'none', blocker: 'No production executor is available.' } as const;
const injected = { executor: 'injected-only', retry: 'none', blocker: 'An explicit GitHub ruleset adapter is required; no production adapter is configured.' } as const;

export const phaseCapabilities: Readonly<Record<PhaseId, PhaseCapability>> = {
  'seed-valid': local,
  'seed-verified': local,
  'seed-archived': local,
  committed: builtIn,
  pushed: builtIn,
  'phase-0-complete': builtIn,
  'activation-approved': { ...builtIn, blocker: 'Public approval persistence is unavailable; this authority gate cannot be entered through the CLI.' },
  'credential-ready': { ...builtIn, blocker: 'Independent credential readback and public credential enrollment are unavailable.' },
  'provider-ready': unavailable,
  'state-path-selected': unavailable,
  'existing-private-path': unavailable,
  'bootstrap-local': unavailable,
  'runner-ready': unavailable,
  'private-backend-proof': unavailable,
  'remote-import-verified': unavailable,
  'remote-ready': builtIn,
  'application-foundation': unavailable,
  'workflow-source-ready': unavailable,
  'dev-proof': unavailable,
  'staging-qualified': unavailable,
  'production-rehearsed': unavailable,
  'green-red-proof': unavailable,
  'enforcement-approved': unavailable,
  'rulesets-applied': injected,
  'live-readback': injected,
  'bootstrap-state-disposed': builtIn
};
