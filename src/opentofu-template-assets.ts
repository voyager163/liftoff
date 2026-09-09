import { packagedTemplateAssets } from './adapters/packaged-assets/template-assets.js';

const versions = packagedTemplateAssets.opentofu.versions;
const providerLock = packagedTemplateAssets.opentofu.providerLock;

export function renderOpenTofuVersions(): string {
  return versions;
}

export function renderOpenTofuProviderLock(): string {
  return providerLock;
}
