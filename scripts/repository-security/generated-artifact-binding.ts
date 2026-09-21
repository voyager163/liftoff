import { readFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalDigest } from './admission.ts';
import { digest, identifier, portableParts, SecurityEvidenceError } from './evidence.ts';
import { generatedSecurityCases } from './inventory.ts';

const registered: ReadonlyMap<string, string> = (() => {
  try {
    const source = readFileSync(new URL('../../security/generated-role-diagnostic-decision.json', import.meta.url), 'utf8');
    if (Buffer.byteLength(source) > 32_768) throw new Error();
    const value = JSON.parse(source).artifactInventoryDigests;
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).sort().join() !== generatedSecurityCases.map(entry => entry.id).sort().join()) throw new Error();
    return new Map(Object.entries(value).map(([caseId, value]) => [caseId, digest(value)]));
  } catch { throw new SecurityEvidenceError('generated-artifact-baseline-registration'); }
})();

export interface GeneratedArtifactBinding {
  caseId: string;
  target: 'backend' | 'frontend';
  artifactInventoryDigest: string;
  files: readonly { logicalName: string; pathParts: readonly string[]; digest: string }[];
}

export function requireGeneratedArtifactBaseline(caseId: string, inventoryDigest: string): void {
  if (registered.get(caseId) !== digest(inventoryDigest)) throw new SecurityEvidenceError('generated-artifact-baseline-mismatch');
}

export async function verifyGeneratedArtifactBinding(
  value: GeneratedArtifactBinding, context: string, readDigest: (filename: string) => Promise<string>
) {
  requireGeneratedArtifactBaseline(value.caseId, value.artifactInventoryDigest);
  if (!['backend', 'frontend'].includes(value.target) || !Array.isArray(value.files) ||
      !value.files.length || value.files.length > 1000 || canonicalDigest(value.files) !== value.artifactInventoryDigest ||
      new Set(value.files.map(file => file.pathParts.join('/').toLowerCase())).size !== value.files.length) {
    throw new SecurityEvidenceError('generated-artifact-inventory-mismatch');
  }
  const root = value.target === 'frontend' ? path.dirname(context) : context;
  for (const file of value.files) {
    identifier(file.logicalName, 'generated-artifact-name');
    const target = path.join(root, ...portableParts([...file.pathParts]));
    if (await readDigest(target) !== digest(file.digest)) throw new SecurityEvidenceError('generated-artifact-content-mismatch');
  }
}
