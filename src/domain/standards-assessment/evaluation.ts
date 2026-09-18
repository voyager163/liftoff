import path from 'node:path';
import type {
  AssessmentFinding, AssessmentInventory, AssessmentTarget, EvidenceReference, FindingClassification,
  JsonValue, RuleDefinition, StandardsProfileIdentity
} from './types.js';
import { getRuleDefinition, normalizeRuleId } from './rules.js';
import { containsSensitiveText, sanitizeText } from './sanitizer.js';

export const assessmentEvidenceBounds = {
  referencesPerFinding: 64,
  factArrayEntries: 64,
  factProperties: 32,
  factDepth: 4,
  factNodes: 256,
  factBytes: 8192,
  factStringCharacters: 512,
  referencePathCharacters: 2048,
  referenceBytes: 16_384,
  limitationsPerFinding: 12,
  routesPerSource: 128,
  observedComponents: 64,
  profileDiagnostics: 64
} as const;

interface FileEvidence { path: string; digest: string }
export interface DependencyObservation {
  root: string;
  declaration: FileEvidence & { type: string };
  locks: Array<FileEvidence & { type: string }>;
  status: 'consistent' | 'missing' | 'mismatched' | 'unknown';
  reason: string;
  integrityVerified: false;
}
export interface StaticRouteObservation {
  path: string;
  sourceFile: string;
  digest: string;
  line?: number;
  method?: string;
  isSpaHtml?: boolean;
  evidenceKind?: 'static-registration' | 'static-configuration';
}
export interface ExtractedEvidence {
  manifest?: {
    present: boolean | null;
    version?: number;
    path?: string;
    digest?: string;
    source?: 'guarded-project-root' | 'inventory' | 'unobserved';
    schemaValidated?: boolean;
    contentCapturedInInventory?: boolean;
    issue?: string;
  };
  dependencies?: {
    declarations: Array<FileEvidence & { type: string }>;
    locks: Array<FileEvidence & { type: string }>;
    matching: boolean;
    malformedDeclarations?: string[];
    components?: DependencyObservation[];
  };
  ambiguousStack?: string;
  components?: Array<{
    detectedFramework: string; isSupported: boolean; profileId: string | null; componentRoot?: string; status?: string;
    evidence: { declarationFile?: string; sourceFile?: string; details: string };
  }>;
  sourceLimitations?: Array<{ path: string; reason: string }>;
  uncapturedFiles?: string[];
  sourceEvidenceOmissions?: Array<{ path: string; count: number }>;
  endpoints?: { healthRoutes: StaticRouteObservation[]; docsRoutes: StaticRouteObservation[] };
  tests?: { declared: boolean; framework?: string; testFiles: FileEvidence[]; declaredFiles?: FileEvidence[] };
  containers?: { dockerfile?: FileEvidence; compose?: FileEvidence & { valid?: boolean; serviceCount?: number; issue?: string } };
  frameworks?: { openspec?: FileEvidence; specKit?: FileEvidence };
  infrastructure?: { opentofu?: FileEvidence; terraformFiles: FileEvidence[] };
  frontend?: { entrypoints: FileEvidence[]; components: FileEvidence[]; viteConfigs: FileEvidence[]; tailwindConfigs?: FileEvidence[] };
}

function componentPath(profile: StandardsProfileIdentity, target: AssessmentTarget): string | undefined {
  if (profile.componentRoot === undefined) return undefined;
  const scanRoot = path.relative(target.projectRoot, target.scanRoot).split(path.sep).join('/') || '.';
  const relative = path.posix.relative(scanRoot, profile.componentRoot || '.');
  return relative === '' ? '.' : relative;
}
const within = (file: string, root: string) => root === '.' || file === root || file.startsWith(`${root}/`);

