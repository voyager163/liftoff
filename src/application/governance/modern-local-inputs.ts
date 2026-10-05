import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parse as parseToml } from 'smol-toml';
import { assertBoundProjectPath, readBoundProjectFileSnapshot } from '../../adapters/filesystem/bound-project-files.js';
import { inspectReviewedUpdateTransaction } from '../../adapters/filesystem/reviewed-update-transaction.js';
import { parseIsolatedHcl, hclComputationPolicy, IsolatedHclError, type HclExpression, type IsolatedHclResult } from '../../adapters/hcl/isolated-parser.js';
import { errorCode } from '../../adapters/filesystem/errors.js';
import { ApplicationFiles, ApplicationInspectionError, applicationWithin, canonicalApplicationRoot } from '../repair/application-files.js';
import { projectCatalog } from '../project/catalog.js';
import { parseManifest, resolveModernManifestV8SourceContract } from '../project/manifest.js';
import { buildModernManagedCore } from '../project/modern-managed-core.js';
import {
  findModernActiveComponentBinding, modernProjectSourceInput, resolveModernManifestSourceContext
} from '../project/source-context.js';
import { createManifestV8Reader, type LiftoffManifestV8 } from '../../domain/project/manifest/v8.js';
import { manifestActiveLayoutDigest } from '../../domain/project/manifest/layout.js';
import { exactRecord, isRecord } from '../../domain/project/manifest/fields.js';
import { toSafeProjectName } from '../../domain/project/planning.js';
import type { ManifestLayoutBinding, ManifestLayoutComponentId } from '../../domain/project/contracts.js';
import { reviewedRepairTransactionPathParts, reviewedUpdateTransactionPathParts } from '../../domain/project/reviewed-update-artifacts.js';
import { canonicalJson, canonicalSha256, sha256Hex } from '../../domain/governance/activation/canonical-json.js';
import { normalizedSeedInput } from '../../domain/governance/activation/inputs.js';
import {
  assembleModernLocalPlan, capturedFileBytes, copyModernLocalData, localInputFailure, localPath, modernLocalBounds,
  ModernLocalInputError, rawLocalDigest, validateModernLocalSnapshot, type ModernLocalCheck, type ModernLocalContext,
  type ModernLocalFile, type ModernLocalInspection, type ModernLocalPhysical, type ModernLocalSnapshot,
  type ModernLocalVerificationPlan
} from '../../domain/governance/activation/modern-local-inputs.js';
import {
  appendSpecKitDefaultIssues, appendSpecKitDocumentIssues, appendSpecKitSelectedIssues, appendSpecKitTaskIssues,
  extractDeclaredCapabilities, isOpenSpecCodexTarget, isSpecKitInstalledList, isSpecKitIntegrationRecord,
  archivedOpenSpecMatchesMain, mainSpecPurpose, nodeBackendCommand, goBackendCommand, pythonBackendCommand, workerTestCommand,
  frontendBuildCommand, tofuFormatCommand, tofuValidateCommand, specKitBootstrapId, specKitBootstrapPath
} from '../../domain/governance/activation/local-check-values.js';
import { frameworkOutputPaths, OPEN_SPEC_CODEX_TARGET_PATH } from '../../framework-validation.js';
import { readModernActivationSuccessorSource } from '../../governance-activation/migration-history.js';
import { inspectModernInstalledActivation, validateCapturedModernInstalledActivation } from './modern-installed-preflight.js';
import type { InstalledLocalPreflight, ModernLocalRuntimeInspection, ModernLocalRuntimePlan } from '../../domain/governance/activation/modern-local-runtime.js';
import {captureCompleteOpenSpecInputs,captureArchivedOpenSpecInputs} from './modern-openspec-inputs.js';
import { modernLocalInputExclusion as exclusion } from '../../domain/governance/activation/modern-local-exclusions.js';
import { inspectModernComposeInputs } from './modern-compose.js';
import { modernComposeInputPolicy, type ModernComposeInputs } from '../../domain/governance/activation/modern-compose.js';
import { explicitTofuFormatCommand, explicitTofuFormatPolicy } from '../../domain/governance/activation/modern-tofu-format.js';
import { deriveManualInfrastructureInputs } from './modern-manual-infrastructure.js';
import { manualInfrastructurePolicy, type ManualInfrastructureInputs } from '../../domain/governance/activation/modern-manual-infrastructure.js';

const rootReader = createManifestV8Reader({ catalog: projectCatalog, resolveSourceContract: resolveModernManifestV8SourceContract });
const key = (parts: readonly string[]) => parts.join('/');
const under = (parent: string, child: string) => child === parent || child.startsWith(`${parent}/`);
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const journalPaths = [reviewedUpdateTransactionPathParts, reviewedRepairTransactionPathParts];
const installedBoundaryPaths = [['governance', 'activation-state.json'], ['governance', 'migration-state.json']] as const;
function safeFailure(error: unknown): string {
  return error instanceof ModernLocalInputError || error instanceof ApplicationInspectionError ||
    error instanceof IsolatedHclError ? error.message : 'Local input inspection could not safely validate the complete selected scope.';
}
function jsonContent(text: string, label: string): unknown {
  try { return JSON.parse(text); }
  catch { return localInputFailure(`${label}: invalid JSON; source values were omitted.`); }
}
function text(bytes: Buffer, label: string): string {
  const decoded = bytes.toString('utf8');
  if (!Buffer.from(decoded).equals(bytes) || decoded.includes('\0')) localInputFailure(`${label}: a canonical UTF-8 text input is required.`);
  return decoded;
}
function selectedSource(manifest: LiftoffManifestV8) {
  return resolveModernManifestSourceContext(manifest).source;
}
function verifyManagedInputs(manifest: LiftoffManifestV8, files: ReadonlyMap<string, ModernLocalFile>): void {
  const core = buildModernManagedCore(modernProjectSourceInput(manifest));
  for (const artifact of core) {
    const entry = manifest.managedArtifacts.find(file => file.logicalName === artifact.logicalName);
    const observed = files.get(key(artifact.pathParts));
    if (!entry || !observed || observed.digest === null || entry.contentHash !== `sha256:${observed.digest}` ||
        !capturedFileBytes(observed)?.equals(Buffer.from(artifact.content))) {
      localInputFailure('Actual applicable managed bytes do not match the complete G1 source and manifest.');
    }
  }
}
function fileRecord(parts: readonly string[], scope: ModernLocalFile['scope'], content?: Buffer, mode?: number): ModernLocalFile {
  return { pathParts: [...parts], scope, content: content === undefined ? null : content.toString('base64'),
    mode: content === undefined ? null : mode ?? localInputFailure('Observed file mode is missing.'),
    bytes: content?.length ?? 0, digest: content === undefined ? null : rawLocalDigest(content) };
}
async function physical(absolute: string, ancestor = false): Promise<ModernLocalPhysical> {
  try {
    const stat = await lstat(absolute, { bigint: true });
    if (stat.isSymbolicLink()) localInputFailure('Local input physical binding encountered a link.');
    return { path: absolute, identity: [
      stat.dev, stat.ino, stat.mode, ancestor ? 0 : stat.nlink, ancestor ? 0 : stat.size,
      ancestor ? 0 : stat.mtimeNs, ancestor ? 0 : stat.ctimeNs, stat.birthtimeNs
    ].join(':') };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { path: absolute, identity: null };
    throw error;
  }
}

function bootstrapName(manifest: LiftoffManifestV8): string {
  return manifest.project.specWorkflow === 'spec-kit' ? specKitBootstrapId : `bootstrap-${toSafeProjectName(manifest.project.name)}`;
}
function capabilityName(manifest: LiftoffManifestV8): string {
  const workload = manifest.project.workload;
  return `${workload.kind === 'genai' ? workload.pattern : workload.apiStack}-application-baseline`;
}

/** Reads selected inputs only. It neither probes tools nor grants execution or storage authority. */
export async function inspectModernLocalVerification(root: string): Promise<ModernLocalInspection> {
  return inspectLocalInputs(root);
}

