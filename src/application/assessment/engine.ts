import path from 'node:path';
import { TextDecoder } from 'node:util';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { modernActivationSourceContracts } from '../../domain/governance/policy/identity.js';
import type {
  ProjectAssessmentCategory, ProjectAssessmentFinding, ProjectAssessmentObservation,
  ProjectAssessmentProfile, ProjectAssessmentReport, ProjectAssessmentTarget, ProjectRemediationCategory
} from '../../domain/assessment/report.js';
import { assembleProjectAssessmentReport, projectAssessmentFinding } from '../../domain/assessment/report.js';
import { liftoffVersion } from '../../version.js';
import {
  ApplicationFiles, ApplicationInspectionError, ApplicationInventoryLimitError, applicationDigest, applicationPathFold,
  assertApplicationNoLinkAncestors, canonicalApplicationRoot
} from '../repair/application-files.js';
import { parseProjectManifest } from '../project/manifest.js';
import { buildModernManagedCore } from '../project/modern-managed-core.js';
import { modernSourceRegistry } from '../project/modern-plugins.js';
import {
  findModernActiveArtifactBinding, findModernActiveComponentBinding,
  resolveModernComparisonContext, resolveModernManifestSourceContext
} from '../project/source-context.js';
import { inspectProjectInventory } from './inventory.js';
import { projectInventoryBounds } from './inventory-types.js';

export function projectAssessmentProfile(value: unknown): ProjectAssessmentProfile {
  if (value === 'none' || value === 'single-maintainer-gitflow' || value === 'team-gitflow') return value;
  throw new ApplicationInspectionError('Assessment --governance requires none, single-maintainer-gitflow or team-gitflow. It is a comparison target, not a profile change.');
}

async function boundary(start: string, explicit: boolean) {
  await assertApplicationNoLinkAncestors(path.resolve(start), 'Project inventory root');
  let root = await canonicalApplicationRoot(start);
  const readers: ApplicationFiles[] = [];
  while (true) {
    const reader = new ApplicationFiles(root);
    const directory = await reader.inventory([], projectInventoryBounds.directoryEntries);
    readers.push(reader);
    const markers = ['liftoff.manifest.json', '.git'].map(name => {
      const entry = directory.entries.find(item => applicationPathFold(item.name) === name);
      if (entry && (entry.name !== name || entry.kind !== 'file' && (name !== '.git' || entry.kind !== 'directory'))) {
        throw new ApplicationInspectionError('Assessment encountered an unsafe or aliased project boundary; no outer project was selected.');
      }
      return entry;
    });
    if (markers[0] || markers[1] || explicit) return {
      root, revalidate: async () => { for (const observed of readers) await observed.assertUnchanged(); }
    };
    const parent = path.dirname(root);
    if (parent === root) throw new ApplicationInspectionError('No Liftoff or Git boundary was found. Select an explicit project directory to assess a non-Git application.');
    root = parent;
  }
}

const unknown: ProjectAssessmentObservation = { availability: 'not-observed', value: null, source: null };
const within = (parent: readonly string[], child: readonly string[]) =>
  parent.length <= child.length && parent.every((part, index) => part === child[index]);

