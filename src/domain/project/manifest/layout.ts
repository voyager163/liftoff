import { canonicalSha256 } from '../../governance/activation/canonical-json.js';
import type {
  ManifestActiveLayout, ManifestLayoutBinding, ManifestLayoutDescriptor
} from '../contracts.js';
import { FileSystemError } from '../errors.js';
import { validateArtifactPathParts } from '../paths.js';
import { assertOnlyFields, isRecord, requiredString } from './fields.js';

export const manifestLayoutBounds = Object.freeze({ pathParts: 32, partBytes: 255, pathBytes: 4096 });

const reservedParts = new Set([
  '.git', '.hg', '.svn', '.liftoff', '.terraform', '.tofu', '.terragrunt-cache',
  '.aws', '.azure', '.gcloud', '.kube', '.ssh', '.gnupg', 'terraform.tfstate.d'
]);
const reservedNames = new Set([
  'liftoff.manifest.json', 'liftoff.config.json', '.liftoff-init.lock',
  '.terraform.tfstate.lock.info'
]);
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const aliasPart = (part: string) => part.toUpperCase().toLowerCase();
const key = (parts: readonly string[]) => parts.map(aliasPart).join('/');
const within = (parent: string, child: string) => child === parent || child.startsWith(`${parent}/`);
const overlaps = (left: string, right: string) => within(left, right) || within(right, left);