async function inspectLocalInputs(
  root: string, installed?: Extract<InstalledLocalPreflight, { status: 'observed' }>, openSpecReadSet:'active'|'archived'|false=false
): Promise<ModernLocalInspection> {
  if (typeof root !== 'string' || !root || root.length > 4096 || /[\u0000-\u001f]/u.test(root)) {
    localInputFailure('Local verification requires a bounded project root string.');
  }
  const requestedRoot = root;
  try {
    const canonical = await canonicalApplicationRoot(requestedRoot);
    const rootParents: ModernLocalPhysical[] = [];
    for (let current = canonical;; current = path.dirname(current)) {
      rootParents.push(await physical(current, current !== canonical));
      if (path.dirname(current) === current) break;
    }
    const controls: ModernLocalFile[] = [];
    const controlPhysical: ModernLocalPhysical[] = [];
    let controlBytes = 0;
    async function control(parts: readonly string[]): Promise<Buffer | undefined> {
      if (controls.length >= modernLocalBounds.controlFiles || controlBytes >= modernLocalBounds.controlBytes) {
        localInputFailure('Local control inventory exceeds its aggregate file/byte bound.');
      }
      const absolute = path.join(canonical, ...parts), before = await physical(absolute);
      const parents: ModernLocalPhysical[] = [];
      for (let index = 1; index < parts.length; index += 1) parents.push(await physical(path.join(canonical, ...parts.slice(0, index))));
      const observed = await readBoundProjectFileSnapshot(canonical, parts, {
        maximumBytes: Math.min(modernLocalBounds.controlFileBytes, modernLocalBounds.controlBytes - controlBytes), linkPolicy: 'single-link',
        diagnostics: { pathLabel: 'Local control input', invalid: localInputFailure }
      });
      if (canonicalJson(before) !== canonicalJson(await physical(absolute))) localInputFailure('Local control input changed while being read.');
      for (const parent of parents) {
        if (canonicalJson(parent) !== canonicalJson(await physical(parent.path))) localInputFailure('Local control parent changed while being read.');
      }
      controls.push(fileRecord(parts, 'control', observed.content, observed.mode));
      controlBytes += observed.content?.length ?? 0;
      controlPhysical.push(before);
      controlPhysical.push(...parents);
      return observed.content;
    }
    const manifestBytes = await control(['liftoff.manifest.json']);
    if (!manifestBytes) localInputFailure('The selected root has no manifest.');
    const raw = jsonContent(text(manifestBytes, 'Manifest'), 'Manifest');
    if (!isRecord(raw)) localInputFailure('Manifest must be a JSON object.');
    if (raw.artifactVersion !== 8) {
      if (!Number.isInteger(raw.artifactVersion) || Number(raw.artifactVersion) < 2 || Number(raw.artifactVersion) > 7) {
        localInputFailure('Unknown manifest source; no legacy fallback is permitted.');
      }
      const state = await control(['governance', 'activation-state.json']);
      let sourceDigest = rawLocalDigest(manifestBytes);
      if (state !== undefined) sourceDigest = (await readModernActivationSuccessorSource(canonical)).sourceBinding;
      else {
        const released = parseManifest(raw);
        if (released.governance.profile !== 'none') localInputFailure('Released activation source has no original state to validate.');
      }
      return { status: 'released-source', root: canonical, manifestVersion: Number(raw.artifactVersion), sourceDigest };
    }
    const manifest = rootReader.parseManifestV8(raw), source = selectedSource(manifest);
    if (installed && (installed.snapshot.root !== canonical ||
        installed.snapshot.files.find(file => key(file.pathParts) === 'liftoff.manifest.json')?.digest !== rawLocalDigest(manifestBytes))) {
      localInputFailure('Installed preflight does not match the actual manifest and root.');
    }
    for (const transactionKind of ['update', 'repair'] as const) {
      const transaction = await inspectReviewedUpdateTransaction(canonical, { transactionKind });
      if (transaction.status !== 'absent') localInputFailure(`A ${transactionKind} transaction is not absent; recovery and unfinished cleanup must be resolved separately.`);
    }
    for (const parts of journalPaths) if (await control(parts) !== undefined) localInputFailure('Transaction status changed during local inspection.');
    for (const parts of installedBoundaryPaths) {
      if (installed) {
        const observed = await control(parts), expected = installed.snapshot.files.find(file => key(file.pathParts) === key(parts));
        if (!expected || (observed === undefined ? expected.content !== null : expected.digest !== rawLocalDigest(observed))) {
          localInputFailure('Installed activation controls changed before local input capture.');
        }
        continue;
      }
      await assertBoundProjectPath(canonical, parts, { pathLabel: 'Installed activation boundary', invalid: localInputFailure });
      const observation = await physical(path.join(canonical, ...parts));
      if (observation.identity !== null) localInputFailure('Installed activation/history boundaries require the separately gated MR2 protected-input preflight; their payloads are not read by MR1.');
      controls.push(fileRecord(parts, 'control'));
      controlPhysical.push(observation, await physical(path.join(canonical, parts[0])));
    }
    if (manifest.sourceManifestHistory && !installed) {
      localInputFailure('A preserved-history successor requires its separate installed-history/protected-retention preflight before local input observation.');
    }
    for (const artifact of source.managedArtifacts) await control(artifact.pathParts);
    const componentRoots = manifest.activeLayout.bindings.filter(binding => binding.kind === 'component').map(binding => key(binding.pathParts));
    const protectedPaths = installed?.retention.flatMap(obligation => obligation.protectedPaths) ?? [];
    for (const binding of manifest.activeLayout.bindings) {
      const selected = key(binding.pathParts).toLowerCase();
      if (protectedPaths.some(parts => under(selected, key(parts).toLowerCase()) || under(key(parts).toLowerCase(), selected))) {
        localInputFailure('Selected local input overlaps a preserved state/key retention boundary; payloads are not read.');
      }
    }
    const files = new ApplicationFiles(canonical, parts => {
      const basename = parts.at(-1)?.toLowerCase();
      if (componentRoots.some(component => under(component, key(parts)) && key(parts) !== component) &&
          ['liftoff.manifest.json', '.liftoff', '.git'].includes(basename ?? '')) {
        localInputFailure('A selected component contains a nested project or repository boundary.');
      }
      return exclusion(parts);
    });
    for (const binding of manifest.activeLayout.bindings) {
      if (binding.kind === 'component') await files.walk([...binding.pathParts]);
      else await files.read(binding.pathParts);
    }
    if (manifest.project.specWorkflow !== 'manual' && manifest.framework.state === 'initialized') {
      const workflow = manifest.project.specWorkflow;
      for (const parts of frameworkOutputPaths({
        workflow, agents: [...manifest.project.agents],
        ...(manifest.project.defaultAgent ? { defaultAgent: manifest.project.defaultAgent } : {})
      })) await files.read(parts);
      if (workflow === 'spec-kit') {
        for (const name of ['spec', 'plan', 'tasks']) await files.read([...specKitBootstrapPath, `${name}.md`]);
      } else {
        if(openSpecReadSet)await (openSpecReadSet==='archived'?captureArchivedOpenSpecInputs:captureCompleteOpenSpecInputs)(files);
        const name = bootstrapName(manifest), capability = capabilityName(manifest);
        const changes = await files.inventory(['openspec', 'changes']);
        const archives = await files.inventory(['openspec', 'changes', 'archive']);
        const active = changes.entries.filter(entry => entry.name.startsWith('bootstrap-'));
        const archived = archives.entries.filter(entry => entry.name === name || entry.name.endsWith(`-${name}`));
        for (const entry of [...active, ...archived]) if (entry.kind !== 'directory') localInputFailure('A bootstrap source is not a regular directory.');
        const selected = active.length === 1 && active[0].name === name && archived.length === 0
          ? ['openspec', 'changes', name] : active.length === 0 && archived.length === 1
            ? ['openspec', 'changes', 'archive', archived[0].name] : undefined;
        if (selected) {
          for (const parts of [['.openspec.yaml'], ['proposal.md'], ['design.md'], ['tasks.md'], ['specs', capability, 'spec.md']]) {
            await files.read([...selected, ...parts]);
          }
        }
        await files.read(['openspec', 'specs', capability, 'spec.md']);
        if (manifest.project.agents.some(agent => agent === 'codex')) await files.read(OPEN_SPEC_CODEX_TARGET_PATH);
      }
    }
    const physicalInputs = new Map(rootParents.map(entry => [entry.path, entry]));
    for (const entry of controlPhysical) physicalInputs.set(entry.path, entry);
    for (const parts of [
      ...files.directoryInventory.map(directory => directory.pathParts),
      ...[...files.snapshots.values()].map(file => file.pathParts)
    ]) {
      const absolute = path.join(canonical, ...parts);
      if (!physicalInputs.has(absolute)) physicalInputs.set(absolute, await physical(absolute));
    }
    await files.assertUnchanged();
    for (const before of physicalInputs.values()) {
      if (canonicalJson(before) !== canonicalJson(await physical(before.path, !applicationWithin(canonical, before.path)))) localInputFailure('Local root, parent or input identity changed during inspection.');
    }
    if (await realpath(canonical) !== canonical) localInputFailure('Local root changed during inspection.');
    const snapshot: ModernLocalSnapshot = {
      kind: 'liftoff-modern-local-inputs', schemaVersion: 3, root: canonical,
      files: [...controls, ...[...files.snapshots.values()].map(file => fileRecord(file.pathParts, 'application', file.content, file.mode))]
        .sort((a, b) => compare(key(a.pathParts), key(b.pathParts))),
      directories: files.directoryInventory.slice().sort((a, b) => compare(key(a.pathParts), key(b.pathParts))),
      exclusions: files.exclusions.slice().sort((a, b) => compare(key(a.pathParts), key(b.pathParts))),
      physical: [...physicalInputs.values()].sort((a, b) => compare(a.path, b.path))
    };
    validateModernLocalSnapshot(snapshot);
    verifyManagedInputs(manifest, new Map(snapshot.files.map(file => [key(file.pathParts), file])));
    return { status: 'modern-observed', snapshot };
  } catch (error) {
    return { status: 'blocked', blockers: [safeFailure(error)] };
  }
}

