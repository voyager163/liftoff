import { createHash } from 'node:crypto';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { FileSystemError } from './errors.js';
import { exactRecord } from './manifest/fields.js';
import { validateArtifactPathParts } from './paths.js';
import { isProjectTelemetryId, isTelemetryCliVersion } from '../../telemetry/contract.js';

export const heartbeatInventoryPath = ['.liftoff', 'telemetry', 'heartbeat.json'];
export const heartbeatWorkflowPath = ['.github', 'workflows', 'liftoff-project-heartbeat.yml'];
export const heartbeatPublicationBlocker =
  'No qualified published heartbeat-capable Linux CLI archive, immutable artifact digest, and checkout action are registered. Enrollment cannot enable CI reporting.';

export interface HeartbeatTooling {
  cliVersion: string;
  archiveUrl: string;
  archiveSha256: string;
  checkoutAction: string;
}
export interface HeartbeatEntry {
  projectId: string;
  pathParts: string[];
}
export interface HeartbeatInventory {
  schemaVersion: 1;
  repository: string;
  tooling: HeartbeatTooling;
  entries: HeartbeatEntry[];
}

// Publication qualification, not caller input or a mutable tag, must populate this release-owned gate.
export const qualifiedHeartbeatTooling: Readonly<HeartbeatTooling> | undefined = undefined;

export function validateHeartbeatTooling(value: unknown): HeartbeatTooling {
  const tooling = exactRecord(value, ['cliVersion', 'archiveUrl', 'archiveSha256', 'checkoutAction'], 'Heartbeat tooling');
  if (!isTelemetryCliVersion(tooling.cliVersion) || tooling.cliVersion.includes('-') ||
      typeof tooling.archiveUrl !== 'string' ||
      !tooling.archiveUrl.startsWith(`https://github.com/voyager163/liftoff/releases/download/v${tooling.cliVersion}/`) ||
      !/^https:\/\/github\.com\/voyager163\/liftoff\/releases\/download\/v[0-9.]+\/[A-Za-z0-9._-]+\.tar\.gz$/u.test(tooling.archiveUrl) ||
      typeof tooling.archiveSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(tooling.archiveSha256) ||
      typeof tooling.checkoutAction !== 'string' || !/^actions\/checkout@[0-9a-f]{40}$/u.test(tooling.checkoutAction)) {
    throw new FileSystemError('Heartbeat tooling must name exact immutable candidate artifact/action identities; syntax alone is not publication qualification.');
  }
  return { cliVersion: tooling.cliVersion, archiveUrl: tooling.archiveUrl, archiveSha256: tooling.archiveSha256, checkoutAction: tooling.checkoutAction };
}

function rootParts(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32) throw new FileSystemError('Heartbeat root inventory is invalid.');
  const parts = value.length === 0 ? [] : validateArtifactPathParts(value, 'Heartbeat root');
  if (parts.some(part => !/^[A-Za-z0-9 ._-]+$/u.test(part)) || parts.join('/').length > 1024) {
    throw new FileSystemError('Heartbeat roots require literal portable paths without workflow expressions or shell syntax.');
  }
  return parts;
}

export function parseHeartbeatInventory(value: unknown): HeartbeatInventory {
  const inventory = exactRecord(value, ['schemaVersion', 'repository', 'tooling', 'entries'], 'Heartbeat inventory');
  if (inventory.schemaVersion !== 1 || typeof inventory.repository !== 'string' ||
      !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u.test(inventory.repository) ||
      !Array.isArray(inventory.entries) || inventory.entries.length > 128) throw new FileSystemError('Unsupported heartbeat inventory.');
  const roots = new Set<string>(), ids = new Set<string>();
  const entries = inventory.entries.map(value => {
    const entry = exactRecord(value, ['projectId', 'pathParts'], 'Heartbeat entry'), parts = rootParts(entry.pathParts);
    const root = parts.join('/').toLowerCase();
    if (!isProjectTelemetryId(entry.projectId) || roots.has(root) || ids.has(entry.projectId)) {
      throw new FileSystemError('Heartbeat roots and project IDs must be distinct exact entries.');
    }
    roots.add(root); ids.add(entry.projectId);
    return { projectId: entry.projectId, pathParts: parts };
  });
  return { schemaVersion: 1, repository: inventory.repository, tooling: validateHeartbeatTooling(inventory.tooling), entries };
}

