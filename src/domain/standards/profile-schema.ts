import { createHash } from 'node:crypto';
import type { PatternId, ScaffoldStatus } from '../project/contracts.js';
import { validateArtifactPathParts } from '../project/paths.js';

export const STANDARDS_PROFILE_SCHEMA_VERSION = 1 as const;

export type SupportedApiStackProfileId =
  | 'python-fastapi'
  | 'node-fastify'
  | 'go-huma';

export type SupportedFrontendProfileId =
  | 'vue-component';

export type SupportedGenAiProfileId =
  | 'genai-generic'
  | 'genai-rag'
  | 'genai-chatbot'
  | 'genai-agent'
  | 'genai-prompt'
  | 'genai-multi-agent'
  | 'genai-fine-tuned'
  | 'genai-streaming'
  | 'genai-workflow';

export type StandardsProfileId =
  | SupportedApiStackProfileId
  | SupportedFrontendProfileId
  | SupportedGenAiProfileId;

export const SUPPORTED_STANDARDS_PROFILE_IDS: readonly StandardsProfileId[] = [
  'python-fastapi',
  'node-fastify',
  'go-huma',
  'vue-component',
  'genai-generic',
  'genai-rag',
  'genai-chatbot',
  'genai-agent',
  'genai-prompt',
  'genai-multi-agent',
  'genai-fine-tuned',
  'genai-streaming',
  'genai-workflow'
] as const;

export const KNOWN_UNSUPPORTED_STACK_IDS = [
  'express',
  'django',
  'flask',
  'spring',
  'aspnetcore',
  'rails',
  'nextjs',
  'remix',
  'angular',
  'svelte',
  'power-apps-code-app'
] as const;

export type KnownUnsupportedStackId = (typeof KNOWN_UNSUPPORTED_STACK_IDS)[number];

export type EvaluationRuleKind =
  | 'dependency'
  | 'entrypoint'
  | 'test'
  | 'build'
  | 'docker'
  | 'routing'
  | 'marker';

export interface EvaluationCoverageRule {
  id: string;
  description: string;
  kind: EvaluationRuleKind;
  mandatory: boolean;
}

export interface ProfileCapabilities {
  backend: boolean;
  language?: 'python' | 'typescript' | 'javascript' | 'go';
  framework?: string;
  cloud?: 'azure' | 'none';
  generationSupported: boolean;
  adoptionSupported: boolean;
  assessmentSupported: boolean;
  pattern?: PatternId;
  scaffoldStatus?: ScaffoldStatus;
  retrieval?: boolean;
  vectorStore?: boolean;
  worker?: boolean;
  streaming?: boolean;
}

export interface StandardsProfile {
  schemaVersion: 1;
  id: StandardsProfileId;
  label: string;
  revision: string;
  digest: string;
  category: 'backend' | 'frontend' | 'genai';
  targetWorkload: 'standard' | 'genai' | 'component-only';
  supported: true;
  componentBoundaries: string[];
  capabilities: ProfileCapabilities;
  evaluationCoverage: EvaluationCoverageRule[];
  requiredArtifacts?: string[];
}

export interface UnsupportedStackProfile {
  id: string;
  label: string;
  supported: false;
  assessmentOnly: true;
  reason: string;
  remedy: string;
}

export interface StandardsProfileCatalog {
  schemaVersion: 1;
  catalogId: string;
  revision: string;
  digest: string;
  profiles: Record<StandardsProfileId, StandardsProfile>;
  unsupportedStacks: Record<string, UnsupportedStackProfile>;
}

export class StandardsProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StandardsProfileError';
  }
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function computeCanonicalJson(value: unknown): string {
  if (value === undefined) {
    return 'null';
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new StandardsProfileError('Non-finite numbers cannot be canonicalized.');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => computeCanonicalJson(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${computeCanonicalJson(record[key])}`).join(',')}}`;
  }
  throw new StandardsProfileError(`Unsupported value type for canonical JSON: ${typeof value}`);
}

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

function assertOnlyKeys(obj: Record<string, unknown>, allowedKeys: readonly string[], label: string): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new StandardsProfileError(`${label} contains unknown field: ${JSON.stringify(key)}.`);
    }
  }
}

