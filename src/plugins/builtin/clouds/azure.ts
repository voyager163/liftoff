import type { ArtifactDeclaration } from '../../contracts.js';
import {
  environmentRootInfrastructureIdentities,
  retainedInfrastructureIdentities,
  sharedApplicationModuleIdentities,
  type InfrastructureArtifactIdentity
} from '../../../domain/project/infrastructure-layout.js';
import { builtinDescriptor, builtinEnvironmentIds, projectArtifact } from '../core.js';

/*
 * Azure OpenTofu: the shared application module and retained README are always present; each
 * selected environment gets its own independent root. Identities come from the domain layout table.
 */

const declare = (identity: InfrastructureArtifactIdentity, environment?: string): ArtifactDeclaration =>
  projectArtifact(
    identity.logicalName,
    identity.category,
    identity.pathParts,
    environment === undefined ? undefined : { environment: [environment] },
    identity.provisioningGroup
  );

export const azurePlugin = builtinDescriptor({
  category: 'cloud',
  id: 'azure',
  contentVersion: 1,
  supports: [{}],
  artifacts: [
    ...sharedApplicationModuleIdentities.map((identity) => declare(identity)),
    ...retainedInfrastructureIdentities.map((identity) => declare(identity)),
    ...builtinEnvironmentIds.flatMap((environment) =>
      environmentRootInfrastructureIdentities(environment).map((identity) => declare(identity, environment)))
  ]
});