function boundedObservation(facts: AssessmentFinding['observed']['facts'], references: EvidenceReference[], limitations: string[]) {
  const bounds = assessmentEvidenceBounds;
  let omittedFacts = 0, omittedReferences = 0, withheld = false, factNodes = 0, referenceBytes = 0;
  const value = (input: JsonValue, depth = 0): JsonValue => {
    if (++factNodes > bounds.factNodes) { omittedFacts++; return '[withheld: fact node limit]'; }
    if (typeof input === 'string') {
      if (containsSensitiveText(input) || /[\u0000-\u001f\u007f-\u009f]/u.test(input)) {
        omittedFacts++; withheld = true;
        return '[withheld: unsafe fact text]';
      }
      if (input.length > bounds.factStringCharacters) {
        omittedFacts++;
        return '[withheld: fact text limit]';
      }
      return input;
    }
    if (typeof input === 'number' && !Number.isFinite(input)) { omittedFacts++; withheld = true; return null; }
    if (input === null || typeof input !== 'object') return input;
    if (depth >= bounds.factDepth) { omittedFacts++; return '[withheld: fact depth limit]'; }
    if (Array.isArray(input)) {
      omittedFacts += Math.max(0, input.length - bounds.factArrayEntries);
      return input.slice(0, bounds.factArrayEntries).map((entry) => value(entry, depth + 1));
    }
    const entries = Object.entries(input).sort(([a], [b]) => a.localeCompare(b, 'en'));
    omittedFacts += Math.max(0, entries.length - bounds.factProperties);
    return Object.fromEntries(entries.slice(0, bounds.factProperties).flatMap(([key, entry]) => {
      if (key.length > bounds.factStringCharacters || containsSensitiveText(key) || /[\u0000-\u001f\u007f-\u009f]/u.test(key)) {
        omittedFacts++; withheld = true;
        return [];
      }
      return [[key, value(entry, depth + 1)]];
    }));
  };
  const bounded = value(facts);
  let boundedFacts: AssessmentFinding['observed']['facts'] = Array.isArray(bounded)
    ? bounded.map((entry) => typeof entry === 'string' ? entry : '[withheld: unsupported fact]')
    : bounded !== null && typeof bounded === 'object' ? bounded : { evidenceUnavailable: true };
  if (Buffer.byteLength(JSON.stringify(boundedFacts)) > bounds.factBytes) {
    boundedFacts = { factsWithheldByByteLimit: true };
    omittedFacts++;
  }
  const unique = new Map<string, EvidenceReference>();
  for (const reference of [...references].sort((a, b) => a.path.localeCompare(b.path, 'en') || (a.line ?? 0) - (b.line ?? 0))) {
    if (reference.path.length > bounds.referencePathCharacters || containsSensitiveText(reference.path) ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(reference.path) ||
        reference.line !== undefined && (!Number.isSafeInteger(reference.line) || reference.line < 1) ||
        reference.digest !== null && !/^(?:sha256:)?[a-f0-9]{64}$/u.test(reference.digest)) {
      omittedReferences++; withheld = true;
      continue;
    }
    const key = JSON.stringify([reference.path, reference.digest, reference.line]);
    if (unique.has(key)) continue;
    const bytes = Buffer.byteLength(JSON.stringify(reference));
    if (unique.size >= bounds.referencesPerFinding || referenceBytes + bytes > bounds.referenceBytes) { omittedReferences++; continue; }
    unique.set(key, reference);
    referenceBytes += bytes;
  }
  const cleanedLimitations = [...new Set(limitations.map((entry) => sanitizeText(entry, bounds.factStringCharacters)))];
  const omittedLimitations = Math.max(0, cleanedLimitations.length - (bounds.limitationsPerFinding - 1));
  const limited = omittedFacts > 0 || omittedReferences > 0 || omittedLimitations > 0 || withheld;
  const summaries = cleanedLimitations.slice(0, bounds.limitationsPerFinding - 1);
  if (limited) summaries.push(`Evidence output is partial: ${omittedReferences} references, ${omittedFacts} facts and ${omittedLimitations} limitations omitted; unsafe values are withheld.`);
  return {
    limited,
    observed: {
      facts: boundedFacts,
      references: [...unique.values()],
      limitations: summaries
    }
  };
}

