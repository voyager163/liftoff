import { resolvePackagedResource } from '../../adapters/packaged-assets/resource-catalog.js';

export function renderDockerignore(): string {
  return resolvePackagedResource('templates.common.dockerignore').content;
}