export function renderHeartbeatEntry(entry: HeartbeatEntry, tooling: HeartbeatTooling, repository: string): string {
  const checked = parseHeartbeatInventory({ schemaVersion: 1, repository, tooling, entries: [entry] });
  const id = checked.entries[0].projectId, root = checked.entries[0].pathParts.join('/') || '.';
  return [
    `  # liftoff-heartbeat:${id}:begin`,
    `  project_${id.replaceAll('-', '_')}:`,
    '    runs-on: ubuntu-24.04',
    '    timeout-minutes: 5',
    '    permissions:',
    '      contents: read',
    `    if: github.repository == '${repository}'`,
    '    steps:',
    `      - uses: ${tooling.checkoutAction}`,
    '        with:',
    '          persist-credentials: false',
    '      - name: Verify the immutable runtime-inclusive CLI archive',
    '        shell: bash',
    '        run: |',
    '          set -euo pipefail',
    '          mkdir "$RUNNER_TEMP/liftoff-heartbeat"',
    `          curl --fail --location --proto '=https' --proto-redir '=https' --max-time 60 '${tooling.archiveUrl}' --output "$RUNNER_TEMP/liftoff-heartbeat/cli.tar.gz"`,
    `          printf '%s  %s\\n' '${tooling.archiveSha256}' "$RUNNER_TEMP/liftoff-heartbeat/cli.tar.gz" | sha256sum --check --strict`,
    '          tar -xzf "$RUNNER_TEMP/liftoff-heartbeat/cli.tar.gz" -C "$RUNNER_TEMP/liftoff-heartbeat"',
    '      - name: Report only the separately enabled project',
    '        shell: bash',
    '        env:',
    '          CI: "true"',
    '        run: |',
    '          set -euo pipefail',
    `          "$RUNNER_TEMP/liftoff-heartbeat/bin/liftoff" telemetry report '${root}' --heartbeat --json --repository '.'`,
    `  # liftoff-heartbeat:${id}:end`,
    ''
  ].join('\n');
}

export function renderHeartbeatWorkflow(inventory: HeartbeatInventory): string {
  const checked = parseHeartbeatInventory(inventory);
  return [
    'name: Liftoff monthly project observations', '',
    'on:', '  workflow_dispatch:', '  schedule:', '    - cron: "0 0 1 * *"', '',
    'permissions:', '  contents: read', '', 'jobs:', ''
  ].join('\n') + checked.entries.map(entry => renderHeartbeatEntry(entry, checked.tooling, checked.repository)).join('');
}

export function heartbeatWorkflowText(workflow: string | Buffer): string {
  if ((typeof workflow === 'string' ? Buffer.byteLength(workflow, 'utf8') : workflow.length) > 256 * 1024) {
    throw new FileSystemError('Heartbeat workflow exceeds its bounded size.');
  }
  const text = typeof workflow === 'string' ? workflow : workflow.toString('utf8');
  const bytes = Buffer.from(text, 'utf8');
  if (Buffer.isBuffer(workflow) ? !bytes.equals(workflow) : bytes.toString('utf8') !== text) {
    throw new FileSystemError('Heartbeat requires exact UTF-8 workflow bytes; custom content was not rewritten.');
  }
  const withoutCrlf = text.replaceAll('\r\n', '');
  if (withoutCrlf.includes('\r')) throw new FileSystemError('Heartbeat workflow has unsupported line endings.');
  if (text.includes('\r\n') && withoutCrlf.includes('\n')) {
    throw new FileSystemError('Heartbeat refuses mixed line endings rather than normalize custom bytes.');
  }
  return text;
}

export function updateHeartbeatEntry(
  value: HeartbeatInventory, source: string | Buffer, entry: HeartbeatEntry, operation: 'add' | 'remove'
): { inventory: HeartbeatInventory; workflow: string } {
  const inventory = parseHeartbeatInventory(value);
  const workflow = heartbeatWorkflowText(source);
  if (workflow.includes('\r\n')) {
    const updated = updateHeartbeatEntry(inventory, workflow.replaceAll('\r\n', '\n'), entry, operation);
    return { inventory: updated.inventory, workflow: updated.workflow.replaceAll('\n', '\r\n') };
  }
  for (const current of inventory.entries) {
    const section = renderHeartbeatEntry(current, inventory.tooling, inventory.repository);
    if (workflow.split(section).length !== 2) throw new FileSystemError('Heartbeat owned entry bytes changed or are ambiguous; custom workflow bytes were preserved.');
  }
  const index = inventory.entries.findIndex(current => current.projectId === entry.projectId &&
    JSON.stringify(current.pathParts) === JSON.stringify(entry.pathParts));
  if (operation === 'remove') {
    if (index < 0) throw new FileSystemError('The exact selected heartbeat entry is absent.');
    const section = renderHeartbeatEntry(inventory.entries[index], inventory.tooling, inventory.repository);
    return { inventory: { ...inventory, entries: inventory.entries.filter((_, i) => i !== index) }, workflow: workflow.replace(section, '') };
  }
  if (index >= 0) throw new FileSystemError('The selected heartbeat entry is already present.');
  const target = parseHeartbeatInventory({ ...inventory, entries: [...inventory.entries, entry] });
  const section = renderHeartbeatEntry(entry, inventory.tooling, inventory.repository);
  if (!/^jobs:\s*$/mu.test(workflow) || workflow.includes(`# liftoff-heartbeat:${entry.projectId}:`)) {
    throw new FileSystemError('Heartbeat insertion requires one explicit existing jobs boundary without a conflicting entry.');
  }
  if ((workflow.match(/^jobs:\s*$/gmu) ?? []).length !== 1) throw new FileSystemError('Heartbeat jobs boundary is ambiguous.');
  return { inventory: target, workflow: workflow.replace(/^(jobs:[ \t]*\n)/mu, `$1${section}`) };
}

