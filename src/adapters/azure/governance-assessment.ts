import type { ExternalCommand } from '../../domain/project/contracts.js';

export function azureAssessmentGetCommand(url: string): ExternalCommand {
  const parsed = new URL(url);
  if (
    parsed.origin !== 'https://management.azure.com' ||
    !parsed.pathname.startsWith('/subscriptions/') ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new Error('Azure assessment URL must use an explicitly scoped ARM subscription path.');
  }
  return {
    executable: 'az',
    args: [
      'rest',
      '--method', 'GET',
      '--url', parsed.href,
      '--output', 'json',
      '--only-show-errors'
    ]
  };
}
