import { readFileSync } from 'node:fs';
import { builtinAssets } from '../../plugins/builtin/assets.js';
import type { ContributionOwner } from '../../plugins/contracts.js';
import { resolvePackageFile } from './package-root.js';

export type PackagedNpmTemplateId = 'node-backend' | 'frontend';
export type PackagedPythonTemplateId = 'genai' | 'standard';

export interface PackagedTemplateAssetContext {
  npm: Record<PackagedNpmTemplateId, {
    packageJson: string;
    packageLock: string;
  }>;
  python: Record<PackagedPythonTemplateId, {
    pyproject: string;
    lock: string;
  }>;
  functionRequirements: string;
  go: {
    module: string;
    checksum: string;
  };
  opentofu: {
    versions: string;
    providerLock: string;
  };
}

const core: ContributionOwner = { kind: 'core' };
const nodeFastify: ContributionOwner = { kind: 'plugin', category: 'stack', id: 'node-fastify' };
const goHuma: ContributionOwner = { kind: 'plugin', category: 'stack', id: 'go-huma' };
const pythonFastapi: ContributionOwner = { kind: 'plugin', category: 'stack', id: 'python-fastapi' };
const azure: ContributionOwner = { kind: 'plugin', category: 'cloud', id: 'azure' };

function readPackagedText(...pathParts: string[]): string {
  return readFileSync(resolvePackageFile(...pathParts), 'utf8');
}

function ownerKey(owner: ContributionOwner): string {
  return owner.kind === 'core' ? 'core' : `${owner.category}:${owner.id}`;
}

// Resolves an explicit (owner, asset id) identity to its declared location; nothing is discovered.
function declaredPathParts(owner: ContributionOwner, id: string): readonly string[] {
  const declaration = builtinAssets.find(
    (asset) => asset.id === id && ownerKey(asset.owner) === ownerKey(owner)
  );
  if (!declaration) {
    throw new Error(`Packaged template asset ${ownerKey(owner)}/${id} is not declared.`);
  }
  return declaration.pathParts;
}

export function loadPackagedTemplateAssetContext(): PackagedTemplateAssetContext {
  const text = (owner: ContributionOwner, id: string) => readPackagedText(...declaredPathParts(owner, id));
  return {
    npm: {
      'node-backend': {
        packageJson: text(nodeFastify, 'node-backend-package-manifest'),
        packageLock: text(nodeFastify, 'node-backend-package-lock')
      },
      frontend: {
        packageJson: text(core, 'frontend-package-manifest'),
        packageLock: text(core, 'frontend-package-lock')
      }
    },
    python: {
      genai: {
        pyproject: text(pythonFastapi, 'python-genai-project'),
        lock: text(pythonFastapi, 'python-genai-lock')
      },
      standard: {
        pyproject: text(pythonFastapi, 'python-standard-project'),
        lock: text(pythonFastapi, 'python-standard-lock')
      }
    },
    functionRequirements: text(pythonFastapi, 'python-genai-function-requirements'),
    go: {
      module: text(goHuma, 'go-backend-module'),
      checksum: text(goHuma, 'go-backend-checksums')
    },
    opentofu: {
      versions: text(azure, 'opentofu-azure-versions'),
      providerLock: text(azure, 'opentofu-azure-provider-lock')
    }
  };
}

export const packagedTemplateAssets = loadPackagedTemplateAssetContext();