interface ManualNativeDetails {
  composeInputs?: ModernComposeInputs;
  infrastructure?: ManualInfrastructureInputs;
}
interface Derivation {
  readonly manifest: LiftoffManifestV8;
  readonly snapshot: ModernLocalSnapshot;
  readonly files: ReadonlyMap<string, ModernLocalFile>;
  readonly roots: readonly string[];
  readonly normalized: Map<string, { path: string; content: string }>;
  readonly omitFromBaseline: Set<string>;
  readonly checkedTypeScriptConfigs: Set<string>;
  readonly providerFreeInitialization:boolean;
  readonly closedManualInputs: boolean;
  composeInputs?: ModernComposeInputs;
  manualInfrastructure?: ManualInfrastructureInputs;
  references: number;
  tokens: number;
}
function requiredText(data: Derivation, parts: readonly string[]): string {
  const file = data.files.get(key(parts));
  if (!file) return localInputFailure(`${key(parts)}: required input was not captured.`);
  const bytes = capturedFileBytes(file);
  if (!bytes) return localInputFailure(`${key(parts)}: required input is missing.`);
  return text(bytes, key(parts));
}
function reference(data: Derivation, from: readonly string[], value: unknown, directory = false,
  scope?: { rootBuildContext?: boolean; artifacts?: ReadonlySet<string> }): string {
  if (++data.references > modernLocalBounds.references) localInputFailure('Local configuration exceeds the reference count bound.');
  if (typeof value !== 'string' || !value || /[\\$*?\u0000-\u001f]/u.test(value) ||
      value.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) localInputFailure('A configuration reference is dynamic, absolute or unsupported.');
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(key(from)), value));
  if (resolved === '..' || resolved.startsWith('../')) localInputFailure(`${key(from)}: reference escapes the explicitly selected input roots.`);
  if (directory && scope?.rootBuildContext && resolved === '.') {
    if (!data.snapshot.directories.some(entry => entry.pathParts.length === 0 && entry.exists)) {
      localInputFailure('Compose root build context requires the actual captured root directory; no recursive build input is granted.');
    }
    return '';
  }
  const parts = localPath(resolved.split('/'));
  if (!data.roots.some(root => under(root, resolved)) && !scope?.artifacts?.has(resolved)) {
    localInputFailure(`${key(from)}: reference escapes the explicitly selected input roots.`);
  }
  if (exclusion(parts)) localInputFailure(`${key(from)}: reference overlaps a protected input.`);
  if (directory) {
    if (!data.snapshot.directories.some(entry => key(entry.pathParts) === resolved && entry.exists)) localInputFailure(`${key(from)}: referenced directory is missing or uncaptured.`);
  } else requiredText(data, parts);
  return resolved;
}
function countParsed(data: Derivation, value: unknown, visit: (value: Record<string, unknown>) => void, depth = 0): void {
  if (++data.tokens > modernLocalBounds.tokens || depth > 64) localInputFailure('Parsed configuration exceeds the node/depth bound.');
  if (Array.isArray(value)) for (const entry of value) countParsed(data, entry, visit, depth + 1);
  else if (isRecord(value)) {
    visit(value);
    for (const child of Object.values(value)) countParsed(data, child, visit, depth + 1);
  }
}

async function checkHcl(data: Derivation, parts: readonly string[], result: IsolatedHclResult): Promise<void> {
  const parsed = result.parsed;
  if(data.providerFreeInitialization&&['module','resource','provider','data','import','removed'].some(k=>parsed[k]!==undefined))
    localInputFailure('Initialized baseline admits provider-free sources only; modules, resources and provider execution need separate preparation.');
  const safeFunctions = new Set(['lower', 'upper', 'format', 'join', 'replace', 'concat', 'length', 'toset', 'tolist',
    'tostring', 'tonumber', 'try', 'coalesce', 'lookup', 'jsonencode', 'yamlencode', 'merge', 'contains',
    'can', 'cidrsubnet', 'cidrhost', 'substr', 'trimspace', 'split', 'flatten', 'range', 'element', 'distinct',
    'zipmap', 'keys', 'values', 'one', 'min', 'max',
    ...(data.manualInfrastructure ? manualInfrastructurePolicy.additionalPureFunctions : [])]);
  function literalString(ast: HclExpression): string | undefined {
    if (ast.type === 'literalValue' && typeof ast.meta.value === 'string') return ast.meta.value;
    if (ast.type === 'template') {
      const parts = ast.children.map(literalString);
      if (parts.every((part): part is string => part !== undefined)) return parts.join('');
    }
    return undefined;
  }
  async function expression(ast: HclExpression): Promise<void> {
    if (++data.tokens > modernLocalBounds.tokens) localInputFailure('HCL expression exceeds the node bound.');
    if (ast.type === 'function') {
      const name = ast.meta.name;
      if (typeof name !== 'string') localInputFailure('Invalid parsed HCL function name.');
      if (name === 'templatefile') localInputFailure('HCL templatefile is unsupported: captured template bytes do not establish nested input closure.');
      if (name === 'file' || name === 'filebase64') {
        const argument = ast.children[0];
        const literal = argument && literalString(argument);
        if (literal === undefined) {
          localInputFailure('HCL file references must be explicit bounded local literals.');
        }
        reference(data, parts, literal);
      } else if (!safeFunctions.has(name)) localInputFailure('HCL uses an unsupported filesystem, dynamic or environment-dependent function.');
    }
    for (const child of ast.children) await expression(child);
  }
  async function visit(value: unknown, depth = 0): Promise<void> {
    if (++data.tokens > modernLocalBounds.tokens || depth > 64) localInputFailure('HCL configuration exceeds the node/depth bound.');
    if (typeof value === 'string' && (value.includes('${') || value.includes('%{'))) {
      const ast = result.expressions.get(value);
      if (!ast) localInputFailure('Isolated parser omitted a required HCL expression.');
      await expression(ast);
    }
    else if (Array.isArray(value)) for (const child of value) await visit(child, depth + 1);
    else if (isRecord(value)) {
      if (value.required_providers !== undefined && !data.manualInfrastructure) localInputFailure('Provider package preparation is not established by source metadata.');
      if (!data.manualInfrastructure && value.backend !== undefined &&
          (!isRecord(value.backend) || Object.keys(value.backend).some(name => name !== 'local'))) {
        localInputFailure('Remote or unsupported backend initialization is not a local revalidation operation.');
      }
      for (const name of Object.keys(value).sort()) await visit(value[name], depth + 1);
    }
  }
  if (parsed.module !== undefined) {
    if (!isRecord(parsed.module)) localInputFailure('Unsupported HCL module representation.');
    for (const entries of Object.values(parsed.module)) {
      if (!Array.isArray(entries)) localInputFailure('Unsupported HCL module declaration.');
      for (const entry of entries) {
        if (!isRecord(entry) || typeof entry.source !== 'string' || !entry.source.startsWith('.')) {
          localInputFailure('HCL module source requires separate external preparation or has an unsupported reference.');
        }
        reference(data, parts, entry.source, true);
      }
    }
  }
  if (!data.manualInfrastructure && (parsed.provider !== undefined || parsed.data !== undefined)) {
    localInputFailure('Provider/data configuration requires separately qualified provider-cache and execution preflight; a directory is not that proof.');
  }
  await visit(parsed);
}

