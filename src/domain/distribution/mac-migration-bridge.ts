export const macMigrationBridge = Object.freeze({
  legacyPackage: '@msn-control/liftoff',
  standaloneCommand: 'liftoff-migrate-npm',
  published: false,
  executableMigrationAuthority: false,
  notice: 'Use the separately authenticated standalone utility; an old Liftoff upgrade command is not required. ' +
    'npm remains the only published channel. Homebrew migration is unavailable until the exact native cask, ' +
    'signing, minimum-host, deployed provider and separately approved bridge publication are qualified.'
});
