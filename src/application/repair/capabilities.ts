import {
  repairContractVersion, repairRecipes, repairRecoveryCompatibility, repairSchemaVersions
} from '../../domain/repair/identity.js';
import { liftoffVersion } from '../../version.js';
import { applicationPreparationSupport } from './application-preparation-policy.js';

export { applicationPreparationSupport };

export const repairCapabilities = {
  schemaVersion: repairSchemaVersions.capabilities,
  kind: 'liftoff-repair-capabilities',
  cliVersion: liftoffVersion,
  repairContractVersion,
  schemas: repairSchemaVersions,
  recipes: Object.values(repairRecipes),
  preparation: applicationPreparationSupport,
  modes: [
    'check', 'interactive-repair', 'capabilities', 'inspect-layout', 'application-patch',
    'verify-plan', 'approve-plan', 'recover', 'live-discovery'
  ],
  approval: {
    interactive: 'Display an immutable plan, then ask action-specific Yes/No with default No; no fingerprint entry.',
    check: 'Non-executing preview; --live separately permits scoped metadata reads.',
    json: 'Never prompt; no execution without an exact execution flag.',
    nonTty: 'Never prompt or consume piped approval; no execution without an exact execution flag.',
    automation: ['--approve-plan <fingerprint>', '--verify-plan <fingerprint>'],
    verification: 'Separate consent for exact project commands, declared network effects, and the file transaction.'
  },
  boundaries: {
    automaticApplicationMigration: false,
    applicationPatch: 'Explicit per-file staged mappings and reference edits; never a starter replacement.',
    verificationIsolation: 'Staging is not an OS or network sandbox. Approved project commands can affect the host.',
    statefulMigration: 'Not executable through this public repair interface.',
    agentInstallation: 'Not executable through repair; managed integrations for selected agents use reviewed update.',
    activationEvidence: 'Not issued by repair.'
  },
  recoveryCompatibility: repairRecoveryCompatibility
} as const;