export function evaluateRule(
  rule: RuleDefinition, profile: StandardsProfileIdentity, target: AssessmentTarget,
  inventory: AssessmentInventory, evidence: ExtractedEvidence
): AssessmentFinding {
  const root = componentPath(profile, target);
  const scope = rule.applicableScope === 'project' ? '.' :
    profile.componentRoot ?? (path.relative(target.projectRoot, target.scanRoot).split(path.sep).join('/') || '.');
  const declaredRoots = [...new Set(evidence.dependencies?.components?.map((entry) => entry.root) ?? [])];
  const selected = (file: string) => rule.applicableScope === 'project' || root === undefined ||
    within(file, root) && !declaredRoots.some((other) => other !== root && within(other, root) && within(file, other));
  const matchingSource = evidence.components?.some((entry) => entry.status === 'observed' && entry.isSupported &&
    entry.profileId === profile.id && (!profile.componentRoot || entry.componentRoot === profile.componentRoot)) === true;
  const references = (files: readonly FileEvidence[]): EvidenceReference[] =>
    files.filter((file) => selected(file.path)).map((file) => ({ path: file.path, digest: file.digest })).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const base = (classification: FindingClassification, facts: AssessmentFinding['observed']['facts'],
    refs: EvidenceReference[] = [], limitations: string[] = []): AssessmentFinding => {
    const observation = boundedObservation(facts, refs,
      classification === 'aligned' && rule.applicableScope === 'component' && !matchingSource
        ? [...limitations, 'A requested profile is not observed source; matching component identity remains unverified.'] : limitations);
    return {
      ruleId: rule.id, title: rule.title, targetProfile: profile.id, scope, severity: rule.severity,
      classification: classification === 'aligned' && (observation.limited || rule.applicableScope === 'component' && !matchingSource) ? 'unknown' : classification,
      expected: rule.expected, observed: observation.observed
    };
  };
  const incomplete = inventory.limits.exceeded || inventory.unobserved.some((entry) => selected(entry.path)) ||
    evidence.uncapturedFiles?.some(selected) === true;
  const absent = (facts: AssessmentFinding['observed']['facts'], refs: EvidenceReference[] = [], limitations: string[] = []) =>
    incomplete ? base('unknown', facts, refs, [...limitations, 'Scope unobserved: incomplete inventory cannot establish absence.']) :
      base('missing', facts, refs, limitations);
  const componentRoots = new Set(evidence.components?.map((entry) => entry.componentRoot).filter(Boolean));
  const componentAmbiguous = rule.applicableScope === 'component' && !root && componentRoots.size > 1;
  if (rule.applicableScope === 'project' && normalizeRuleId(rule.id) !== 'STD-LIFTOFF-MANIFEST' &&
      path.resolve(target.scanRoot) !== path.resolve(target.projectRoot)) {
    return base('unknown', { projectScopeCaptured: false }, [],
      ['Project-level inputs lie outside the selected component snapshot; they are not reported absent or aligned.']);
  }
  if (componentAmbiguous) return base('unknown', { componentSelection: 'unresolved', observedComponentCount: componentRoots.size }, [],
    ['Multiple component roots cannot supply interchangeable evidence for one whole-target profile. Select an exact component.']);
  if (root?.startsWith('../') || root === '..') return base('unknown', { componentSelection: 'outside-captured-scope' });
  if (rule.applicableProfiles.length && !rule.applicableProfiles.includes(profile.id)) {
    return base('inapplicable', { reason: 'The selected profile does not declare this component capability.' });
  }
  const sourceLimitations = [
    ...evidence.sourceLimitations?.filter((entry) => selected(entry.path)).map((entry) => `${entry.path}: ${entry.reason}`) ?? [],
    ...evidence.sourceEvidenceOmissions?.filter((entry) => selected(entry.path)).map((entry) => `${entry.count} source observations were omitted by the bounded evidence collector.`) ?? []
  ];

  switch (normalizeRuleId(rule.id)) {
    case 'STD-LIFTOFF-MANIFEST': {
      const manifest = evidence.manifest;
      if (!manifest?.present) return target.hasManifest === true || manifest?.present === null
        ? base('unknown', { manifestIdentityObserved: false }, [], [manifest?.issue ?? 'The project manifest identity was not established by the captured inventory or guarded boundary.'])
        : absent({ manifestContentCaptured: false });
      return base('unknown', {
        manifestPresent: true, manifestVersion: manifest.version ?? null,
        manifestEvidenceSource: manifest.source ?? 'inventory',
        manifestSchemaValidated: manifest.schemaValidated === true,
        manifestContentCapturedInInventory: manifest.contentCapturedInInventory === true,
        lifecycleConformanceVerified: false
      }, manifest.path && manifest.digest ? [{ path: manifest.path, digest: manifest.digest }] : [],
      [
        ...(manifest.source === 'guarded-project-root' ? ['Root-manifest identity comes from the guarded boundary capture; no parent or sibling payload was reread or inventoried.'] : []),
        'Manifest presence or schema validation is not complete lifecycle conformance evidence.'
      ]);
    }
    case 'STD-DEP-LOCK': {
      const dependencies = evidence.dependencies;
      const allReferences = references([...(dependencies?.declarations ?? []), ...(dependencies?.locks ?? [])]);
      const components = dependencies?.components?.filter((entry) => root === undefined || entry.root === root) ?? [];
      if (evidence.ambiguousStack) return base('conflicting', { conflictingStackEvidence: true }, allReferences,
        ['Conflicting stack evidence requires explicit review; raw source or supplied claims are not published.']);
      if (dependencies?.malformedDeclarations?.some(selected)) {
        return base('unknown', { declarationParsing: 'incomplete', artifactIntegrityVerified: false }, allReferences,
          ['Malformed captured declarations cannot establish dependency or lock consistency.']);
      }
      if (!components.length) return dependencies?.declarations.length
        ? base('unknown', { lockMetadataVerified: false, artifactIntegrityVerified: false }, allReferences,
          ['Name presence or a supplied matching flag is not a declaration/lock comparison.'])
        : absent({ declarationsCaptured: false }, allReferences);
      const mismatched = components.filter((entry) => entry.status === 'mismatched');
      if (mismatched.length) return base('difference', {
        lockMetadataConsistent: false, artifactIntegrityVerified: false, components: mismatched.map((entry) => entry.root)
      }, allReferences, mismatched.map((entry) => entry.reason));
      const unknown = components.filter((entry) => entry.status === 'unknown');
      if (unknown.length) return base('unknown', {
        lockMetadataVerified: false, artifactIntegrityVerified: false
      }, allReferences, [...unknown.map((entry) => entry.reason), ...(incomplete ? ['Scope unobserved: captured lock evidence is incomplete.'] : [])]);
      const missing = components.filter((entry) => entry.status === 'missing');
      if (missing.length) {
        if (incomplete) return base('unknown', {
          declarationsCaptured: true, sameComponentLockCaptured: false, artifactIntegrityVerified: false
        }, allReferences, ['Scope unobserved: incomplete inventory cannot establish lockfile absence.']);
        const finding = absent({ declarationsCaptured: true, sameComponentLockCaptured: false }, allReferences,
          ['Lockfile is missing for declared dependencies', ...missing.map((entry) => entry.reason)]);
        if (finding.classification === 'missing') finding.remedy = { capability: 'repair', action: 'Review and create the component lock through its supported package workflow; assessment does not prepare dependencies.' };
        return finding;
      }
      return base(rule.id === 'RULE-FRONTEND-PACKAGE' ? 'aligned' : 'unknown', {
        lockMetadataConsistent: true, artifactIntegrityVerified: false,
        declarationFiles: components.map((entry) => entry.declaration.path),
        lockFiles: components.flatMap((entry) => entry.locks.map((lock) => lock.path))
      }, allReferences, ['Only captured lock metadata was compared. Downloaded/installed bytes and cryptographic artifact integrity are unobserved.']);
    }
    case 'STD-API-HEALTH':
    case 'STD-API-DOCS': {
      const docs = normalizeRuleId(rule.id) === 'STD-API-DOCS';
      const routes = (docs ? evidence.endpoints?.docsRoutes : evidence.endpoints?.healthRoutes)?.filter((entry) => selected(entry.sourceFile)) ?? [];
      const refs = routes.map((entry) => ({ path: entry.sourceFile, digest: entry.digest, ...(entry.line ? { line: entry.line } : {}) }));
      const htmlSchema = docs && routes.some((route) => route.path.endsWith('.json') && route.isSpaHtml);
      return base(htmlSchema ? 'difference' : 'unknown', {
        declaredRoutes: routes.map((entry) => entry.path), registrationObserved: routes.length > 0,
        runtimeResponseVerified: false, ...(docs ? { schemaIdentityVerified: false, proxyRoutingVerified: false, declaredHtmlSchema: htmlSchema } : { healthStatusVerified: false })
      }, refs, [
        ...(htmlSchema ? ['Captured schema-handler syntax declares an HTML response, not an OpenAPI JSON document.'] : []),
        docs ? 'Static routes and configuration do not prove JSON media type, nonempty schema paths/components, relative redirects or direct/proxy behavior.' :
          'A static route declaration does not prove that the running endpoint returns the required deterministic status.',
        'No HTTP request or project execution occurred; unobserved runtime routes are not reported absent.',
        ...sourceLimitations
      ]);
    }
    case 'STD-TEST-SUITE': {
      const tests = evidence.tests?.testFiles.filter((entry) => selected(entry.path)) ?? [];
      if (!tests.length) return absent({ testDeclarationsCaptured: false, privateExecutionVerified: false });
      return base('unknown', {
        testFileCount: tests.length, testDeclarationsCaptured: evidence.tests?.declaredFiles?.some((entry) => selected(entry.path)) === true,
        privateExecutionVerified: false
      },
        references(tests), ['Test suite declared in files; no fresh matching private execution or passing status was observed.']);
    }
    case 'STD-CONT-COMPOSE': {
      const compose = evidence.containers?.compose;
      if (!compose) return absent({ composeDeclarationCaptured: false });
      if (compose.valid !== true || compose.serviceCount === undefined) return base('unknown', {
        composeDeclarationCaptured: true, composeStructureVerified: false
      }, references([compose]), [compose.issue ?? 'Filename presence is not a parsed orchestration declaration.']);
      return base(compose.serviceCount >= 2 ? 'aligned' : 'difference', {
        composeDeclarationCaptured: true, declaredServices: compose.serviceCount, containerExecutionVerified: false
      }, references([compose]), ['Only the captured multi-service declaration was assessed; containers were not built or run.']);
    }
    case 'STD-FRONTEND-ENTRY': {
      const frontend = evidence.frontend;
      const entries = frontend?.entrypoints.filter((entry) => selected(entry.path)) ?? [];
      const components = frontend?.components.filter((entry) => selected(entry.path)) ?? [];
      if (entries.length && components.length) return base('aligned', {
        vueEntrypointObserved: true, vueRootComponentObserved: true, browserBehaviorVerified: false
      }, references([...entries, ...components]), ['Captured Vue bootstrap/component declarations are not browser or business-behavior proof.']);
      const files = inventory.files.filter((file) => selected(file.path) && /\.(?:vue|[cm]?[jt]sx?)$/u.test(file.path));
      return files.length ? base('unknown', {
        vueEntrypointObserved: entries.length > 0, vueRootComponentObserved: components.length > 0
      }, references(files), ['Supported Vue bootstrap and root-component source associations were not established.', ...sourceLimitations]) :
        absent({ vueEntrypointCaptured: false, vueRootComponentCaptured: false });
    }
    case 'STD-FRONTEND-BUILD': {
      const vite = evidence.frontend?.viteConfigs.filter((entry) => selected(entry.path)) ?? [];
      const tailwind = evidence.frontend?.tailwindConfigs?.filter((entry) => selected(entry.path)) ?? [];
      if (vite.length && tailwind.length) return base('aligned', {
        viteConfigurationObserved: true, tailwindConfigurationObserved: true, buildExecutionVerified: false
      }, references([...vite, ...tailwind]), ['Build configuration declarations are observed; no build was executed.']);
      const buildFiles = inventory.files.filter((file) => selected(file.path) && file.category === 'build');
      return buildFiles.length ? base('unknown', {
        viteConfigurationObserved: vite.length > 0, tailwindConfigurationObserved: tailwind.length > 0
      }, references(buildFiles), ['Both Vite and Tailwind configuration source are required; filenames or one tool alone are insufficient.']) :
        absent({ buildConfigurationCaptured: false });
    }
    case 'STD-FRAMEWORK-OPENSPEC': {
      const markers = [evidence.frameworks?.openspec, evidence.frameworks?.specKit].filter((entry): entry is FileEvidence => entry !== undefined);
      return markers.length ? base('unknown', { markerFilesCaptured: true }, references(markers), ['Marker files do not establish framework initialization or lifecycle completion.']) :
        absent({ markerFilesCaptured: false });
    }
    case 'STD-INFRA-OPENTOFU': {
      const files = evidence.infrastructure?.terraformFiles ?? [];
      return files.length ? base('unknown', { infrastructureFilesCaptured: files.length, infrastructureValidated: false }, references(files),
        ['Captured infrastructure source is not backend-disabled validation, state, deployment or provider readback evidence.']) :
        absent({ infrastructureFilesCaptured: 0 });
    }
    case 'STD-GENAI-MODEL-CONFIG':
    case 'STD-GENAI-PATTERN-CONTRACT':
      return base('unknown', { staticProfileTarget: profile.id, modelExecutionVerified: false, patternBusinessBehaviorVerified: false }, [],
        ['A selected GenAI profile or declared route cannot prove model/provider configuration or the pattern business contract. No model or provider was invoked.']);
    default:
      return base('unknown', { evaluatorAvailable: false }, [], ['No qualified evaluator exists for this declared rule; it remains in the coverage denominator.']);
  }
}

export function evaluateProfileRules(
  profile: StandardsProfileIdentity, target: AssessmentTarget, inventory: AssessmentInventory, evidence: ExtractedEvidence
): AssessmentFinding[] {
  if (profile.status !== 'supported') return [];
  return [...new Set(profile.declaredRuleCoverage)].sort().map((id) => {
    const rule = getRuleDefinition(id) ?? {
      id, title: id, description: 'Declared profile rule without an installed evaluator', severity: 'warning' as const,
      applicableProfiles: [profile.id], applicableScope: 'component' as const, expected: `Satisfy the selected profile's declared ${id} contract.`
    };
    return evaluateRule(rule, profile, target, inventory, evidence);
  });
}
