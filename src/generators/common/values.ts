import type { ApiProjectPlan } from '../../domain/project/contracts.js';
import type { GenAiProjectPlan } from '../../domain/project/contracts.js';

export const DEFAULT_FUNCTION_WORKER_QUEUE_NAME = 'events';

export const pyModule = (value: string) => value.replace(/-/g, '_');

export const titleCase = (value: string) => value.replace(/(^|[-_\s])([a-z])/g, (_match, prefix: string, letter: string) => `${prefix ? ' ' : ''}${letter.toUpperCase()}`).trim();

export const sourceString = (value: string) => JSON.stringify(value);

export const scriptSourceString = (value: string) => sourceString(value).replaceAll('<', '\\u003c');

export const escapeHtml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export const genAiPattern = (plan: GenAiProjectPlan) => {
  return plan.pattern;
};

export const hasFunctionWorker = (plan: ApiProjectPlan) =>
  plan.workload === 'genai' && plan.provider.id === 'azure' && plan.pattern.worker;

export const functionWorkerName = (plan: GenAiProjectPlan) => `${plan.pattern.id}-worker`;

export function selectedEnvironmentId(plan: ApiProjectPlan): string {
  return plan.environments[0]?.id ?? 'dev';
}

export const localPostgresUrl = (host: string, database: string) =>
  `postgresql:${'//'}postgres:postgres@${host}:5432/${database}`;
