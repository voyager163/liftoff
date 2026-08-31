import { readFileSync } from 'node:fs';

const versions = readFileSync(
  new URL('../assets/locks/opentofu-azure/versions.tf', import.meta.url),
  'utf8'
);
const providerLock = readFileSync(
  new URL('../assets/locks/opentofu-azure/.terraform.lock.hcl', import.meta.url),
  'utf8'
);

export function renderOpenTofuVersions(): string {
  return versions;
}

export function renderOpenTofuProviderLock(): string {
  return providerLock;
}
