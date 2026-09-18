import { describe, expect, it } from 'vitest';
import {
  assertCurrentUpgradeHelp,
  assertInfrastructureDocumentation,
  assertPrivateSourcePackageSize,
  assertSourcePackageUpgradeRefusal,
  PRIVATE_SOURCE_SMOKE_MAX_UNPACKED_BYTES
} from '../scripts/package-smoke-contracts.mjs';

const documents = [
  'infrastructure/opentofu/bootstrap/README.md',
  'infrastructure/opentofu/telemetry/README.md'
];
const pack = (paths: string[]) => ({ files: paths.map((path) => ({ path })) });
const help = 'Upgrade the CLI through its verified installation owner; owner migration and project update are separate\n--check\n--json\n';
const refusal = (mode: 'check' | 'apply') => ({
  schemaVersion: 1, distribution: 'native', mode, status: 'blocked', currentVersion: '0.13.0',
  owner: 'unknown', upstreamAvailability: 'unknown', ownerAvailability: 'unknown', reasonCode: 'ownership_unknown',
  completedEffects: [], uncertainEffects: [], recoveryRequired: false,
  manualAction: 'Inspect actual installation ownership and PATH resolution. Routine upgrade never acquires another owner or an unlinked bundle.'
});

describe('current-source package smoke contracts', () => {
  it('admits exactly 20 MiB for private source transport and rejects one byte over', () => {
    expect(PRIVATE_SOURCE_SMOKE_MAX_UNPACKED_BYTES).toBe(20_971_520);
    expect(() => assertPrivateSourcePackageSize({ unpackedSize: 20_971_520 })).not.toThrow();
    expect(() => assertPrivateSourcePackageSize({ unpackedSize: 20_971_521 }))
      .toThrow('Private source-smoke package exceeds the 20 MiB unpacked-size budget: 20971521');
  });

  it.each([undefined, null, '20971520', NaN, Infinity, -1, 1.5])('rejects invalid size evidence %s', (unpackedSize) => {
    expect(() => assertPrivateSourcePackageSize({ unpackedSize })).toThrow(/invalid unpacked size/);
  });

  it('allows exactly the two operator documents alongside unrelated runtime files', () => {
    expect(() => assertInfrastructureDocumentation(pack(['package.json', 'dist/cli.js', ...documents]))).not.toThrow();
  });

  it.each(documents)('requires the installed documentation-link target %s', (missing) => {
    expect(() => assertInfrastructureDocumentation(pack(documents.filter((file) => file !== missing))))
      .toThrow(`Packed package is missing ${missing}`);
  });

  it.each([
    'infrastructure',
    'infrastructure/README.md',
    'infrastructure/opentofu/README.md',
    'infrastructure/opentofu/bootstrap/main.tf',
    'infrastructure/opentofu/telemetry/dashboard.json',
    'infrastructure/opentofu/telemetry/terraform.tfstate',
    'infrastructure/opentofu/telemetry/.terraform/terraform.tfstate',
    'infrastructure/opentofu/telemetry/README.md/extra',
    'infrastructure/opentofu/telemetry/README.md.bak',
    'infrastructure/opentofu/telemetry/readme.md',
    'Infrastructure/opentofu/bootstrap/README.md'
  ])('rejects unregistered infrastructure file %s', (unexpected) => {
    expect(() => assertInfrastructureDocumentation(pack([...documents, unexpected])))
      .toThrow(`Packed package unexpectedly includes ${unexpected}`);
  });

  it('requires owner-preserving upgrade help and keeps project update and migration separate', () => {
    expect(() => assertCurrentUpgradeHelp(help)).not.toThrow();
    for (const required of ['verified installation owner', 'owner migration and project update are separate', '--check', '--json']) {
      expect(() => assertCurrentUpgradeHelp(help.replace(required, ''))).toThrow();
    }
    expect(() => assertCurrentUpgradeHelp('Replace the supported global npm Liftoff CLI\n--check\n--json')).toThrow();
    expect(() => assertCurrentUpgradeHelp(`${help}supported global npm Liftoff CLI`)).toThrow(/historical npm/);
  });

  it.each(['check', 'apply'] as const)('requires an effect-free native ownership refusal for private archive %s', (mode) => {
    expect(() => assertSourcePackageUpgradeRefusal(refusal(mode), mode, '0.13.0')).not.toThrow();
    for (const changed of [
      { schemaVersion: 2 }, { distribution: 'npm' }, { status: 'current' }, { owner: 'npm' },
      { owner: 'direct' }, { reasonCode: 'migration_required' }, { currentVersion: '0.12.3' },
      { mode: mode === 'check' ? 'apply' : 'check' }, { upstreamAvailability: 'current' },
      { ownerAvailability: 'available' }, { targetVersion: '0.14.0' },
      { completedEffects: ['install'] }, { uncertainEffects: ['replacement'] },
      { recoveryRequired: true }, { manualAction: 'npm install --global @msn-control/liftoff' }
    ]) {
      expect(() => assertSourcePackageUpgradeRefusal({ ...refusal(mode), ...changed }, mode, '0.13.0')).toThrow();
    }
    const { distribution: _distribution, ...historical } = refusal(mode);
    expect(() => assertSourcePackageUpgradeRefusal(historical, mode, '0.13.0')).toThrow();
  });
});