export async function assessProject(input: {
  start: string;
  explicitRoot: boolean;
  governance?: ProjectAssessmentProfile;
  live?: boolean;
}): Promise<ProjectAssessmentReport> {
  if (input.governance !== undefined) projectAssessmentProfile(input.governance);
  if (input.live) throw new ApplicationInspectionError('The local assessment engine does not collect live metadata. Use the scoped live coordinator; no network or credential access occurred.');
  const selected = await boundary(input.start, input.explicitRoot);
  const root = selected.root;
  const inventory = await inspectProjectInventory(root);
  const permitted = new Set(['liftoff.manifest.json']);
  const files = new ApplicationFiles(root, parts => {
    const key = parts.join('/');
    return [...permitted].some(allowed => allowed === key || allowed.startsWith(`${key}/`))
      ? null : 'not-an-exact-assessment-input';
  });
  const original = await files.read(['liftoff.manifest.json']);
  if (inventory.rootMarkers.liftoff === 'file-marker' && !original.content ||
      inventory.rootMarkers.liftoff === 'absent' && original.content) {
    throw new ApplicationInspectionError('Project manifest membership changed during assessment.');
  }
  let raw: unknown;
  if (original.content) {
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(original.content)); }
    catch { throw new ApplicationInspectionError('Project manifest is not valid UTF-8 JSON; no outer project was selected.'); }
  }
  const manifest = original.content ? parseProjectManifest(raw) : null;
  const source = manifest?.artifactVersion === 8 ? resolveModernManifestSourceContext(manifest) : null;
  const recordedProfile = manifest?.governance.profile ?? null;
  const selectedProfile = input.governance ?? (recordedProfile === 'none' || recordedProfile === 'single-maintainer-gitflow' ||
    recordedProfile === 'team-gitflow' ? recordedProfile : 'single-maintainer-gitflow');
  const targetContext = source ? resolveModernComparisonContext(source, selectedProfile) : null;
  const registry = modernSourceRegistry();
  const policySource = selectedProfile === 'none' ? null
    : modernActivationSourceContracts().find(contract => contract.identity.profile === selectedProfile);
  if (selectedProfile !== 'none' && !policySource) throw new Error('The installed comparison policy is unavailable.');
  const target: ProjectAssessmentTarget = {
    cliVersion: liftoffVersion, manifestVersion: 8, profile: selectedProfile,
    profileSelection: input.governance !== undefined ? 'explicit' : recordedProfile && recordedProfile !== 'unspecified' ? 'recorded' : 'default',
    policy: policySource ? { version: policySource.identity.policyVersion, digest: policySource.identity.policyDigest } : null,
    pluginCatalog: {
      apiVersion: registry.apiVersion, registryDigest: registry.registryDigest, pluginSetDigest: registry.pluginSetDigest
    },
    selectedPlugins: targetContext ? {
      resolutionDigest: targetContext.plugins.resolutionDigest, ids: targetContext.plugins.selections.map(plugin => plugin.id)
    } : null,
    layoutDescriptorDigest: targetContext ? canonicalSha256(targetContext.source.layoutDescriptor) : null
  };
  const findings: ProjectAssessmentFinding[] = [];
  const diagnostics: ProjectAssessmentReport['diagnostics'] = inventory.complete ? [] : [{
    code: 'incomplete-static-inventory', severity: 'warning',
    message: 'Static metadata or declarations exceeded supported bounds or could not be interpreted; unobserved scopes are not passes.'
  }];
  const metadataSource = {
    kind: 'file' as const, pathParts: ['liftoff.manifest.json'], digest: original.content ? applicationDigest(original.content) : inventory.inspectionDigest
  };
  const inventorySource = (parts: readonly string[] | null): ProjectAssessmentObservation['source'] => ({
    kind: 'inventory', pathParts: parts ? [...parts] : null, digest: inventory.inspectionDigest
  });
  const remediation = (category: ProjectRemediationCategory): ProjectAssessmentFinding['remediation'] => {
    const supported = category === 'managed-update' && manifest !== null ||
      category === 'application-repair' && source !== null && source.selection.profile !== 'team-gitflow' ||
      category === 'adoption' && manifest === null && selectedProfile !== 'team-gitflow';
    const command = category === 'managed-update' ? 'update'
      : category === 'application-repair' ? 'repair'
        : category === 'adoption' ? 'adopt' : null;
    return {
      category, available: supported, separateConsent: true,
      previewCommand: supported && command
        ? [
            'liftoff', command, '--project', root, '--check',
            ...(category === 'adoption' ? ['--governance', selectedProfile] : [])
          ]
        : null
    };
  };
  const add = (
    id: string, category: ProjectAssessmentCategory, title: string,
    expected: ProjectAssessmentFinding['expected'], observed: ProjectAssessmentObservation, reason: string,
    lane: ProjectRemediationCategory = 'application-repair',
    options: Partial<Pick<ProjectAssessmentFinding, 'applicability' | 'supported' | 'pathParts'>> &
      { difference?: 'outdated' | 'conflicting' } = {}
  ) => findings.push(projectAssessmentFinding({
    id, category, title, expected, observed, reason, remediation: remediation(lane),
    applicability: 'applicable', supported: true, pathParts: null, ...options
  }));
  const canObserve = (parts: readonly string[]) => parts.length <= projectInventoryBounds.depth &&
    Buffer.byteLength(parts.join('/')) <= projectInventoryBounds.pathBytes &&
    !inventory.exclusions.some(exclusion => within(exclusion.pathParts, parts));
  const presence = (parts: readonly string[]): ProjectAssessmentObservation => {
    if (!canObserve(parts)) return { ...unknown };
    const entry = inventory.entries.find(candidate => candidate.pathParts.join('/') === parts.join('/'));
    return entry ? { availability: 'observed', value: entry.kind, source: inventorySource(parts) }
      : inventory.complete ? { availability: 'missing', value: null, source: inventorySource(parts) } : { ...unknown };
  };
  add('project.manifest', 'metadata', 'Current project metadata', 8, {
    availability: manifest ? 'observed' : 'missing', value: manifest?.artifactVersion ?? null,
    source: original.content ? metadataSource : inventorySource(['liftoff.manifest.json'])
  }, manifest ? 'Recorded metadata is validated without changing its original provenance.'
    : 'No Liftoff manifest exists at the selected boundary; application facts are not adoption or generation history.',
  manifest ? 'managed-update' : 'adoption', { difference: 'outdated', pathParts: ['liftoff.manifest.json'] });
  add('project.profile', 'governance', 'Advisory governance comparison profile', selectedProfile, manifest
    ? { availability: 'observed', value: recordedProfile, source: metadataSource } : { ...unknown },
  'An explicit comparison profile never changes recorded selection, permissions or policy.',
  'workflow-profile-migration', { applicability: manifest ? 'applicable' : 'unknown' });
  add('inventory.coverage', 'layout', 'Bounded static inventory coverage', true, {
    availability: 'observed', value: inventory.complete, source: inventorySource(null)
  }, 'Inventory completeness covers bounded metadata and supported declaration names, not application conformance.');
  for (const dependency of inventory.dependencies) {
    add(`dependency.${dependency.pathParts.join('/')}`, 'dependencies', 'Static dependency declaration names', 'interpretable', {
      availability: dependency.availability === 'observed' ? 'observed' : 'not-observed',
      value: dependency.availability === 'observed' ? 'interpretable' : null,
      facts: { dialect: dependency.dialect, names: [...dependency.names] },
      source: dependency.digest ? { kind: 'file', pathParts: [...dependency.pathParts], digest: dependency.digest } : null
    }, dependency.availability === 'observed'
      ? `Static ${dependency.dialect} names were extracted. Versions, installation, lifecycle scripts and semantic compatibility were not evaluated.`
      : 'The declaration was not safely interpreted; no dependency absence or compatibility was inferred.',
    'application-repair', { pathParts: [...dependency.pathParts] });
  }
  add('dependencies.compatibility', 'dependencies', 'Selected dependency compatibility', 'verified-compatible-declarations', { ...unknown },
    'Extracted names and lock presence are not compatible versions, installed dependencies or verified project checks.', 'application-repair', { supported: false });
  add('runtime.declarations', 'runtime', 'Supported declared runtime constraints', 'compatible-runtime-constraints', { ...unknown },
    'Runtime declarations, installed interpreters and executable behavior are not evaluated by static name extraction.', 'application-repair', { supported: false });
  for (const [id, role, category] of [
    ['ci.configuration', 'ci', 'governance'],
    ['infrastructure.configuration', 'infrastructure', 'infrastructure'],
    ['documentation.contents', 'documentation', 'documentation']
  ] as const) {
    add(id, category, `Observed ${role} metadata and unverified content`, 'verified-selected-standard', {
      availability: 'observed', source: inventorySource(null),
      value: inventory.entries.filter(entry => entry.roles.includes(role)).map(entry => ({
        pathParts: [...entry.pathParts], kind: entry.kind
      }))
    }, 'These are bounded metadata observations only. Payloads, effective policy, resource ownership and semantic references are unobserved.',
    category === 'infrastructure' ? 'existing-deployment-planning' : 'application-repair', { supported: false });
  }
  if (source && targetContext) {
    add('plugins.selection', 'managed-core', 'Installed selected plugin identities', targetContext.plugins.resolutionDigest, {
      availability: 'observed', value: source.plugins.resolutionDigest, source: metadataSource
    }, 'An exact readable historical plugin family remains recorded. Selecting installed plugins is comparison, not a plugin migration.',
    'workflow-profile-migration', { difference: 'outdated' });
    for (const component of source.source.layoutDescriptor.components) {
      const binding = findModernActiveComponentBinding(source, component);
      add(`layout.component.${component}`, 'layout', `Explicit ${component} component location`, 'directory',
        binding ? presence(binding.pathParts) : { ...unknown },
        binding ? 'Only the explicitly bound path is assessed. Presence does not prove references, runtime behavior or ownership.'
          : 'No explicit active binding is available; original generation paths and canonical folders are not fallback authority.',
        'application-repair', { pathParts: binding ? [...binding.pathParts] : null });
    }
    const workflow = source.selection.project.specWorkflow;
    const marker = workflow === 'openspec' ? ['openspec'] : workflow === 'spec-kit' ? ['.specify'] : null;
    add('workflow.marker', 'workflow', 'Selected external workflow marker', 'directory',
      marker ? presence(marker) : { ...unknown },
      marker ? 'A marker is metadata only, not initialization, archive, executable readiness or completion proof.'
        : 'Manual requires no external framework marker; preserved unselected framework content is not removed.',
      'workflow-profile-migration', { applicability: marker ? 'applicable' : 'inapplicable', pathParts: marker });
    const pluginChange = source.plugins.resolutionDigest !== targetContext.plugins.resolutionDigest;
    for (const artifact of buildModernManagedCore({
      selection: targetContext.selection, plugins: targetContext.plugins, activeLayout: targetContext.activeLayout
    })) {
      const parts = [...artifact.pathParts];
      const expected = applicationDigest(artifact.content);
      let observed: ProjectAssessmentObservation = { ...unknown };
      if (!inventory.exclusions.some(exclusion => within(exclusion.pathParts, parts) &&
          (exclusion.reason !== 'state-or-credential' || parts[0] !== '.liftoff'))) {
        permitted.add(parts.join('/'));
        try {
          const snapshot = await files.read(parts);
          observed = {
            availability: snapshot.content === undefined ? 'missing' : 'observed',
            value: snapshot.content === undefined ? null : applicationDigest(snapshot.content),
            source: snapshot.content === undefined ? inventorySource(parts)
              : { kind: 'file', pathParts: parts, digest: applicationDigest(snapshot.content) }
          };
        } catch (error) {
          if (!(error instanceof ApplicationInventoryLimitError)) throw error;
          files.snapshots.delete(parts.join('/'));
          diagnostics.push({
            code: `managed-content-bound:${artifact.logicalName}`, severity: 'warning',
            message: 'The exact managed content exceeded a bounded read scope; no absence or matching bytes were inferred.'
          });
        }
      }
      add(`managed.${artifact.logicalName}`, 'managed-core', `Expected managed bytes: ${artifact.logicalName}`,
        expected, observed, 'Expected bytes come from the single installed managed renderer and explicit comparison context; hashes are not write approval.',
        pluginChange || selectedProfile !== recordedProfile ? 'workflow-profile-migration' : 'managed-update',
        { pathParts: parts, ...(pluginChange ? { difference: 'outdated' } : {}) });
    }
    const readme = source.source.layoutDescriptor.artifacts.some(artifact => artifact.logicalName === 'root-readme')
      ? findModernActiveArtifactBinding(source, 'root-readme') : undefined;
    add('documentation.readme', 'documentation', 'Explicit project README location', 'file',
      readme ? presence(readme.pathParts) : { ...unknown },
      'Documentation payloads are not read. An unbound or excluded location stays unobserved; no canonical move is recommended.',
      'application-repair', { pathParts: readme ? [...readme.pathParts] : null });
  } else {
    for (const category of ['layout', 'managed-core', 'workflow', 'agents', 'documentation'] as const) {
      add(`${category}.selection`, category, `Explicit ${category} comparison context`, 'validated-current-selection', { ...unknown },
        'A bounded inventory is not a workload, workflow, plugin or active-binding selection. Historical generation paths are not current location authority.',
        manifest ? 'managed-update' : 'adoption', { supported: false });
    }
  }
  add('agents.behavior', 'agents', 'Selected coding-agent integration behavior', 'verified-selected-integrations', { ...unknown },
    'Managed integration byte comparisons do not execute agent hosts, select models or establish semantic application correctness.',
    'workflow-profile-migration', {
      applicability: source && source.selection.project.agents.length === 0 ? 'inapplicable' : source ? 'applicable' : 'unknown',
      supported: false
    });
  add('references.compatibility', 'references', 'Application and configuration reference compatibility', 'verified-equivalent-references', { ...unknown },
    'Imports, build/test scripts, Docker/Compose, CI and dynamic references are not evaluated. Compatible bindings do not independently prove these references.', 'application-repair', { supported: false });
  add('governance.proof', 'governance', 'Current governance and live enforcement proof', 'current-profile-bound-proof', { ...unknown },
    'Recorded profile and matching managed bytes are not independent approval, current activation evidence, effective GitHub policy or live provider proof.',
    'new-environment-activation', { applicability: selectedProfile === 'none' ? 'inapplicable' : 'applicable', supported: false });
  add('infrastructure.deployment', 'infrastructure', 'Existing deployment and protected state boundaries', 'scoped-deployment-observations', { ...unknown },
    'State and credentials are not read. Missing local state is not cloud absence; pre-existing deployment adoption/import/mutation remains planning-only.',
    'existing-deployment-planning', { supported: false });
  await files.assertUnchanged();
  const checked = await inspectProjectInventory(root);
  if (checked.inspectionDigest !== inventory.inspectionDigest) throw new ApplicationInspectionError('Bounded project inputs changed during assessment; rerun without accepting this report as current proof.');
  await files.assertUnchanged();
  await selected.revalidate();
  const metadataDigest = canonicalSha256([...files.snapshots.values()].map(snapshot => ({
    pathParts: snapshot.pathParts, digest: snapshot.content === undefined ? null : applicationDigest(snapshot.content),
    mode: snapshot.mode ?? null
  })).sort((a, b) => a.pathParts.join('/') < b.pathParts.join('/') ? -1 : 1));
  return assembleProjectAssessmentReport({
    mode: 'local',
    project: {
      root, kind: manifest ? 'liftoff' : inventory.rootMarkers.git === 'absent' ? 'non-git' : 'git',
      manifestVersion: manifest?.artifactVersion ?? null, recordedProfile
    },
    target, snapshot: { inventoryDigest: inventory.inspectionDigest, metadataDigest, inputsStable: true },
    findings, diagnostics,
    limitations: [...inventory.limitations,
      'Two bounded inventory passes and exact metadata/managed-file revalidation detect observed input drift. Excluded scopes and unread payload changes remain unobserved.',
      'No runtime, reference, effective-policy, live-provider, installed-agent or deployment-state conformance is inferred. Unsupported controls remain visible.',
      'Assessment, target choice and recommendations are read-only advisory data, not approval, enrollment, receipts, ownership, activation evidence or executable migration authority.'
    ]
  });
}
