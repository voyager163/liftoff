import { modernActivationSourceContracts } from '../policy/identity.js';
import { canonicalSha256 } from './canonical-json.js';
import { exactRecord } from '../../project/manifest/fields.js';
import { createManifestV8ProjectReader } from '../../project/manifest/v8-project.js';
import type { ManifestContractContext } from '../../project/manifest/context.js';
import type {
  ModernActivationSourceInput, ModernDigest, ReadableModernActivationIdentity, StaticModernActivationIdentity
} from './modern-record-contracts.js';

export type { ModernActivationSourceInput, ModernActivationSelection, ReadableModernActivationIdentity } from './modern-record-contracts.js';

export type ModernIdentityCreationInput = Omit<ModernActivationSourceInput, 'recordedIdentity'> & {
  readonly sourceVersion: StaticModernActivationIdentity['liftoffVersion'];
};

function digest(value: unknown, label: string): ModernDigest {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be a complete prefixed lowercase SHA-256 digest.`);
  }
  return value as ModernDigest;
}

/** Trusted catalog values select the actual M6 reader, never an arbitrary caller parser or current default. */
export function createModernActivationIdentityReader(catalog: ManifestContractContext['catalog']) {
  const projectReader = createManifestV8ProjectReader(catalog);
  const sources = modernActivationSourceContracts();
  const contextFields = ['profile', 'policyVersion', 'selection', 'pluginResolutionDigest', 'activeLayoutDigest'] as const;
  const identityFields = [...Object.keys(sources[0].identity), 'sourceSelectionDigest', 'pluginResolutionDigest', 'activeLayoutDigest'];

  function identityFromContext(request: Record<string, unknown>, sourceVersion: unknown): ReadableModernActivationIdentity {
    const selection = exactRecord(request.selection, ['project', 'framework', 'profile'], 'Modern activation selection');
    if (selection.profile !== request.profile) throw new Error('Modern activation selection and governance profile disagree.');
    const leaf = projectReader.validateManifestV8Project({ project: selection.project, framework: selection.framework });
    const source = sources.find(source => source.identity.liftoffVersion === sourceVersion &&
      source.identity.profile === request.profile && source.identity.policyVersion === request.policyVersion &&
      source.identity.workflow === leaf.project.specWorkflow);
    if (!source) throw new Error('Modern activation requires an exact declared source version, profile, policy and workflow.');
    const pluginResolutionDigest = digest(request.pluginResolutionDigest, 'Modern activation plugin resolution');
    const activeLayoutDigest = digest(request.activeLayoutDigest, 'Modern activation active layout');
    const sourceSelectionDigest: ModernDigest = `sha256:${canonicalSha256({
      kind: 'liftoff-activation-source-selection', schemaVersion: 1,
      profile: source.identity.profile, project: leaf.project, framework: leaf.framework
    })}`;
    return Object.freeze({ ...source.identity, sourceSelectionDigest, pluginResolutionDigest, activeLayoutDigest });
  }

  function validateReadableModernActivationIdentity(input: ModernActivationSourceInput): ReadableModernActivationIdentity {
    const request = exactRecord(input, ['recordedIdentity', ...contextFields], 'Modern activation source input');
    const recorded = exactRecord(request.recordedIdentity, identityFields, 'Modern activation identity');
    const expected = identityFromContext(request, recorded.liftoffVersion);
    if (Object.entries(expected).some(([key, value]) => recorded[key] !== value)) {
      throw new Error('Modern activation identity does not match its complete source contract and independently supplied context.');
    }
    return expected;
  }

  function identityForSource(input: ModernIdentityCreationInput): ReadableModernActivationIdentity {
    const request = exactRecord(input, ['sourceVersion', ...contextFields], 'Modern activation source construction');
    return identityFromContext(request, request.sourceVersion);
  }

  return Object.freeze({ validateReadableModernActivationIdentity, identityForSource });
}