export function computeProfileDigest(profile: Omit<StandardsProfile, 'digest'>): string {
  const capEntries = Object.entries(profile.capabilities as unknown as Record<string, unknown>)
    .filter(([_, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));

  const canonical = computeCanonicalJson({
    schemaVersion: profile.schemaVersion,
    id: profile.id,
    label: profile.label,
    revision: profile.revision,
    category: profile.category,
    targetWorkload: profile.targetWorkload,
    supported: profile.supported,
    componentBoundaries: [...profile.componentBoundaries].sort(),
    capabilities: Object.fromEntries(capEntries),
    evaluationCoverage: profile.evaluationCoverage.map((rule) => ({
      id: rule.id,
      description: rule.description,
      kind: rule.kind,
      mandatory: rule.mandatory
    })),
    ...(profile.requiredArtifacts && profile.requiredArtifacts.length > 0
      ? { requiredArtifacts: [...profile.requiredArtifacts].sort() }
      : {})
  });
  return `sha256:${sha256Hex(canonical)}`;
}

export function computeProfileCatalogDigest(
  catalog: Omit<StandardsProfileCatalog, 'digest'>
): string {
  const canonical = computeCanonicalJson({
    schemaVersion: catalog.schemaVersion,
    catalogId: catalog.catalogId,
    revision: catalog.revision,
    profiles: Object.fromEntries(
      Object.keys(catalog.profiles)
        .sort()
        .map((k) => {
          const p = catalog.profiles[k as StandardsProfileId];
          const capEntries = Object.entries(p.capabilities as unknown as Record<string, unknown>)
            .filter(([_, v]) => v !== undefined)
            .sort(([a], [b]) => a.localeCompare(b));
          return [
            k,
            {
              schemaVersion: p.schemaVersion,
              id: p.id,
              label: p.label,
              revision: p.revision,
              digest: p.digest,
              category: p.category,
              targetWorkload: p.targetWorkload,
              supported: p.supported,
              componentBoundaries: [...p.componentBoundaries].sort(),
              capabilities: Object.fromEntries(capEntries),
              evaluationCoverage: p.evaluationCoverage,
              ...(p.requiredArtifacts && p.requiredArtifacts.length > 0
                ? { requiredArtifacts: [...p.requiredArtifacts].sort() }
                : {})
            }
          ];
        })
    ),
    unsupportedStacks: Object.fromEntries(
      Object.keys(catalog.unsupportedStacks)
        .sort()
        .map((k) => {
          const u = catalog.unsupportedStacks[k];
          return [
            k,
            {
              id: u.id,
              label: u.label,
              supported: u.supported,
              assessmentOnly: u.assessmentOnly,
              reason: u.reason,
              remedy: u.remedy
            }
          ];
        })
    )
  });
  return `sha256:${sha256Hex(canonical)}`;
}

export function targetProfileIdForPlan(plan: {
  workload: 'standard' | 'genai';
  apiStack?: { id: string };
  pattern?: { id: string };
}): StandardsProfileId {
  if (plan.workload === 'standard') {
    if (!plan.apiStack?.id || !isSupportedProfileId(plan.apiStack.id)) {
      throw new StandardsProfileError(`Invalid standard plan apiStack: ${JSON.stringify(plan.apiStack?.id)}`);
    }
    return plan.apiStack.id;
  }
  if (!plan.pattern?.id) {
    throw new StandardsProfileError('Invalid GenAI plan: missing pattern.');
  }
  const genaiId = `genai-${plan.pattern.id}`;
  if (!isSupportedProfileId(genaiId)) {
    throw new StandardsProfileError(`Invalid GenAI plan pattern: ${JSON.stringify(plan.pattern.id)}`);
  }
  return genaiId;
}

export function isSupportedProfileId(id: string): id is StandardsProfileId {
  return (SUPPORTED_STANDARDS_PROFILE_IDS as readonly string[]).includes(id);
}

export function isKnownUnsupportedStackId(id: string): boolean {
  return (KNOWN_UNSUPPORTED_STACK_IDS as readonly string[]).includes(id);
}

export function validateStandardsProfile(raw: unknown, strict = true): StandardsProfile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new StandardsProfileError('Standards profile must be an object.');
  }
  const obj = raw as Record<string, unknown>;

  assertOnlyKeys(
    obj,
    [
      'schemaVersion',
      'id',
      'label',
      'revision',
      'digest',
      'category',
      'targetWorkload',
      'supported',
      'componentBoundaries',
      'capabilities',
      'evaluationCoverage',
      'requiredArtifacts'
    ],
    'Standards profile'
  );

  if (obj['schemaVersion'] !== STANDARDS_PROFILE_SCHEMA_VERSION) {
    throw new StandardsProfileError(
      `Unsupported profile schemaVersion: expected 1, received ${JSON.stringify(obj['schemaVersion'])}.`
    );
  }

  const id = obj['id'];
  if (typeof id !== 'string' || !isSupportedProfileId(id)) {
    throw new StandardsProfileError(`Unknown or unsupported standards profile ID: ${JSON.stringify(id)}.`);
  }

  if (typeof obj['label'] !== 'string' || obj['label'].trim().length === 0) {
    throw new StandardsProfileError(`Profile ${id} missing non-empty label.`);
  }

  if (typeof obj['revision'] !== 'string' || obj['revision'].trim().length === 0) {
    throw new StandardsProfileError(`Profile ${id} missing non-empty revision.`);
  }

  const digest = obj['digest'];
  if (typeof digest !== 'string' || digest.length !== 71 || !SHA256_PATTERN.test(digest)) {
    throw new StandardsProfileError(`Profile ${id} missing valid sha256:64hex digest, received: ${JSON.stringify(digest)}.`);
  }

  if (obj['supported'] !== true) {
    throw new StandardsProfileError(`Supported profile ${id} must have supported: true.`);
  }

  const category = obj['category'];
  if (category !== 'backend' && category !== 'frontend' && category !== 'genai') {
    throw new StandardsProfileError(`Profile ${id} has invalid category: ${JSON.stringify(category)}.`);
  }

  const targetWorkload = obj['targetWorkload'];
  if (targetWorkload !== 'standard' && targetWorkload !== 'genai' && targetWorkload !== 'component-only') {
    throw new StandardsProfileError(`Profile ${id} has invalid targetWorkload: ${JSON.stringify(targetWorkload)}.`);
  }

  if (!Array.isArray(obj['componentBoundaries']) || obj['componentBoundaries'].length === 0) {
    throw new StandardsProfileError(`Profile ${id} must declare non-empty componentBoundaries.`);
  }
  for (const boundary of obj['componentBoundaries']) {
    if (typeof boundary !== 'string' || boundary.trim().length === 0) {
      throw new StandardsProfileError(`Profile ${id} component boundary must be a non-empty string.`);
    }
  }

  const capabilities = obj['capabilities'];
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    throw new StandardsProfileError(`Profile ${id} must declare capabilities object.`);
  }
  const cap = capabilities as Record<string, unknown>;
  assertOnlyKeys(
    cap,
    [
      'backend',
      'language',
      'framework',
      'cloud',
      'generationSupported',
      'adoptionSupported',
      'assessmentSupported',
      'pattern',
      'scaffoldStatus',
      'retrieval',
      'vectorStore',
      'worker',
      'streaming'
    ],
    `Profile ${id} capabilities`
  );

  if (typeof cap['backend'] !== 'boolean') {
    throw new StandardsProfileError(`Profile ${id} capabilities.backend must be a boolean.`);
  }
  if (typeof cap['generationSupported'] !== 'boolean') {
    throw new StandardsProfileError(`Profile ${id} capabilities.generationSupported must be a boolean.`);
  }
  if (typeof cap['adoptionSupported'] !== 'boolean') {
    throw new StandardsProfileError(`Profile ${id} capabilities.adoptionSupported must be a boolean.`);
  }
  if (typeof cap['assessmentSupported'] !== 'boolean') {
    throw new StandardsProfileError(`Profile ${id} capabilities.assessmentSupported must be a boolean.`);
  }

  // Truthful Vue-only boundary invariants:
  // Cannot invent a backend, cloud target, or historical generation
  if (id === 'vue-component') {
    if (cap['backend'] !== false) {
      throw new StandardsProfileError('Vue component profile must strictly declare backend: false.');
    }
    if (cap['cloud'] !== 'none' && cap['cloud'] !== undefined) {
      throw new StandardsProfileError('Vue component profile must not invent a cloud target.');
    }
    if (cap['generationSupported'] !== false) {
      throw new StandardsProfileError('Vue component profile must not declare generationSupported: true.');
    }
    if (cap['adoptionSupported'] !== true) {
      throw new StandardsProfileError('Vue component profile must support adoption.');
    }
    if (targetWorkload !== 'component-only') {
      throw new StandardsProfileError('Vue component profile must declare targetWorkload: "component-only".');
    }
  }

  // GenAI patterns boundary invariants:
  if (category === 'genai') {
    if (!cap['pattern'] || typeof cap['pattern'] !== 'string') {
      throw new StandardsProfileError(`GenAI profile ${id} must identify its exact pattern.`);
    }
    if (cap['backend'] !== true) {
      throw new StandardsProfileError(`GenAI profile ${id} must declare backend: true.`);
    }
  }

  // Standard API boundary invariants:
  if (targetWorkload === 'standard') {
    if (cap['backend'] !== true) {
      throw new StandardsProfileError(`Standard API profile ${id} must declare backend: true.`);
    }
    if (!cap['language'] || !cap['framework']) {
      throw new StandardsProfileError(`Standard API profile ${id} must declare language and framework.`);
    }
  }

  // Evaluation coverage validation:
  const coverage = obj['evaluationCoverage'];
  if (!Array.isArray(coverage) || coverage.length === 0) {
    throw new StandardsProfileError(`Profile ${id} must declare actual non-empty evaluationCoverage.`);
  }
  const validRuleKinds = new Set<string>([
    'dependency',
    'entrypoint',
    'test',
    'build',
    'docker',
    'routing',
    'marker'
  ]);
  for (const rule of coverage) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new StandardsProfileError(`Profile ${id} evaluation coverage rule must be an object.`);
    }
    const r = rule as Record<string, unknown>;
    assertOnlyKeys(r, ['id', 'description', 'kind', 'mandatory'], `Profile ${id} evaluation coverage rule`);
    if (typeof r['id'] !== 'string' || r['id'].trim().length === 0) {
      throw new StandardsProfileError(`Profile ${id} evaluation coverage rule missing non-empty string ID.`);
    }
    if (typeof r['description'] !== 'string' || r['description'].trim().length === 0) {
      throw new StandardsProfileError(`Profile ${id} evaluation rule ${r['id']} missing non-empty description.`);
    }
    if (typeof r['kind'] !== 'string' || !validRuleKinds.has(r['kind'])) {
      throw new StandardsProfileError(`Profile ${id} evaluation rule ${r['id']} has invalid kind: ${JSON.stringify(r['kind'])}.`);
    }
    if (typeof r['mandatory'] !== 'boolean') {
      throw new StandardsProfileError(`Profile ${id} evaluation rule ${r['id']} mandatory must be a boolean.`);
    }
  }

  if (obj['requiredArtifacts'] !== undefined) {
    if (!Array.isArray(obj['requiredArtifacts'])) {
      throw new StandardsProfileError(`Profile ${id} requiredArtifacts must be an array.`);
    }
    for (const artifact of obj['requiredArtifacts']) {
      if (typeof artifact !== 'string' || artifact.trim().length === 0) {
        throw new StandardsProfileError(`Profile ${id} required artifact must be a non-empty string.`);
      }
    }
  }

  const expectedCategory = id === 'vue-component' ? 'frontend' : id.startsWith('genai-') ? 'genai' : 'backend';
  const expectedWorkload = id === 'vue-component' ? 'component-only' : id.startsWith('genai-') ? 'genai' : 'standard';
  const expectedLanguage = id === 'go-huma' ? 'go' : id === 'node-fastify' || id === 'vue-component' ? 'typescript' : 'python';
  const expectedFramework = id === 'go-huma' ? 'huma' : id === 'node-fastify' ? 'fastify' : id === 'vue-component' ? 'vue' : 'fastapi';
  if (category !== expectedCategory || targetWorkload !== expectedWorkload ||
      cap.language !== expectedLanguage || cap.framework !== expectedFramework ||
      cap.cloud !== (id === 'vue-component' ? 'none' : 'azure')) {
    throw new StandardsProfileError(`Profile ${id} has incompatible category, workload, language, framework or cloud declarations.`);
  }
  if (id.startsWith('genai-') ? cap.pattern !== id.slice('genai-'.length) : cap.pattern !== undefined) {
    throw new StandardsProfileError(`Profile ${id} does not identify its exact supported pattern.`);
  }
  if (cap.scaffoldStatus !== undefined && !['foundation', 'integration-shell', 'full'].includes(String(cap.scaffoldStatus))) {
    throw new StandardsProfileError(`Profile ${id} has an unsupported scaffold maturity.`);
  }
  for (const key of ['worker', 'retrieval', 'vectorStore', 'streaming']) {
    if (cap[key] !== undefined && typeof cap[key] !== 'boolean') {
      throw new StandardsProfileError(`Profile ${id} capability ${key} must be boolean when declared.`);
    }
  }
  const boundaries = obj.componentBoundaries;
  if (!Array.isArray(boundaries) || boundaries.length > 64 || new Set(boundaries).size !== boundaries.length) {
    throw new StandardsProfileError(`Profile ${id} component boundaries must be bounded and unique.`);
  }
  for (const boundary of boundaries) {
    if (typeof boundary !== 'string' || boundary !== boundary.normalize('NFKC') ||
        /[\u0000-\u001f\u007f<>:"|?*]/u.test(boundary)) {
      throw new StandardsProfileError(`Profile ${id} component boundary is nonportable.`);
    }
    try { validateArtifactPathParts(boundary.split('/')); }
    catch { throw new StandardsProfileError(`Profile ${id} component boundary is unsafe.`); }
  }
  const ruleIds = coverage.map((rule) => (rule as Record<string, unknown>).id);
  if (coverage.length > 256 || new Set(ruleIds).size !== coverage.length) {
    throw new StandardsProfileError(`Profile ${id} evaluation rule identities must be bounded and unique.`);
  }
  const required = obj.requiredArtifacts;
  if (Array.isArray(required) && (required.length > 512 || new Set(required).size !== required.length)) {
    throw new StandardsProfileError(`Profile ${id} required artifact identities must be bounded and unique.`);
  }

  if (strict) {
    const computed = computeProfileDigest(obj as unknown as Omit<StandardsProfile, 'digest'>);
    if (computed !== obj['digest']) {
      throw new StandardsProfileError(
        `Profile ${id} digest mismatch: expected ${computed}, received ${obj['digest']}.`
      );
    }
  }

  return raw as StandardsProfile;
}

