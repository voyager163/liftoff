import { readFileSync } from 'node:fs';
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

function readPackagedText(...pathParts: string[]): string {
  return readFileSync(resolvePackageFile(...pathParts), 'utf8');
}

export function loadPackagedTemplateAssetContext(): PackagedTemplateAssetContext {
  const npm = (template: PackagedNpmTemplateId) => ({
    packageJson: readPackagedText('assets', 'locks', template, 'package.json'),
    packageLock: readPackagedText('assets', 'locks', template, 'package-lock.json')
  });
  const python = (template: PackagedPythonTemplateId) => ({
    pyproject: readPackagedText(
      'assets',
      'locks',
      `python-${template}`,
      'pyproject.toml'
    ),
    lock: readPackagedText('assets', 'locks', `python-${template}`, 'uv.lock')
  });
  return {
    npm: {
      'node-backend': npm('node-backend'),
      frontend: npm('frontend')
    },
    python: {
      genai: python('genai'),
      standard: python('standard')
    },
    functionRequirements: readPackagedText(
      'assets',
      'locks',
      'python-genai',
      'function-requirements.txt'
    ),
    go: {
      module: readPackagedText('assets', 'locks', 'go-backend', 'go.mod'),
      checksum: readPackagedText('assets', 'locks', 'go-backend', 'go.sum')
    },
    opentofu: {
      versions: readPackagedText(
        'assets',
        'locks',
        'opentofu-azure',
        'versions.tf'
      ),
      providerLock: readPackagedText(
        'assets',
        'locks',
        'opentofu-azure',
        '.terraform.lock.hcl'
      )
    }
  };
}

export const packagedTemplateAssets = loadPackagedTemplateAssetContext();