function denseArray(value: unknown, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > maximum || Object.keys(value).length !== value.length) {
    throw new FileSystemError(`${label} must be a bounded dense array.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new FileSystemError(`${label} must not contain sparse entries.`);
  }
  return value;
}

function portablePath(value: unknown, label: string): readonly string[] {
  const raw = denseArray(value, manifestLayoutBounds.pathParts, label);
  const parts = validateArtifactPathParts(raw, label);
  // Device/name restrictions use the same alias equivalence without changing stored spelling.
  validateArtifactPathParts(parts.map(aliasPart), label);
  if (parts.some((part) =>
    /[\u0000-\u001f\u007f-\u009f<>:"|?*\p{Cf}\p{Surrogate}]/u.test(part) ||
    /^(?:conin|conout)\$(?:\.|$)/.test(aliasPart(part)) ||
    part !== part.normalize('NFKC') || Buffer.byteLength(part, 'utf8') > manifestLayoutBounds.partBytes
  ) || Buffer.byteLength(parts.join('/'), 'utf8') > manifestLayoutBounds.pathBytes) {
    throw new FileSystemError(`${label} contains a non-portable name or exceeds portable path bounds.`);
  }
  return Object.freeze(parts);
}

/**
 * Validates metadata only. Bound paths still need independent filesystem
 * confinement and operation-specific approval before any access or mutation.
 */
export function validateManifestActiveLayout(
  value: unknown,
  descriptor: ManifestLayoutDescriptor
): ManifestActiveLayout {
  if (!isRecord(value)) throw new FileSystemError('Active layout must be a JSON object.');
  assertOnlyFields(value, ['schemaVersion', 'state', 'bindings'], 'Active layout');
  if (value.schemaVersion !== 1) throw new FileSystemError('Active layout schemaVersion must be 1.');
  if (value.state !== 'unresolved' && value.state !== 'bound') {
    throw new FileSystemError('Active layout state must be unresolved or bound.');
  }
  const entries = denseArray(value.bindings, descriptor.components.length + descriptor.artifacts.length, 'Active layout bindings');
  if (value.state === 'unresolved') {
    if (entries.length !== 0) throw new FileSystemError('Unresolved active layout must have empty bindings.');
    return Object.freeze({ schemaVersion: 1, state: 'unresolved', bindings: Object.freeze([] as const) });
  }
  if (entries.length === 0) throw new FileSystemError('Bound active layout must contain at least one binding.');

  const names = new Set<string>();
  const spellings = new Map<string, string>();
  const artifacts = new Map(descriptor.artifacts.map((artifact) => [artifact.logicalName, artifact]));
  const protectedPaths = descriptor.protectedPaths.map(key);
  const bindings = entries.map((entry, index): ManifestLayoutBinding => {
    const scope = `Active layout bindings[${index}]`;
    if (!isRecord(entry)) throw new FileSystemError(`${scope} must be a JSON object.`);
    const kind = requiredString(entry, 'kind', scope);
    if (kind !== 'component' && kind !== 'artifact') throw new FileSystemError(`${scope}.kind is invalid.`);
    assertOnlyFields(entry, kind === 'component'
      ? ['kind', 'component', 'pathParts'] : ['kind', 'logicalName', 'pathParts'], scope);
    const id = requiredString(entry, kind === 'component' ? 'component' : 'logicalName', scope);
    const component = descriptor.components.find((candidate) => candidate === id);
    if (kind === 'component' ? component === undefined : !artifacts.has(id)) {
      throw new FileSystemError(`${scope} names an unknown or unselected ${kind} ${JSON.stringify(id)}.`);
    }
    const identity = `${kind}:${id}`;
    if (names.has(identity)) throw new FileSystemError(`Active layout contains duplicate identity ${identity}.`);
    names.add(identity);
    const pathParts = portablePath(entry.pathParts, `${scope}.pathParts`);
    const folded = key(pathParts);
    if (pathParts.some((part) => {
      const foldedPart = aliasPart(part);
      return reservedParts.has(foldedPart) || reservedNames.has(foldedPart) ||
        /\.(?:tfstate|tfplan)(?:\.|$)/.test(foldedPart);
    }) ||
      protectedPaths.some((reserved) => overlaps(reserved, folded))) {
      throw new FileSystemError(`${scope} overlaps a reserved metadata, framework, repository or state boundary.`);
    }
    for (let length = 1; length <= pathParts.length; length += 1) {
      const prefix = pathParts.slice(0, length);
      const foldedPrefix = key(prefix);
      const spelling = prefix.join('/');
      const previous = spellings.get(foldedPrefix);
      if (previous !== undefined && previous !== spelling) {
        throw new FileSystemError(`${scope} contains an aliased path spelling.`);
      }
      spellings.set(foldedPrefix, spelling);
    }
    return Object.freeze(kind === 'component' && component !== undefined
      ? { kind, component, pathParts }
      : { kind: 'artifact', logicalName: id, pathParts });
  });

  for (let index = 0; index < bindings.length; index += 1) {
    const left = bindings[index];
    for (const right of bindings.slice(index + 1)) {
      const leftPath = key(left.pathParts), rightPath = key(right.pathParts);
      if (!overlaps(leftPath, rightPath)) continue;
      const component = left.kind === 'component' ? left : right.kind === 'component' ? right : undefined;
      const artifact = left.kind === 'artifact' ? left : right.kind === 'artifact' ? right : undefined;
      if (leftPath !== rightPath && component && artifact &&
        within(key(component.pathParts), key(artifact.pathParts)) &&
        artifacts.get(artifact.logicalName)?.component === component.component) continue;
      throw new FileSystemError('Active layout contains overlapping components, duplicate paths or a file-prefix conflict.');
    }
  }
  for (const artifact of bindings.filter((binding) => binding.kind === 'artifact')) {
    const owner = artifacts.get(artifact.logicalName)?.component;
    const component = bindings.find((binding) => binding.kind === 'component' && binding.component === owner);
    if (component && !within(key(component.pathParts), key(artifact.pathParts))) {
      throw new FileSystemError(`Active layout artifact ${artifact.logicalName} is outside its bound component.`);
    }
  }
  bindings.sort((left, right) => compareText(
    `${left.kind}:${left.kind === 'component' ? left.component : left.logicalName}`,
    `${right.kind}:${right.kind === 'component' ? right.component : right.logicalName}`
  ));
  return Object.freeze({ schemaVersion: 1, state: 'bound', bindings: Object.freeze(bindings) });
}

export function manifestActiveLayoutDigest(value: unknown, descriptor: ManifestLayoutDescriptor): `sha256:${string}` {
  return `sha256:${canonicalSha256({
    kind: 'liftoff-active-layout',
    layout: validateManifestActiveLayout(value, descriptor)
  })}`;
}

export { key as manifestPathAliasKey, portablePath as validateManifestPathParts };