export function validateUnsupportedStackProfile(raw: unknown): UnsupportedStackProfile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new StandardsProfileError('Unsupported stack entry must be an object.');
  }
  const obj = raw as Record<string, unknown>;
  assertOnlyKeys(obj, ['id', 'label', 'supported', 'assessmentOnly', 'reason', 'remedy'], 'Unsupported stack entry');

  const id = obj['id'];
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new StandardsProfileError('Unsupported stack entry missing string ID.');
  }
  if (typeof obj['label'] !== 'string' || obj['label'].trim().length === 0) {
    throw new StandardsProfileError(`Unsupported stack ${id} missing non-empty label.`);
  }
  if (obj['supported'] !== false) {
    throw new StandardsProfileError(`Unsupported stack ${id} must declare supported: false.`);
  }
  if (obj['assessmentOnly'] !== true) {
    throw new StandardsProfileError(`Unsupported stack ${id} must declare assessmentOnly: true.`);
  }
  if (typeof obj['reason'] !== 'string' || obj['reason'].trim().length === 0) {
    throw new StandardsProfileError(`Unsupported stack ${id} must declare diagnostic reason.`);
  }
  if (typeof obj['remedy'] !== 'string' || obj['remedy'].trim().length === 0) {
    throw new StandardsProfileError(`Unsupported stack ${id} must declare diagnostic remedy.`);
  }
  return raw as UnsupportedStackProfile;
}

