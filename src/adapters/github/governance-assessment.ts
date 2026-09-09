import type { ExternalCommand } from '../../domain/project/contracts.js';

export function githubAssessmentGetCommand(
  url: URL,
  apiVersion: string
): ExternalCommand {
  if (url.origin !== 'https://api.github.com' || url.username || url.password || url.hash) {
    throw new Error('GitHub assessment URL must use the allowlisted API origin.');
  }
  return {
    executable: 'gh',
    args: [
      'api',
      '--method', 'GET',
      '--hostname', 'github.com',
      '--header', 'Accept: application/vnd.github+json',
      '--header', `X-GitHub-Api-Version: ${apiVersion}`,
      '--include',
      url.href
    ]
  };
}
