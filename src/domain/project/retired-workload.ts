export const retiredPowerAppsWorkloadId = 'power-apps-code-app' as const;

const retiredPowerAppsInputs = new Set([
  catalogKey(retiredPowerAppsWorkloadId)
]);
const retiredPowerAppsErrorPrefix = 'Power Apps code app workload';

export function isRetiredPowerAppsWorkload(value: unknown): boolean {
  return typeof value === 'string' &&
    retiredPowerAppsInputs.has(catalogKey(value));
}

export function retiredPowerAppsMessage(input?: string): string {
  const identity = input ? ` ${JSON.stringify(input)}` : '';
  return `${retiredPowerAppsErrorPrefix}${identity} is retired and unsupported by Liftoff. Choose a GenAI or standard API workload.`;
}

export function isRetiredPowerAppsError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(retiredPowerAppsErrorPrefix);
}
import { catalogKey } from './inputs.js';