export function validateStandardsProfileCatalog(raw: unknown, strict = true): StandardsProfileCatalog {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new StandardsProfileError('Standards profile catalog must be an object.');
  }
  const obj = raw as Record<string, unknown>;
  assertOnlyKeys(
    obj,
    ['schemaVersion', 'catalogId', 'revision', 'digest', 'profiles', 'unsupportedStacks'],
    'Standards profile catalog'
  );

  if (obj['schemaVersion'] !== STANDARDS_PROFILE_SCHEMA_VERSION) {
    throw new StandardsProfileError(
      `Unsupported catalog schemaVersion: expected 1, received ${JSON.stringify(obj['schemaVersion'])}.`
    );
  }

  if (typeof obj['catalogId'] !== 'string' || obj['catalogId'].trim().length === 0) {
    throw new StandardsProfileError('Catalog missing catalogId.');
  }

  if (typeof obj['revision'] !== 'string' || obj['revision'].trim().length === 0) {
    throw new StandardsProfileError('Catalog missing revision.');
  }

  const digest = obj['digest'];
  if (typeof digest !== 'string' || digest.length !== 71 || !SHA256_PATTERN.test(digest)) {
    throw new StandardsProfileError(`Catalog missing valid sha256:64hex digest, received: ${JSON.stringify(digest)}.`);
  }

  const profiles = obj['profiles'];
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) {
    throw new StandardsProfileError('Catalog missing profiles record.');
  }

  const profileRecord = profiles as Record<string, unknown>;
  const seenIds = new Set<string>();

  for (const [key, profileValue] of Object.entries(profileRecord)) {
    if (seenIds.has(key)) {
      throw new StandardsProfileError(`Duplicate profile ID in catalog: ${key}.`);
    }
    seenIds.add(key);

    if (!isSupportedProfileId(key)) {
      throw new StandardsProfileError(`Unknown profile ID in catalog: ${key}.`);
    }

    const validated = validateStandardsProfile(profileValue, strict);
    if (validated.id !== key) {
      throw new StandardsProfileError(`Profile key ${key} does not match profile ID ${validated.id}.`);
    }
  }

  // Ensure ALL supported profile IDs are present
  for (const requiredId of SUPPORTED_STANDARDS_PROFILE_IDS) {
    if (!seenIds.has(requiredId)) {
      throw new StandardsProfileError(`Catalog is missing required supported profile: ${requiredId}.`);
    }
  }

  // Validate unsupported stacks
  const unsupported = obj['unsupportedStacks'];
  if (!unsupported || typeof unsupported !== 'object' || Array.isArray(unsupported)) {
    throw new StandardsProfileError('Catalog missing unsupportedStacks record.');
  }
  const unsupportedRecord = unsupported as Record<string, unknown>;
  for (const [key, entry] of Object.entries(unsupportedRecord)) {
    if (!isKnownUnsupportedStackId(key)) throw new StandardsProfileError(`Unknown unsupported-stack catalog identity: ${key}.`);
    const val = validateUnsupportedStackProfile(entry);
    if (val.id !== key) {
      throw new StandardsProfileError(`Unsupported stack key ${key} does not match entry ID ${val.id}.`);
    }
  }

  // Check required known unsupported stacks are registered
  for (const knownUnsupported of KNOWN_UNSUPPORTED_STACK_IDS) {
    if (!unsupportedRecord[knownUnsupported]) {
      throw new StandardsProfileError(`Catalog is missing required unsupported stack: ${knownUnsupported}.`);
    }
  }

  if (strict) {
    const computed = computeProfileCatalogDigest(obj as unknown as Omit<StandardsProfileCatalog, 'digest'>);
    if (computed !== obj['digest']) {
      throw new StandardsProfileError(
        `Catalog digest mismatch: expected ${computed}, received ${obj['digest']}.`
      );
    }
  }

  return raw as StandardsProfileCatalog;
}