export function heartbeatWorkflowDigest(workflow: string | Buffer): string {
  return createHash('sha256').update(heartbeatWorkflowText(workflow)).digest('hex');
}

export function heartbeatToolingMatches(left: HeartbeatTooling, right: HeartbeatTooling): boolean {
  return JSON.stringify(validateHeartbeatTooling(left)) === JSON.stringify(validateHeartbeatTooling(right));
}

export function validateHeartbeatWorkflow(inventory: HeartbeatInventory, workflow: string | Buffer): void {
  const checked = parseHeartbeatInventory(inventory);
  const normalized = heartbeatWorkflowText(workflow).replaceAll('\r\n', '\n');
  const header = renderHeartbeatWorkflow({ ...checked, entries: [] });
  if (!normalized.startsWith(header) || (normalized.match(/^jobs:[ \t]*$/gmu) ?? []).length !== 1) {
    throw new FileSystemError('Heartbeat monthly schedule, read-only permissions or jobs boundary changed.');
  }
  const markers = normalized.match(/^[ \t]*# liftoff-heartbeat:[^\n]*$/gmu) ?? [];
  if (markers.length !== checked.entries.length * 2) {
    throw new FileSystemError('Heartbeat owned entry markers are missing, foreign or ambiguous.');
  }
  for (const entry of checked.entries) {
    if (normalized.split(renderHeartbeatEntry(entry, checked.tooling, checked.repository)).length !== 2) {
      throw new FileSystemError('Heartbeat owned entry bytes changed or are ambiguous; custom workflow bytes were preserved.');
    }
  }
  if (!heartbeatWorkflowHasJobs(normalized)) throw new FileSystemError('Heartbeat workflow has no runnable jobs.');
}

export function heartbeatWorkflowHasJobs(workflow: string | Buffer): boolean {
  const document = parseDocument(heartbeatWorkflowText(workflow), { uniqueKeys: true });
  if (document.errors.length || document.warnings.length || !isMap(document.contents)) {
    throw new FileSystemError('Heartbeat workflow YAML is invalid or ambiguous; no raw contents were disclosed.');
  }
  const jobs = document.get('jobs', true);
  if (jobs === null || jobs === undefined || isScalar(jobs) && jobs.value === null) return false;
  if (!isMap(jobs)) {
    throw new FileSystemError('Heartbeat workflow jobs are invalid, aliased or ambiguous.');
  }
  const dependencies = new Map<string, Set<string>>();
  for (const item of jobs.items) {
    if (!isScalar(item.key) || typeof item.key.value !== 'string' ||
        !/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(item.key.value) || !isMap(item.value)) {
      throw new FileSystemError('Heartbeat workflow jobs are invalid, aliased or ambiguous.');
    }
    const needs = item.value.get('needs', true), references = needs === undefined ? [] : isSeq(needs) ? needs.items : [needs];
    const names = new Set<string>();
    for (const reference of references) {
      if (!isScalar(reference) || typeof reference.value !== 'string') {
        throw new FileSystemError('Heartbeat workflow job dependencies are invalid or aliased.');
      }
      names.add(reference.value);
    }
    dependencies.set(item.key.value, names);
  }
  const pending = new Map<string, number>(), dependents = new Map<string, string[]>();
  for (const [job, needs] of dependencies) {
    pending.set(job, needs.size);
    for (const required of needs) {
      if (!dependencies.has(required)) throw new FileSystemError('Heartbeat workflow job dependencies reference a missing job.');
      const next = dependents.get(required) ?? [];
      next.push(job); dependents.set(required, next);
    }
  }
  const ready = [...pending].filter(([, count]) => count === 0).map(([job]) => job);
  for (let index = 0; index < ready.length; index++) {
    for (const dependent of dependents.get(ready[index]) ?? []) {
      const count = pending.get(dependent)! - 1;
      pending.set(dependent, count);
      if (count === 0) ready.push(dependent);
    }
  }
  if (ready.length !== jobs.items.length) throw new FileSystemError('Heartbeat workflow job dependencies are cyclic.');
  return jobs.items.length > 0;
}

export function heartbeatReportingEntry(input: {
  inventory: HeartbeatInventory; workflow: string | Buffer; repository: string;
  selectedRoot: string[]; projectId: string; enabled: boolean; tooling: HeartbeatTooling;
}): HeartbeatEntry {
  const inventory = parseHeartbeatInventory(input.inventory);
  validateHeartbeatWorkflow(inventory, input.workflow);
  if (!input.enabled || inventory.repository !== input.repository || !heartbeatToolingMatches(inventory.tooling, input.tooling)) {
    throw new FileSystemError('Heartbeat enrollment, repository or exact release tooling does not match.');
  }
  const entry = inventory.entries.find(candidate =>
    JSON.stringify(candidate.pathParts) === JSON.stringify(input.selectedRoot) && candidate.projectId === input.projectId);
  if (!entry) throw new FileSystemError('The selected root has no separately enabled matching heartbeat entry.');
  return entry;
}
