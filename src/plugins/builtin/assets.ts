import type { AssetDeclaration, ContributionOwner } from '../contracts.js';

/*
 * Release-owned declarations of the packaged template dependency-set assets. This module is data
 * only: deeply frozen literals and type-only imports. Each asset is identified by its owner and
 * id. Its location grants no directory ownership, and equal bytes never imply shared ownership.
 */

export type BuiltinAssetRole = 'manifest' | 'lock' | 'export';

export interface BuiltinAssetDeclaration extends AssetDeclaration {
  readonly owner: ContributionOwner;
  /** Installable dependency set; its members share one set directory. */
  readonly set: string;
  readonly role: BuiltinAssetRole;
}

export const builtinAssets: readonly BuiltinAssetDeclaration[] = Object.freeze([
  Object.freeze({
    owner: Object.freeze({ kind: 'plugin', category: 'stack', id: 'node-fastify' }),
    id: 'node-backend-package-manifest',
    pathParts: Object.freeze(['assets', 'plugins', 'node-fastify', 'node-backend', 'package.json']),
    set: 'node-backend',
    role: 'manifest'
  }),
  Object.freeze({
    owner: Object.freeze({ kind: 'plugin', category: 'stack', id: 'node-fastify' }),
    id: 'node-backend-package-lock',
    pathParts: Object.freeze(['assets', 'plugins', 'node-fastify', 'node-backend', 'package-lock.json']),
    set: 'node-backend',
    role: 'lock'
  }),
  Object.freeze({
    owner: Object.freeze({ kind: 'plugin', category: 'stack', id: 'go-huma' }),
    id: 'go-backend-module',
    pathParts: Object.freeze(['assets', 'plugins', 'go-huma', 'go-backend', 'go.mod']),
    set: 'go-backend',
    role: 'manifest'
  }),
  Object.freeze({
    owner: Object.freeze({ kind: 'plugin', category: 'stack', id: 'go-huma' }),
    id: 'go-backend-checksums',
    pathParts: Object.freeze(['assets', 'plugins', 'go-huma', 'go-backend', 'go.sum']),
    set: 'go-backend',
    role: 'lock'
  }),
  Object.freeze({
    owner: Object.freeze({ kind: 'plugin', category: 'stack', id: 'python-fastapi' }),
    id: 'python-standard-project',
    pathParts: Object.freeze(['assets', 'plugins', 'python-fastapi', 'python-standard', 'pyproject.toml']),
    set: 'python-standard',
    role: 'manifest'
  }),
  Object.freeze({
    owner: Object.freeze({ kind: 'plugin', category: 'stack', id: 'python-fastapi' }),
    id: 'python-standard-lock',
    pathParts: Object.freeze(['assets', 'plugins', 'python-fastapi', 'python-standard', 'uv.lock']),
    set: 'python-standard',
    role: 'lock'
  }),
  Object.freeze({
    owner: Object.freeze({ kind: 'plugin', category: 'stack', id: 'python-fastapi' }),
    id: 'python-genai-project',
    pathParts: Object.freeze(['assets', 'plugins', 'python-fastapi', 'python-genai', 'pyproject.toml']),
    set: 'python-genai',
    role: 'manifest'
  }),
  Object.freeze({
    owner: Object.freeze({ kind: 'plugin', category: 'stack', id: 'python-fastapi' }),
    id: 'python-genai-lock',
    pathParts: Object.freeze(['assets', 'plugins', 'python-fastapi', 'python-genai', 'uv.lock']),
    set: 'python-genai',
    role: 'lock'
  }),
  Object.freeze({
    owner: Object.freeze({ kind: 'plugin', category: 'stack', id: 'python-fastapi' }),
    id: 'python-genai-function-requirements',
    pathParts: Object.freeze(['assets', 'plugins', 'python-fastapi', 'python-genai', 'function-requirements.txt']),
    set: 'python-genai',
    role: 'export'
  }),
  Object.freeze({
    owner: Object.freeze({ kind: 'plugin', category: 'cloud', id: 'azure' }),
    id: 'opentofu-azure-versions',
    pathParts: Object.freeze(['assets', 'plugins', 'azure', 'opentofu-azure', 'versions.tf']),
    set: 'opentofu-azure',
    role: 'manifest'
  }),
  Object.freeze({
    owner: Object.freeze({ kind: 'plugin', category: 'cloud', id: 'azure' }),
    id: 'opentofu-azure-provider-lock',
    pathParts: Object.freeze(['assets', 'plugins', 'azure', 'opentofu-azure', '.terraform.lock.hcl']),
    set: 'opentofu-azure',
    role: 'lock'
  }),
  Object.freeze({
    owner: Object.freeze({ kind: 'core' }),
    id: 'frontend-package-manifest',
    pathParts: Object.freeze(['assets', 'templates', 'common', 'frontend', 'package.json']),
    set: 'frontend',
    role: 'manifest'
  }),
  Object.freeze({
    owner: Object.freeze({ kind: 'core' }),
    id: 'frontend-package-lock',
    pathParts: Object.freeze(['assets', 'templates', 'common', 'frontend', 'package-lock.json']),
    set: 'frontend',
    role: 'lock'
  })
]);
