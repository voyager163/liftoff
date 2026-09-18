import { bootstrapAccess, custody } from './private-activation-fixture.js';

export function providerBootstrapConfiguration(root: string) {
  const planned = bootstrapAccess();
  return {
    principalId: planned.binding.principalId,
    expiresAt: planned.expiresAt,
    access: {
      resourceGroup: planned.resourceGroup,
      storageAccountResourceId: planned.storageAccountResourceId,
      network: planned.network,
      runner: planned.runner
    },
    custody: custody(root)
  };
}
