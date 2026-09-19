import type { PhaseId } from './types.js';

export interface PhaseCapability {
  executor: 'built-in' | 'injected-only' | 'unavailable';
  retry: 'explicit-local' | 'none';
  blocker?: string;
  implementation?: 'complete' | 'partial' | 'missing';
  qualification?: 'local-regression' | 'unqualified';
  blockerKind?: 'implementation-missing' | 'unqualified';
}

const builtIn = { executor: 'built-in', retry: 'none', implementation: 'complete', qualification: 'unqualified' } as const;
const local = { executor: 'built-in', retry: 'explicit-local', implementation: 'complete', qualification: 'local-regression' } as const;
const unavailable = {
  executor: 'unavailable', retry: 'none', implementation: 'partial', qualification: 'unqualified',
  blockerKind: 'implementation-missing', blocker: 'A provider adapter exists, but the complete approved producer, independent proof, or recovery contract is not implemented.'
} as const;
const unqualified = {
  executor: 'built-in', retry: 'none', implementation: 'complete', qualification: 'unqualified',
  blockerKind: 'unqualified', blocker: 'This provider/host/recipe has not passed separately authorized disposable qualification. Regression fixtures are not live qualification.'
} as const;

export const phaseCapabilities: Readonly<Record<PhaseId, PhaseCapability>> = {
  'seed-valid': local,
  'seed-verified': local,
  'seed-archived': local,
  committed: builtIn,
  pushed: builtIn,
  'repository-discovered': unqualified,
  'repository-workflow-source-ready': unavailable,
  'repository-checks-qualified': unavailable,
  'repository-enforcement-approved': builtIn,
  'repository-rulesets-applied': unavailable,
  'repository-live-readback': unavailable,
  'phase-0-complete': builtIn,
  'activation-approved': builtIn,
  'bootstrap-workflow-source-ready': unavailable,
  'credential-ready': { ...unavailable, blocker: 'Independent credential readback and public credential enrollment are unavailable as a complete production producer.' },
  'provider-ready': unqualified,
  'state-path-selected': unqualified,
  'existing-private-path': unavailable,
  'bootstrap-local': unavailable,
  'runner-ready': unavailable,
  'private-backend-proof': unavailable,
  'remote-import-verified': unavailable,
  'remote-ready': builtIn,
  'application-prerequisites-ready': unavailable,
  'application-artifact-ready': unavailable,
  'application-foundation': unavailable,
  'workflow-source-ready': unavailable,
  'dev-proof': unavailable,
  'staging-qualified': unavailable,
  'production-rehearsed': unavailable,
  'green-red-proof': unavailable,
  'enforcement-approved': builtIn,
  'rulesets-applied': unavailable,
  'live-readback': unavailable,
  'bootstrap-state-disposed': builtIn
};
