export type MacNpmManager = 'homebrew-node' | 'nvm' | 'volta' | 'custom';

export interface MacNpmSelection {
  npm: string;
  node: string;
  prefix: string;
  manager: MacNpmManager;
  managerRoot?: string;
  managerExecutable?: string;
}

export interface MacNpmOwner extends MacNpmSelection {
  packageRoot: string;
  version: string;
  binary: string;
  launcher: string;
  identity: string;
  tools: string[];
}

export interface MacMigrationHost {
  platform: string;
  architecture: string;
  nativeArchitecture: string;
  appleSilicon: string;
  translated: string;
  osVersion: string;
  runtimeVersion: string;
}

export interface MacMigrationBrew {
  executable: string;
  prefix: string;
  identity: string;
}

export interface MacMigrationReport {
  schemaVersion: 1;
  kind: 'liftoff-mac-npm-migration';
  mode: 'preview' | 'apply' | 'recover';
  status: 'blocked' | 'ready' | 'partial' | 'installed' | 'restored';
  effects: 'none' | 'possible' | 'npm-removed' | 'cask-installed' | 'old-restored';
  blockers: string[];
  review?: string;
  selected?: { manager: MacNpmManager; version: string; packageRoot: string; npm: string; prefix: string };
  target?: { cask: string; version: string; manifestSha256: string; inventorySha256: string };
  journal?: { path: string; sha256: string };
  retainedScratch?: string;
  verification?: { owner: 'homebrew-cask'; version: string; assets: 'verified'; path: 'selected' | 'unresolved';
    parentShell: 'not-observable' };
}

export class MacMigrationFailure extends Error {
  constructor(readonly code: string) { super(code); }
}