function checkTypeScriptConfig(data: Derivation, rootParts: readonly string[]): void {
  const visiting = new Set<string>();
  const pending: { parts: readonly string[]; complete: boolean }[] = [{ parts: rootParts, complete: false }];
  while (pending.length) {
    const { parts, complete } = pending.pop()!, name = key(parts);
    if (complete) {
      visiting.delete(name);
      data.checkedTypeScriptConfigs.add(name);
      continue;
    }
    if (visiting.has(name)) localInputFailure('TypeScript configuration inheritance or project references contain a cycle.');
    if (data.checkedTypeScriptConfigs.has(name)) continue;
    if (data.checkedTypeScriptConfigs.size + visiting.size >= modernLocalBounds.files) {
      localInputFailure('TypeScript configuration graph exceeds the captured file-count bound.');
    }
    visiting.add(name);
    const config = jsonContent(requiredText(data, parts), 'TypeScript config');
    if (!isRecord(config)) localInputFailure('TypeScript configuration must be an object.');
    countParsed(data, config, () => {});
    const dependencies: string[] = [];
    if (config.extends !== undefined) {
      if (typeof config.extends !== 'string' || !config.extends.startsWith('.')) localInputFailure('External or dynamic TypeScript configuration inheritance is unsupported.');
      dependencies.push(reference(data, parts, config.extends.endsWith('.json') ? config.extends : `${config.extends}.json`));
    }
    if (config.references !== undefined) {
      if (!Array.isArray(config.references)) localInputFailure('Unsupported TypeScript project references.');
      for (const item of config.references) {
        if (!isRecord(item) || typeof item.path !== 'string') localInputFailure('Unsupported TypeScript project reference.');
        dependencies.push(reference(data, parts, item.path.endsWith('.json') ? item.path : `${item.path}/tsconfig.json`));
      }
    }
    if (config.files !== undefined) {
      if (!Array.isArray(config.files)) localInputFailure('TypeScript files must be explicit captured references.');
      for (const target of config.files) reference(data, parts, target);
    }
    for (const name of ['include', 'exclude']) {
      const patterns = config[name];
      if (patterns === undefined) continue;
      if (!Array.isArray(patterns)) localInputFailure('TypeScript input patterns must be literal arrays.');
      for (const pattern of patterns) {
        if (typeof pattern !== 'string') localInputFailure('TypeScript input pattern must be a string.');
        const firstPattern = pattern.search(/[*?[]/u);
        const prefix = firstPattern < 0 ? pattern : pattern.slice(0, firstPattern);
        const directory = firstPattern < 0 && /\.[^/]+$/u.test(prefix) ? path.posix.dirname(prefix) : prefix.replace(/\/$/u, '') || '.';
        reference(data, parts, directory, true);
      }
    }
    if (config.compilerOptions !== undefined && !isRecord(config.compilerOptions)) {
      localInputFailure('TypeScript compilerOptions must be an object.');
    }
    if (isRecord(config.compilerOptions) && config.compilerOptions.paths !== undefined) {
      localInputFailure('TypeScript path remapping needs an explicit supported local relationship.');
    }
    if (isRecord(config.compilerOptions)) {
      const options = config.compilerOptions;
      if (['baseUrl', 'rootDirs', 'typeRoots'].some(name => options[name] !== undefined)) localInputFailure('TypeScript input-root remapping requires an explicit supported relationship.');
      if (options.rootDir !== undefined) reference(data, parts, options.rootDir, true);
    }
    pending.push({ parts, complete: true });
    for (let index = dependencies.length - 1; index >= 0; index--) {
      pending.push({ parts: dependencies[index].split('/'), complete: false });
    }
  }
}

function checkNode(data: Derivation, parts: readonly string[], script: 'test' | 'build'): void {
  const pkg = jsonContent(requiredText(data, [...parts, 'package.json']), 'Node package');
  if (!isRecord(pkg) || !isRecord(pkg.scripts) || typeof pkg.scripts[script] !== 'string' || !pkg.scripts[script]) {
    localInputFailure('Selected Node package lacks the required explicit project script.');
  }
  if (pkg.workspaces !== undefined) localInputFailure('Node workspace discovery requires an explicit supported input relationship.');
  for (const name of ['main', 'module', 'types']) {
    if (pkg[name] !== undefined) reference(data, [...parts, 'package.json'], pkg[name]);
  }
  if (pkg.imports !== undefined || pkg.exports !== undefined || pkg.bin !== undefined || pkg.browser !== undefined) {
    localInputFailure('Node entrypoint remapping requires an explicitly supported configuration relationship.');
  }
  for (const name of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const dependencies = pkg[name];
    if (dependencies !== undefined && !isRecord(dependencies)) localInputFailure('Unsupported Node dependency declaration.');
    if (isRecord(dependencies)) for (const value of Object.values(dependencies)) {
      if (typeof value !== 'string') localInputFailure('Unsupported Node dependency reference.');
      if (/^(?:file:|link:|workspace:)/u.test(value)) localInputFailure('Local/workspace Node dependencies require a separately supported package relationship.');
    }
  }
  for (const file of data.snapshot.files.filter(file => under(key(parts), key(file.pathParts)) && /(^|\/)tsconfig[^/]*\.json$/u.test(key(file.pathParts)))) {
    checkTypeScriptConfig(data, file.pathParts);
  }
}

function pythonPackageSearchPath(data: Derivation, parts: readonly string[], value: unknown): void {
  if (value !== '..') {
    reference(data, [...parts, 'pyproject.toml'], value, true);
    return;
  }
  if (++data.references > modernLocalBounds.references) localInputFailure('Local configuration exceeds the reference count bound.');
  const parent = parts.slice(0, -1);
  // A search namespace exposes only copied components; it does not select sibling source.
  if (!parts.length || exclusion(parent) ||
      !data.snapshot.directories.some(directory => key(directory.pathParts) === key(parent) && directory.exists)) {
    localInputFailure('Python package search parent is missing, protected or uncaptured.');
  }
}

function checkPython(data: Derivation, parts: readonly string[]): void {
  let parsed: unknown;
  try { parsed = parseToml(requiredText(data, [...parts, 'pyproject.toml'])); }
  catch (error) {
    if (error instanceof ModernLocalInputError) throw error;
    localInputFailure('Python project contains invalid TOML; source values were omitted.');
  }
  const pytestOptions = isRecord(parsed) && isRecord(parsed.tool) && isRecord(parsed.tool.pytest) &&
    isRecord(parsed.tool.pytest.ini_options) ? parsed.tool.pytest.ini_options : null;
  countParsed(data, parsed, record => {
    if (record.workspace !== undefined || record.sources !== undefined) localInputFailure('Python workspace/source remapping needs an explicit supported local relationship.');
    if (record.addopts !== undefined && record.addopts !== '') localInputFailure('Project-supplied pytest options require separate bounded interpretation.');
    for (const name of ['testpaths', 'pythonpath']) {
      if (record[name] === undefined) continue;
      if (!Array.isArray(record[name])) localInputFailure('Python input roots must be explicit literal arrays.');
      for (const value of record[name]) {
        if (name === 'pythonpath' && record === pytestOptions) pythonPackageSearchPath(data, parts, value);
        else reference(data, [...parts, 'pyproject.toml'], value, true);
      }
    }
    if (record.dependencies !== undefined && Array.isArray(record.dependencies) &&
        record.dependencies.some(value => typeof value !== 'string' || /file:|@\s*[./\\]/u.test(value))) {
      localInputFailure('Python local dependencies require an explicit supported input relationship.');
    }
    if (record.env_files !== undefined) localInputFailure('Python dotenv configuration is not an admitted local input.');
  });
  for (const filename of ['pytest.ini', 'setup.cfg', 'tox.ini']) {
    if (data.files.get(key([...parts, filename]))?.content != null) localInputFailure('An additional Python configuration format requires explicit input interpretation.');
  }
}

function checkCompose(data: Derivation, parts: readonly string[]): void {
  let parsed: unknown;
  try {
    if (data.closedManualInputs) {
      const observed = inspectModernComposeInputs(requiredText(data, parts));
      parsed = observed.document;
      data.composeInputs = observed.inputs;
    } else parsed = parseYaml(requiredText(data, parts), { uniqueKeys: true, maxAliasCount: 0 });
  }
  catch (error) {
    if (error instanceof ModernLocalInputError) throw error;
    localInputFailure('Compose contains invalid or unsupported YAML; source values were omitted.');
  }
  if (!isRecord(parsed) || !isRecord(parsed.services)) localInputFailure('Compose requires an explicit services object.');
  function visit(value: unknown): void {
    if (++data.tokens > modernLocalBounds.tokens) localInputFailure('Compose exceeds the node bound.');
    if (!data.closedManualInputs && typeof value === 'string' && value.includes('$')) localInputFailure('Compose interpolation is not bound to captured local input.');
    if (Array.isArray(value)) value.forEach(visit);
    else if (isRecord(value)) {
      if (['include', 'extends', 'env_file', 'secrets', 'driver_opts'].some(name => Object.hasOwn(value, name))) {
        localInputFailure('Compose external includes, inheritance, env_file and secret inputs are not permitted in this local recipe.');
      }
      Object.values(value).forEach(visit);
    }
  }
  visit(parsed);
  if (parsed.configs !== undefined) {
    if (!isRecord(parsed.configs)) localInputFailure('Compose config references must be an object.');
    for (const config of Object.values(parsed.configs)) {
      if (!isRecord(config) || config.file === undefined) localInputFailure('External or implicit Compose config references are unsupported.');
      reference(data, parts, config.file);
    }
  }
  const buildScope = data.closedManualInputs ? { rootBuildContext: true } : undefined;
  const dockerfileScope = data.closedManualInputs ? {
    artifacts: new Set(data.manifest.activeLayout.bindings.filter(binding => binding.kind === 'artifact' &&
      ['backend-dockerfile', 'frontend-dockerfile', 'function-worker-dockerfile'].includes(binding.logicalName)).map(binding => key(binding.pathParts)))
  } : undefined;
  for (const service of Object.values(parsed.services)) {
    if (!isRecord(service)) localInputFailure('Compose service must be an object.');
    if (Object.hasOwn(service, 'label_file')) localInputFailure('Compose service label_file inputs are unsupported and are not read by this local recipe.');
    if (Object.hasOwn(service, 'credential_spec')) localInputFailure('Compose service credential_spec sources are unsupported; no credential file or registry input is read.');
    if (service.build !== undefined) {
      const build = service.build;
      const context = typeof build === 'string' ? build : isRecord(build) ? build.context : undefined;
      reference(data, parts, context, true, buildScope);
      if (isRecord(build) && (build.additional_contexts !== undefined || build.dockerfile_inline !== undefined)) {
        localInputFailure('Additional or inline Compose build contexts are unsupported.');
      }
      if (isRecord(build) && build.dockerfile !== undefined) {
        const contextPath = reference(data, parts, context, true, buildScope);
        reference(data, [...(contextPath ? contextPath.split('/') : []), 'context'], build.dockerfile, false, dockerfileScope);
      }
    }
    if (Array.isArray(service.volumes)) for (const volume of service.volumes) {
      const source = typeof volume === 'string' ? volume.split(':')[0] : isRecord(volume) && volume.type === 'bind' ? volume.source : undefined;
      if (typeof source === 'string' && (source.startsWith('.') || source.startsWith('/'))) reference(data, parts, source, true);
    }
  }
}

function checkWorkflow(data: Derivation): { state: string; command: ModernLocalCheck['command'] } {
  const { manifest } = data, workflow = manifest.project.specWorkflow;
  if (workflow === 'manual') return { state: 'manual-not-required', command: null };
  if (manifest.framework.state !== 'initialized') localInputFailure('Selected external framework is legacy/uninitialized; it is not Manual or initialized readiness.');
  for (const parts of frameworkOutputPaths({
    workflow, agents: [...manifest.project.agents],
    ...(manifest.project.defaultAgent ? { defaultAgent: manifest.project.defaultAgent } : {})
  })) {
    if (key(parts) === key(OPEN_SPEC_CODEX_TARGET_PATH)) continue;
    if (!requiredText(data, parts).length) localInputFailure('Selected framework marker is empty.');
  }
  if (workflow === 'spec-kit') {
    const issues: string[] = [];
    for (const name of ['spec', 'plan', 'tasks'] as const) {
      const parts = [...specKitBootstrapPath, `${name}.md`], content = requiredText(data, parts);
      appendSpecKitDocumentIssues(name, content, parts, issues);
      if (name === 'tasks') appendSpecKitTaskIssues(content, issues);
      data.normalized.set(key(parts), { path: key(parts), content: normalizedSeedInput(content) });
    }
    const state = jsonContent(requiredText(data, ['.specify', 'integration.json']), 'Spec Kit integration');
    if (!isSpecKitIntegrationRecord(state)) localInputFailure('Spec Kit integration state must be a JSON object.');
    const expectedDefault = manifest.project.defaultAgent
      ? projectCatalog.getCodingAgent(manifest.project.defaultAgent)?.integrationIds['spec-kit'] : undefined;
    appendSpecKitDefaultIssues(state, expectedDefault, issues);
    if (!isSpecKitInstalledList(state.installed_integrations)) issues.push('Spec Kit installed_integrations must be a string array.');
    else appendSpecKitSelectedIssues(state.installed_integrations, manifest.project.agents.map(agent => projectCatalog.getCodingAgent(agent)!.integrationIds['spec-kit']), issues);
    if (issues.length) localInputFailure(issues.join(' '));
    return { state: 'spec-kit-bootstrap-observed-not-finalized', command: null };
  }
  if (manifest.project.agents.some(agent => agent === 'codex')) {
    const target = data.files.get(key(OPEN_SPEC_CODEX_TARGET_PATH));
    if (target?.content !== null && target !== undefined && !isOpenSpecCodexTarget(requiredText(data, OPEN_SPEC_CODEX_TARGET_PATH))) {
      localInputFailure('OpenSpec shared skills target does not identify the selected Codex integration.');
    }
  }
  const name = bootstrapName(manifest), capability = capabilityName(manifest);
  const changes = data.snapshot.directories.find(directory => key(directory.pathParts) === 'openspec/changes');
  const archives = data.snapshot.directories.find(directory => key(directory.pathParts) === 'openspec/changes/archive');
  if (!changes || !archives) localInputFailure('Bootstrap membership and archive absence were not captured.');
  const active = changes.entries.filter(entry => entry.name.startsWith('bootstrap-'));
  const archived = archives.entries.filter(entry => entry.name === name || entry.name.endsWith(`-${name}`));
  const archivedSource = active.length === 0 && archived.length === 1;
  const base = active.length === 1 && active[0].name === name && archived.length === 0
    ? ['openspec', 'changes', name] : archivedSource ? ['openspec', 'changes', 'archive', archived[0].name] : undefined;
  if (!base) localInputFailure('Bootstrap source is absent, ambiguous, or has both active and archived copies.');
  const proposal = requiredText(data, [...base, 'proposal.md']), declared = extractDeclaredCapabilities(proposal);
  if (declared.length !== 1 || declared[0] !== capability) localInputFailure('The actual bootstrap proposal does not name exactly the selected workload capability.');
  for (const parts of [['.openspec.yaml'], ['proposal.md'], ['design.md'], ['tasks.md'], ['specs', capability, 'spec.md']]) {
    const physical = [...base, ...parts], content = requiredText(data, physical);
    data.normalized.set(key(physical), { path: key(['openspec', 'changes', name, ...parts]), content: normalizedSeedInput(content) });
  }
  if (archivedSource) {
    const main = ['openspec', 'specs', capability, 'spec.md'], content = requiredText(data, main), purpose = mainSpecPurpose(content);
    if (!purpose || purpose.startsWith('TBD - created by archiving change')) localInputFailure('Archived bootstrap has no concrete synchronized main Purpose.');
    const source = requiredText(data, [...base, 'specs', capability, 'spec.md']);
    if (!archivedOpenSpecMatchesMain(content, source)) localInputFailure('Archived and synchronized capability sources do not have the required concrete content relationship.');
    data.omitFromBaseline.add(key(main));
  }
  return { state: archivedSource ? 'openspec-archived-source' : 'openspec-active-source',
    command: { executable: 'openspec', args: archivedSource ? ['validate', '--all', '--strict'] : ['validate', name, '--strict'] } };
}

/** Reconstructs from copied bytes, including real HCL parsing; installed parser initialization may read package resources. */
export async function planModernLocalVerification(inspection: ModernLocalInspection): Promise<ModernLocalVerificationPlan> {
  return deriveLocalVerification(inspection);
}

async function deriveLocalVerification(
  inspection: ModernLocalInspection, installed?: Extract<InstalledLocalPreflight, { status: 'observed' }>,providerFreeInitialization=false,
  closedManualInputs=false, manualNative?: ManualNativeDetails
): Promise<ModernLocalVerificationPlan> {
  const captured = copyModernLocalData(inspection);
  if (captured.status !== 'modern-observed') {
    if (captured.status !== 'blocked' && captured.status !== 'released-source') localInputFailure('Unknown local inspection state.');
    if (captured.status === 'blocked') {
      exactRecord(captured, ['status', 'blockers'], 'Blocked local inspection');
      if (!Array.isArray(captured.blockers) || !captured.blockers.length ||
          captured.blockers.some(reason => typeof reason !== 'string' || !reason)) localInputFailure('A blocked local inspection requires explicit reasons.');
    } else {
      exactRecord(captured, ['status', 'root', 'manifestVersion', 'sourceDigest'], 'Released local source');
      if (typeof captured.root !== 'string' || !path.isAbsolute(captured.root) ||
          !Number.isInteger(captured.manifestVersion) || captured.manifestVersion < 2 || captured.manifestVersion > 7 ||
          typeof captured.sourceDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(captured.sourceDigest)) localInputFailure('Invalid released-source observation.');
    }
    return assembleModernLocalPlan(captured, null, [], [], null, hclComputationPolicy);
  }
  exactRecord(captured, ['status', 'snapshot'], 'Local inspection');
  validateModernLocalSnapshot(captured.snapshot);
  const snapshot = captured.snapshot, files = new Map(snapshot.files.map(file => [key(file.pathParts), file]));
  const manifestFile = files.get('liftoff.manifest.json');
  const manifestBytes = manifestFile && capturedFileBytes(manifestFile);
  if (!manifestBytes) localInputFailure('Local snapshot is missing its complete manifest bytes.');
  const manifest = rootReader.parseManifestV8(jsonContent(text(manifestBytes, 'Manifest'), 'Manifest'));
  const sourceContext = resolveModernManifestSourceContext(manifest), { source } = sourceContext;
  const context: ModernLocalContext = manifest.governance.profile === 'none' ? {
    kind: 'governance-none', selectionDigest: `sha256:${canonicalSha256({
      kind: 'liftoff-local-selection', schemaVersion: 1, project: manifest.project, framework: manifest.framework, profile: 'none'
    })}`, pluginResolutionDigest: manifest.plugins.resolutionDigest,
    activeLayoutDigest: manifestActiveLayoutDigest(manifest.activeLayout, source.layoutDescriptor)
  } : { kind: 'governed', identity: manifest.governance.activationIdentity };
  const bindings: readonly ManifestLayoutBinding[] = [...sourceContext.activeLayout.bindings];
  const components: readonly Extract<ManifestLayoutBinding, { kind: 'component' }>[] = bindings.filter(
    (binding): binding is Extract<ManifestLayoutBinding, { kind: 'component' }> => binding.kind === 'component'
  );
  const data: Derivation = {
    manifest, snapshot, files, roots: components.map(binding => key(binding.pathParts)),
    normalized: new Map(), omitFromBaseline: new Set(), checkedTypeScriptConfigs: new Set(),providerFreeInitialization,
    closedManualInputs, references: 0, tokens: 0
  };
  const checks: ModernLocalCheck[] = [], expected: string[] = [];
  const hclFiles = snapshot.files.filter(file => file.content !== null && file.pathParts.at(-1)?.endsWith('.tf') &&
    components.some(component => component.component.startsWith('opentofu-') && under(key(component.pathParts), key(file.pathParts))));
  let hclResults: Promise<ReadonlyMap<string, IsolatedHclResult>> | undefined;
  function hclDerivation(): Promise<ReadonlyMap<string, IsolatedHclResult>> {
    hclResults ??= parseIsolatedHcl(hclFiles.map(file => requiredText(data, file.pathParts))).then(results =>
      new Map(results.map((result, index) => [key(hclFiles[index].pathParts), result])));
    return hclResults;
  }
  const inputPaths = snapshot.files.map(file => key(file.pathParts));
  async function check(id: string, action: () => void | Promise<void>, recipe: Partial<ModernLocalCheck> = {}): Promise<void> {
    expected.push(id);
    let reasons: string[] = [];
    try { await action(); } catch (error) { reasons = [safeFailure(error)]; }
    checks.push({ id, status: reasons.length ? 'blocked' : 'planned', inputPaths, reasons,
      command: null, cwdPathParts: [], env: {}, prerequisites: [], effects: [], ...recipe,
      ...(reasons.length ? { status: 'blocked' as const, reasons } : {}) });
  }
  function component(id: ManifestLayoutComponentId): readonly string[] {
    const found = findModernActiveComponentBinding(sourceContext, id);
    if (!found) return localInputFailure(`Selected component ${id} has no explicit active binding.`);
    if (!snapshot.directories.some(directory => key(directory.pathParts) === key(found.pathParts) && directory.exists)) {
      localInputFailure(`Selected component ${id} is missing or uncaptured.`);
    }
    if (!snapshot.files.some(file => under(key(found.pathParts), key(file.pathParts)) && file.content !== null)) {
      localInputFailure(`Selected component ${id} contains no captured source files.`);
    }
    return found.pathParts;
  }
  const pending = ['installed tool identity and supported version', 'isolated execution boundary and explicit local consent', 'MR2 installed-state/history and settlement preflight'];
  await check('source-consistency', async () => {
    if (closedManualInputs && manifest.project.specWorkflow !== 'manual') {
      localInputFailure('Closed Manual input interpretation cannot replace an external framework input contract.');
    }
    if (manifest.sourceManifestHistory && !installed) localInputFailure('Installed preserved-history preflight is not established by a source reference.');
    for (const parts of journalPaths) if (!files.has(key(parts)) || files.get(key(parts))?.content !== null) localInputFailure('Transaction absence was not captured.');
    for (const parts of installedBoundaryPaths) {
      if (installed) {
        const actual = files.get(key(parts)), expected = installed.snapshot.files.find(file => key(file.pathParts) === key(parts));
        if (!actual || !expected || canonicalJson(actual) !== canonicalJson(expected)) localInputFailure('Captured controls contradict independent installed preflight.');
      } else if (!files.has(key(parts)) || files.get(key(parts))?.content !== null) localInputFailure('Installed boundary absence was not captured; MR2 preflight is required.');
    }
    if (installed) {
      if (installed.snapshot.root !== snapshot.root ||
          installed.snapshot.files.find(file => key(file.pathParts) === 'liftoff.manifest.json')?.digest !== rawLocalDigest(manifestBytes)) localInputFailure('Runtime source does not match installed preflight.');
      for (const entry of snapshot.physical) {
        const control = installed.snapshot.physical.find(candidate => candidate.path === entry.path);
        if (control && canonicalJson(control) !== canonicalJson(entry)) localInputFailure('Runtime and installed physical inputs differ.');
      }
      const protectedPaths = installed.retention.flatMap(obligation => obligation.protectedPaths).map(parts => key(parts).toLowerCase());
      if (snapshot.files.some(file => protectedPaths.some(protectedPath => under(protectedPath, key(file.pathParts).toLowerCase()))) ||
          bindings.some(binding => protectedPaths.some(protectedPath =>
            under(protectedPath, key(binding.pathParts).toLowerCase()) || under(key(binding.pathParts).toLowerCase(), protectedPath)))) {
        localInputFailure('Runtime inputs overlap immutable retained state/key boundaries.');
      }
      if (installed.current && (['local-inputs-valid','local-baseline-verified','local-complete'] as const).some(id =>
        installed.current!.state.phases[id].state === 'running')) {
        localInputFailure('An installed local phase is still running; execution settlement must be established separately.');
      }
    }
    verifyManagedInputs(manifest, files);
    if (manifest.activeLayout.state !== 'bound') localInputFailure('Active layout is unresolved.');
    for (const id of source.layoutDescriptor.components) component(id);
    if (snapshot.directories.some(directory => (directory.pathParts.length === 0 || data.roots.some(root => under(root, key(directory.pathParts)))) &&
        directory.entries.some(entry => ['.npmrc', '.pypirc', '.yarnrc', '.yarnrc.yml', '.terraformrc', 'terraform.rc'].includes(entry.name.toLowerCase())))) {
      localInputFailure('Uninterpreted project tool configuration requires a separately isolated recipe.');
    }
    for (const directory of snapshot.directories.filter(directory => data.roots.some(root => under(root, key(directory.pathParts))))) {
      for (const entry of directory.entries) {
        const parts = [...directory.pathParts, entry.name], name = key(parts), reason = exclusion(parts);
        if (['liftoff.manifest.json', '.liftoff', '.git'].includes(entry.name.toLowerCase())) localInputFailure('A captured component contains a nested project boundary.');
        if (reason) {
          if (!snapshot.exclusions.some(excluded => key(excluded.pathParts) === name && excluded.kind === entry.kind && excluded.reason === reason)) localInputFailure('A selected exclusion was omitted from captured membership.');
        } else if (entry.kind === 'directory') {
          if (!snapshot.directories.some(child => key(child.pathParts) === name && child.exists)) localInputFailure('A selected directory is absent from the captured scope.');
        } else if (entry.kind !== 'file' || !files.has(name) || files.get(name)?.content === null) localInputFailure('A selected source file is missing, unsafe or omitted from captured membership.');
      }
    }
    if (manualNative) {
      const parsed = await hclDerivation();
      const infrastructure = deriveManualInfrastructureInputs(manifest, files, parsed);
      data.manualInfrastructure = infrastructure;
      for (const file of hclFiles) {
        const result = parsed.get(key(file.pathParts));
        if (!result) localInputFailure('Native Manual source interpretation is missing a selected HCL result.');
        await checkHcl(data, file.pathParts, result);
      }
      manualNative.infrastructure = infrastructure;
    }
  });
  const backend = components.find(binding => binding.component === 'backend')?.pathParts ?? [];
  const stack = manifest.project.workload.apiStack;
  const backendCommand = stack === 'python-fastapi' ? pythonBackendCommand(key(backend), key([...backend, 'tests'])) :
    stack === 'node-fastify' ? nodeBackendCommand() : goBackendCommand();
  const localCommand = backendCommand.executable === 'uv'
    ? { ...backendCommand, args: ['run', '--no-sync', '--offline', ...backendCommand.args.slice(1)] }
    : backendCommand.executable === 'npm' ? { ...backendCommand, args: ['--offline', '--ignore-scripts', '--no-audit', '--no-fund', ...backendCommand.args] }
      : { ...backendCommand, args: ['test', '-mod=readonly', './...'] };
  await check('backend-tests', () => {
    const parts = component('backend');
    if (stack === 'python-fastapi') checkPython(data, parts);
    else if (stack === 'node-fastify') checkNode(data, parts, 'test');
    else if (/^\s*(?:replace|toolchain)\b/mu.test(requiredText(data, [...parts, 'go.mod']))) localInputFailure('Go local replacements or implicit toolchain selection require explicit interpretation.');
    const testPattern = stack === 'python-fastapi' ? /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/u :
      stack === 'go-huma' ? /_test\.go$/u : /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
    if (!snapshot.files.some(file => under(key(parts), key(file.pathParts)) && file.content !== null && testPattern.test(key(file.pathParts)))) {
      localInputFailure('Selected backend has no captured test source for its local recipe.');
    }
    if (stack === 'python-fastapi' && !snapshot.directories.some(directory => key(directory.pathParts) === key([...parts, 'tests']) && directory.exists)) {
      localInputFailure('The Python recipe requires its actual bound tests directory.');
    }
    if (snapshot.directories.some(directory => under(key(parts), key(directory.pathParts)) &&
        directory.entries.some(entry => ['.npmrc', '.pypirc'].includes(entry.name)))) {
      localInputFailure('Project package-manager configuration must be separately isolated; its bytes are not inspected.');
    }
  }, { command: localCommand, cwdPathParts: stack === 'python-fastapi' ? [] : backend, prerequisites: pending,
    effects: ['executes project code; may create local outputs', 'offline flags are not network or host isolation'],
    env: stack === 'python-fastapi' ? { UV_PYTHON_DOWNLOADS: 'never' } : stack === 'node-fastify'
      ? { npm_config_offline: 'true', npm_config_ignore_scripts: 'true', npm_config_update_notifier: 'false' }
      : { GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local', GONOPROXY: 'none', GOVCS: '*:off', GOFLAGS: '', GOWORK: 'off', CGO_ENABLED: '0' } });
  const workerSelected = source.layoutDescriptor.components.includes('function-worker');
  const worker = components.find(binding => binding.component === 'function-worker')?.pathParts ?? [];
  const workerCommand = workerTestCommand(path.posix.relative(key(worker), key(backend)));
  await check('worker-tests', () => {
    if (workerSelected) {
      const parts = component('function-worker');
      checkPython(data, component('backend'));
      if (!snapshot.files.some(file => under(key(parts), key(file.pathParts)) && file.content !== null && /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/u.test(key(file.pathParts)))) {
        localInputFailure('Selected worker has no captured Python test source.');
      }
    }
  }, {
    status: workerSelected ? 'planned' : 'inapplicable', reasons: workerSelected ? [] : ['Actual selected source has no worker component.'],
    command: workerSelected ? { ...workerCommand, args: ['run', '--no-sync', '--offline', ...workerCommand.args.slice(1)] } : null,
    cwdPathParts: workerSelected ? worker : [], env: workerSelected ? { UV_PYTHON_DOWNLOADS: 'never' } : {},
    prerequisites: workerSelected ? pending : [], effects: workerSelected ? ['executes project worker code; may read host or network without later isolation'] : []
  });
  const frontend = components.find(binding => binding.component === 'frontend')?.pathParts ?? [], frontendCommand = frontendBuildCommand();
  await check('frontend-build', () => { if (manifest.project.workload.frontend) checkNode(data, component('frontend'), 'build'); }, {
    status: manifest.project.workload.frontend ? 'planned' : 'inapplicable',
    reasons: manifest.project.workload.frontend ? [] : ['Frontend is omitted by the actual workload.'],
    command: manifest.project.workload.frontend ? { ...frontendCommand, args: ['--offline', '--ignore-scripts', '--no-audit', '--no-fund', ...frontendCommand.args] } : null,
    cwdPathParts: frontend, prerequisites: manifest.project.workload.frontend ? pending : [],
    effects: manifest.project.workload.frontend ? ['executes project build code and writes local build outputs'] : []
  });
  const compose = bindings.find(binding => binding.kind === 'artifact' && binding.logicalName === 'docker-compose')?.pathParts;
  await check('compose-config', () => {
    if (!compose) localInputFailure('Compose has no explicit artifact binding.');
    checkCompose(data, compose);
  }, { command: compose ? { executable: 'docker', args: ['compose', '--project-directory', path.posix.dirname(key(compose)), '-f', key(compose), 'config', '-q'] } : null,
    env: { COMPOSE_DISABLE_ENV_FILE: '1', COMPOSE_ENV_FILES: '' }, prerequisites: pending,
    effects: [closedManualInputs
      ? 'configuration-only; no container build or startup; project variables must be explicitly unset without dotenv'
      : 'configuration-only; no container build or startup; dotenv/interpolation inputs are not admitted'] });
  for (const id of source.layoutDescriptor.components.filter(id => id.startsWith('opentofu-'))) {
    const parts = components.find(binding => binding.component === id)?.pathParts ?? [];
    let sources: ModernLocalFile[] = [];
    let explicitFormat: ModernLocalCheck['command'] = null;
    await check(`tofu-format:${id}`, async () => {
      component(id);
      if (closedManualInputs) {
        explicitFormat = explicitTofuFormatCommand(parts, snapshot.files);
        return;
      }
      if (snapshot.exclusions.some(entry => under(key(parts), key(entry.pathParts)) && /\.tfvars(?:\.json)?$/u.test(key(entry.pathParts)))) {
        localInputFailure('Live OpenTofu variable inputs are excluded, so recursive format/revalidation is not admitted.');
      }
      if (snapshot.exclusions.some(entry => under(key(parts), key(entry.pathParts)))) {
        localInputFailure('Recursive OpenTofu format scope contains excluded inputs; Liftoff exclusions do not establish command-level ignore semantics.');
      }
      if (snapshot.files.some(file => under(key(parts), key(file.pathParts)) && /\.(?:tf|tofu)\.json$|\.tofu$|\.tfvars(?:\.json)?$/u.test(key(file.pathParts)))) {
        localInputFailure('Additional OpenTofu JSON/override/variable-file inputs require an explicitly supported interpretation.');
      }
      sources = snapshot.files.filter(file => under(key(parts), key(file.pathParts)) && file.pathParts.at(-1)?.endsWith('.tf'));
      if (!sources.length) localInputFailure('Selected OpenTofu component has no captured .tf source.');
      const results = await hclDerivation();
      for (const file of sources) {
        const result = results.get(key(file.pathParts));
        if (!result) localInputFailure('Isolated parser omitted a selected HCL file.');
        await checkHcl(data, file.pathParts, result);
      }
    }, { command: tofuFormatCommand(), cwdPathParts: parts, prerequisites: pending,
      env: { TF_CLI_ARGS: '', TF_CLI_ARGS_fmt: '', TF_INPUT: '0', CHECKPOINT_DISABLE: '1' }, effects: ['format check only; no writes, init, plan or apply'] });
    if (closedManualInputs) checks[checks.length - 1] = { ...checks[checks.length - 1], command: explicitFormat };
    const formatting = checks.at(-1);
    const coveredModule = Boolean(manualNative) && id === 'opentofu-application';
    if (manualNative && !coveredModule) {
      await check(`tofu-initialize:${id}`, () => {
        if (!formatting || formatting.status !== 'planned' || !manualNative.infrastructure?.roots.some(root => root.component === id)) {
          localInputFailure('Native initialization requires the complete captured lock, provider and module graph.');
        }
      }, {
        command: { executable: 'tofu', args: [...manualInfrastructurePolicy.initArgs] }, cwdPathParts: parts, env: {},
        prerequisites: [...pending, 'separate locked infrastructure preparation and provider-distribution network approval'],
        effects: ['downloads the explicitly locked provider into owned storage; backend disabled; no plan, apply or original writes']
      });
    }
    await check(`tofu-validate:${id}`, () => {
      if (!formatting || formatting.status === 'blocked') localInputFailure('OpenTofu source/reference prerequisites are incomplete.');
      if (manualNative) {
        if (!manualNative.infrastructure || !coveredModule && checks.at(-1)?.status !== 'planned') {
          localInputFailure('Locked initialization and source-closed module prerequisites are incomplete.');
        }
      } else if (closedManualInputs) localInputFailure('Closed formatting inputs do not establish separately approved locked provider/module preparation or native validation.');
    }, coveredModule ? {
      status: 'inapplicable', command: null, reasons: ['The application module is validated through every selected locked environment root, not by an unperformed standalone command.']
    } : manualNative ? {
      command: { executable: 'tofu', args: [...manualInfrastructurePolicy.validateArgs] }, cwdPathParts: parts, env: {},
      prerequisites: [...pending, `tofu-initialize:${id}`, 'unchanged owned provider/module outputs'],
      effects: ['executes the locked provider for schema validation; no backend, plan, apply or remote credential requirement']
    } : {
      command: tofuValidateCommand(), cwdPathParts: parts,
      env: { TF_CLI_ARGS: '', TF_CLI_ARGS_validate: '', TF_DATA_DIR: '.terraform', TF_INPUT: '0', CHECKPOINT_DISABLE: '1' },
      prerequisites: [...pending, 'any module/provider preparation must be separately established; no init is authorized'],
      effects: ['local validation only; provider/backend execution and initialization remain unavailable']
    });
  }
  let workflow: ReturnType<typeof checkWorkflow> | undefined;
  await check('framework-source', () => { workflow = checkWorkflow(data); }, {
    status: manifest.project.specWorkflow === 'manual' ? 'inapplicable' : 'planned',
    reasons: manifest.project.specWorkflow === 'manual' ? ['Manual selects no external framework.'] : []
  });
  if (workflow) checks[checks.length - 1] = {
    ...checks[checks.length - 1], command: workflow.command,
    reasons: manifest.project.specWorkflow === 'manual' ? ['Manual selects no external framework.'] : [workflow.state],
    prerequisites: workflow.command ? pending : [], effects: workflow.command ? ['read-only strict validation; archive and sync are not authorized'] : []
  };
  const baseline = snapshot.files.filter(file => file.content !== null && !data.omitFromBaseline.has(key(file.pathParts))).map(file => {
    const normalized = data.normalized.get(key(file.pathParts));
    return { path: normalized?.path ?? key(file.pathParts), mode: file.mode,
      digest: normalized ? sha256Hex(normalized.content) : file.digest };
  }).sort((a, b) => compare(a.path, b.path));
  if (manualNative) manualNative.composeInputs = data.composeInputs;
  return assembleModernLocalPlan(captured, context, checks, expected, baseline, manualNative ? {
    kind: 'liftoff-manual-native-source-plan', version: 1, hcl: hclComputationPolicy,
    compose: modernComposeInputPolicy, composeInputs: data.composeInputs ?? null,
    formatting: explicitTofuFormatPolicy, infrastructure: manualInfrastructurePolicy,
    infrastructureInputs: manualNative.infrastructure ?? null
  } : closedManualInputs ? {
    kind: 'liftoff-closed-manual-source-plan', version: 1,
    hcl: hclComputationPolicy, compose: modernComposeInputPolicy,
    composeInputs: data.composeInputs ?? null, formatting: explicitTofuFormatPolicy
  } : hclComputationPolicy);
}

export async function planClosedManualLocalInputs(inspection: ModernLocalInspection): Promise<ModernLocalVerificationPlan> {
  return deriveLocalVerification(inspection, undefined, false, true);
}

export async function reinspectModernLocalVerification(root: string, prior: ModernLocalVerificationPlan): Promise<ModernLocalInspection> {
  const captured = copyModernLocalData(prior);
  if (typeof root !== 'string' || !root || root.length > 4096) localInputFailure('Local reinspection requires a bounded root.');
  const requestedRoot = root;
  const reconstructed = await planModernLocalVerification(captured.inspection);
  if (canonicalJson(reconstructed) !== canonicalJson(captured)) localInputFailure('Local plan differs from independently reconstructed recipes, inputs or complete check coverage.');
  const current = await inspectModernLocalVerification(requestedRoot);
  const next = await planModernLocalVerification(current);
  if (next.observationDigest !== reconstructed.observationDigest || next.physicalDigest !== reconstructed.physicalDigest ||
      next.recipeSet.digest !== reconstructed.recipeSet.digest) {
    return { status: 'blocked', blockers: ['Local raw bytes, membership, absence, physical identity or recipe inputs changed; obtain a fresh plan.'] };
  }
  return current;
}

/** Independently establishes stored record/history truth; no supplied boolean or approval bypass. */
export async function inspectModernLocalRuntime(root: string): Promise<ModernLocalRuntimeInspection> {
  return inspectRuntime(root,false);
}
export async function inspectModernOpenSpecRuntime(root:string):Promise<ModernLocalRuntimeInspection>{
  return inspectRuntime(root,'active');
}
export async function inspectModernArchivedOpenSpecRuntime(root:string):Promise<ModernLocalRuntimeInspection>{
  return inspectRuntime(root,'archived');
}
async function inspectRuntime(root:string,openSpecReadSet:'active'|'archived'|false):Promise<ModernLocalRuntimeInspection>{
  if (typeof root !== 'string' || !root || root.length > 4096) localInputFailure('Runtime observation requires a bounded root.');
  const selectedRoot = root;
  const installed = await inspectModernInstalledActivation(selectedRoot);
  if (installed.status === 'blocked') return { kind: 'liftoff-modern-local-runtime-inputs', schemaVersion: 1, status: 'blocked', blockers: installed.blockers };
  const local = installed.classification === 'released-source'
    ? { status: 'released-source' as const, root: installed.snapshot.root,
      manifestVersion: Number(historyManifestVersion(installed)), sourceDigest: installed.binding }
    : await inspectLocalInputs(selectedRoot, installed,openSpecReadSet);
  const fresh = await inspectModernInstalledActivation(selectedRoot);
  if (fresh.status !== 'observed' || fresh.binding !== installed.binding) {
    return { kind: 'liftoff-modern-local-runtime-inputs', schemaVersion: 1, status: 'blocked', blockers: ['Installed input changed during runtime scope observation.'] };
  }
  return { kind: 'liftoff-modern-local-runtime-inputs', schemaVersion: 1, status: 'observed', installed, local };
}
function historyManifestVersion(installed: Extract<InstalledLocalPreflight, { status: 'observed' }>): unknown {
  const file = installed.snapshot.files.find(file => key(file.pathParts) === 'liftoff.manifest.json')!;
  const manifest = jsonContent(text(capturedFileBytes(file)!, 'Released manifest'), 'Released manifest');
  return isRecord(manifest) ? manifest.artifactVersion : undefined;
}
export async function planModernLocalRuntime(input: ModernLocalRuntimeInspection,providerFreeInitialization=false): Promise<ModernLocalRuntimePlan> {
  return deriveModernLocalRuntime(input, providerFreeInitialization);
}
export async function planManualNativeLocalRuntime(input: ModernLocalRuntimeInspection) {
  const details: ManualNativeDetails = {};
  const plan = await deriveModernLocalRuntime(input, false, details);
  return { plan, composeInputs: details.composeInputs ?? null, infrastructure: details.infrastructure ?? null };
}
async function deriveModernLocalRuntime(
  input: ModernLocalRuntimeInspection, providerFreeInitialization: boolean, manualNative?: ManualNativeDetails
): Promise<ModernLocalRuntimePlan> {
  const inspection = copyModernLocalData(input);
  exactRecord(inspection, inspection.status === 'blocked' ? ['kind','schemaVersion','status','blockers'] :
    ['kind','schemaVersion','status','installed','local'], 'Runtime inspection');
  if (inspection.kind !== 'liftoff-modern-local-runtime-inputs' || inspection.schemaVersion !== 1) localInputFailure('Unknown runtime inspection identity.');
  if (inspection.status === 'blocked') {
    if (!inspection.blockers.length) localInputFailure('Runtime blocker requires an explicit reason.');
    return { kind:'liftoff-modern-local-runtime-plan',schemaVersion:1,status:'blocked',inspection,
      localPlan:null,installedBinding:null,blockers:inspection.blockers,execution:'not-authorized',publication:'codec-unavailable-not-authorized' };
  }
  if (inspection.status !== 'observed') localInputFailure('Unknown runtime inspection status.');
  const actual = await validateCapturedModernInstalledActivation(inspection.installed.snapshot);
  if (canonicalJson(actual) !== canonicalJson(inspection.installed)) localInputFailure('Supplied installed summary differs from its captured actual records.');
  const localPlan = await deriveLocalVerification(inspection.local, actual,providerFreeInitialization,Boolean(manualNative),manualNative);
  return { kind:'liftoff-modern-local-runtime-plan',schemaVersion:1,status:localPlan.status,inspection,
    localPlan,installedBinding:actual.binding,blockers:localPlan.blockers,execution:'not-authorized',publication:'codec-unavailable-not-authorized' };
}
export async function reinspectModernLocalRuntime(root: string, prior: ModernLocalRuntimePlan): Promise<ModernLocalRuntimeInspection> {
  const captured = copyModernLocalData(prior);
  if (typeof root !== 'string' || !root || root.length > 4096) localInputFailure('Runtime reinspection requires a bounded root.');
  const selectedRoot = root;
  const expected = await planModernLocalRuntime(captured.inspection);
  if (canonicalJson(expected) !== canonicalJson(captured)) localInputFailure('Runtime plan differs from independent installed/input reconstruction.');
  const current = await inspectModernLocalRuntime(selectedRoot), next = await planModernLocalRuntime(current);
  if (next.installedBinding !== expected.installedBinding ||
      next.localPlan?.observationDigest !== expected.localPlan?.observationDigest ||
      next.localPlan?.physicalDigest !== expected.localPlan?.physicalDigest ||
      next.localPlan?.recipeSet.digest !== expected.localPlan?.recipeSet.digest) {
    return {kind:'liftoff-modern-local-runtime-inputs',schemaVersion:1,status:'blocked',blockers:['Runtime installed history, source or physical bindings changed; capture a fresh plan.']};
  }
  return current;
}
