import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type {
  AssessmentInventory,
  FileObservation,
  InventoryCategory,
  UnobservedScope
} from '../../../domain/standards-assessment/types.js';
import { containsSensitiveText, containsSourceCredentials, sanitizeText, sha256Hex } from '../../../domain/standards-assessment/sanitizer.js';
import { ObservedFileError } from '../observed-file.js';
import { AssessmentSnapshot, SnapshotLimitError } from './snapshot.js';
import { PathSafetyError } from './errors.js';
import { sourceObservationLimits } from '../source-observation-limits.js';

export interface ScannerOptions {
  maxFiles?: number;
  maxFileSize?: number;
  maxDepth?: number;
  maxScanBytes?: number;
  scanTimeoutMs?: number;
}

const DEFAULT_MAX_FILES = sourceObservationLimits.maxFiles;
const DEFAULT_MAX_FILE_SIZE = sourceObservationLimits.maxFileSize;
const DEFAULT_MAX_DEPTH = sourceObservationLimits.maxDepth;
const DEFAULT_MAX_SCAN_BYTES = sourceObservationLimits.maxScanBytes;
const DEFAULT_SCAN_TIMEOUT_MS = sourceObservationLimits.scanTimeoutMs;

const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  '.next',
  '.nuxt',
  'coverage'
]);

const PROTECTED_DIRECTORIES = new Set([
  '.liftoff', '.terraform', '.tofu', '.terragrunt-cache', 'terraform.tfstate.d',
  '.aws', '.azure', '.gcloud', '.kube', '.ssh', '.gnupg', '.docker', '.direnv',
  'credentials', '.credentials', 'secrets', '.secrets', 'state', 'states', '.state', 'tfstate'
]);

const PROTECTED_FILE_PATTERNS = [
  /^\.env(?!\.example$)(?:\..+)?$/i,
  /\.(?:pem|key|pfx|p12|pkcs12|asc|gpg)$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\..+)?$/i,
  /\.(?:tfstate|tfplan)(?:\..+)?$/i,
  /\.terraform(?:\.tfstate|\.tfplan)(?:\..+)?$/i,
  /^(?:credentials|\.credentials|secrets?)(?:\..+)?$/i,
  /\.pat$/i
];

export function isProtectedPayload(fileName: string): boolean {
  return PROTECTED_FILE_PATTERNS.some((pattern) => pattern.test(fileName)) ||
    /^(?:\.envrc|\.netrc|_netrc|\.npmrc|\.yarnrc(?:\.yml)?|\.pypirc|\.terraformrc|terraform\.rc|local\.settings\.json)$/iu.test(fileName) ||
    /\.(?:kdbx|sqlite3?|db)(?:\.|$)/iu.test(fileName);
}

export function categorizeFile(relativeParts: string[]): InventoryCategory {
  const fileName = relativeParts[relativeParts.length - 1];
  const relativePath = relativeParts.join('/');

  // Provenance
  if (fileName === 'liftoff.manifest.json') {
    return 'provenance';
  }

  // Framework & Agent markers
  if (
    relativeParts[0] === 'openspec' ||
    relativeParts[0] === '.specify' ||
    relativePath.startsWith('.github/skills') ||
    relativePath.startsWith('.claude/skills') ||
    relativePath.startsWith('.agents/skills')
  ) {
    return 'framework';
  }
  if (
    relativePath.startsWith('.github/prompts') ||
    relativePath.startsWith('.claude/commands')
  ) {
    return 'agent';
  }

  // CI/CD Workflows
  if (relativePath.startsWith('.github/workflows')) {
    return 'workflows';
  }

  // Infrastructure
  if (
    relativeParts[0] === 'infrastructure' ||
    fileName.endsWith('.tf') ||
    fileName.endsWith('.tfvars') ||
    fileName === '.terraform.lock.hcl'
  ) {
    return 'infrastructure';
  }

  // Containers
  if (
    fileName === 'Dockerfile' ||
    fileName.startsWith('Dockerfile.') ||
    fileName === 'docker-compose.yml' ||
    fileName === 'docker-compose.yaml' ||
    fileName.startsWith('docker-compose.') ||
    fileName === '.dockerignore'
  ) {
    return 'containers';
  }

  // Locks
  if (
    fileName === 'package-lock.json' ||
    fileName === 'uv.lock' ||
    fileName === 'poetry.lock' ||
    fileName === 'go.sum' ||
    fileName === 'pnpm-lock.yaml' ||
    fileName === 'yarn.lock'
  ) {
    return 'locks';
  }

  // Declarations
  if (
    fileName === 'package.json' ||
    fileName === 'pyproject.toml' ||
    fileName === 'requirements.txt' ||
    fileName.endsWith('-requirements.txt') ||
    fileName === 'go.mod'
  ) {
    return 'declarations';
  }

  // Build
  if (
    fileName === 'tsconfig.json' ||
    fileName.startsWith('tsconfig.') ||
    fileName === 'vite.config.ts' ||
    fileName === 'vite.config.js' ||
    fileName === 'drizzle.config.ts' ||
    fileName === 'alembic.ini' ||
    fileName.startsWith('tailwind.config.')
  ) {
    return 'build';
  }

  // Config
  if (
    fileName === 'liftoff.config.json' ||
    fileName === '.env.example' ||
    fileName.endsWith('.env')
  ) {
    return 'config';
  }

  // Tests
  if (
    relativeParts.some((p) => p === 'test' || p === 'tests' || p === '__tests__') ||
    fileName.includes('.test.') ||
    fileName.includes('.spec.') ||
    fileName.startsWith('test_') ||
    fileName.endsWith('_test.go')
  ) {
    return 'tests';
  }

  // Documentation
  if (
    fileName === 'README.md' ||
    fileName.endsWith('.md') ||
    relativeParts[0] === 'docs'
  ) {
    return 'docs';
  }

  // Source files default
  return 'source';
}

export interface InventorySnapshot {
  inventory: AssessmentInventory;
  assertCurrent(): Promise<boolean>;
}

export async function scanInventory(
  projectRoot: string,
  options: ScannerOptions = {}
): Promise<AssessmentInventory> {
  return (await scanInventorySnapshot(projectRoot, options)).inventory;
}

export async function scanInventorySnapshot(
  projectRoot: string,
  options: ScannerOptions = {}
): Promise<InventorySnapshot> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxScanBytes = options.maxScanBytes ?? DEFAULT_MAX_SCAN_BYTES;
  const scanTimeoutMs = options.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
  for (const [name, value, maximum] of [
    ['maxFiles', maxFiles, DEFAULT_MAX_FILES],
    ['maxFileSize', maxFileSize, DEFAULT_MAX_FILE_SIZE],
    ['maxDepth', maxDepth, DEFAULT_MAX_DEPTH],
    ['maxScanBytes', maxScanBytes, DEFAULT_MAX_SCAN_BYTES],
    ['scanTimeoutMs', scanTimeoutMs, DEFAULT_SCAN_TIMEOUT_MS]
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
      throw new PathSafetyError(`${name} must be an integer between 0 and ${maximum}.`);
    }
  }
  const startTime = Date.now();
  let accumulatedBytes = 0;
  const files: FileObservation[] = [];
  const unobserved: UnobservedScope[] = [];
  const protectedExclusions: string[] = [];
  const contentMap = new Map<string, string>();
  let limitsExceeded = false;
  let remainingEntries = sourceObservationLimits.maxEntries;
  const snapshot = await AssessmentSnapshot.create(projectRoot);
  const withinBudget = () => Date.now() - startTime < scanTimeoutMs;
  const mark = (relative: string, reason: UnobservedScope['reason'], message: string) => {
    if (!unobserved.some((entry) => entry.path === relative && entry.reason === reason)) {
      unobserved.push({ path: relative, reason, message });
    }
  };
  const limit = (relative: string, reason: UnobservedScope['reason'], message: string) => {
    limitsExceeded = true;
    mark(relative, reason, message);
  };
  const readFailure = (relative: string, error: unknown) => {
    if (error instanceof PathSafetyError || error instanceof ObservedFileError && error.failure === 'changed-file') {
      throw error;
    }
    if (error instanceof SnapshotLimitError) {
      limit(relative, error.reason, error.message);
      return;
    }
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    mark(relative, code === 'EACCES' || code === 'EPERM' ? 'permission_denied' :
      error instanceof ObservedFileError && error.failure === 'unsafe-file' ? 'unsupported_file_type' : 'unreadable',
    'The declared filesystem entry could not be safely observed; no content or compliance was inferred.');
  };

  async function walk(depth: number, relativeParts: string[]): Promise<void> {
    const relative = relativeParts.join('/') || '.';
    if (depth > maxDepth) {
      limit(relative, 'size_limit_exceeded', `Maximum scan depth of ${maxDepth} exceeded.`);
      return;
    }
    if (files.length >= maxFiles) {
      limit(relative, 'count_limit_exceeded', `Maximum file limit of ${maxFiles} reached.`);
      return;
    }
    if (!withinBudget()) {
      limit(relative, 'time_limit_exceeded', `Scan time budget (${scanTimeoutMs} ms) exceeded.`);
      return;
    }
    let entries;
    try {
      entries = await snapshot.list(relativeParts, remainingEntries, withinBudget);
      remainingEntries -= entries.length;
    } catch (error) {
      readFailure(relative, error);
      return;
    }
    for (const entry of entries) {
      const childParts = [...relativeParts, entry.name];
      const relativePath = childParts.join('/');
      if (files.length >= maxFiles) {
        limit(relativePath, 'count_limit_exceeded', `Maximum file limit of ${maxFiles} reached.`);
        return;
      }
      if (!withinBudget()) {
        limit(relativePath, 'time_limit_exceeded', `Scan time budget (${scanTimeoutMs} ms) exceeded.`);
        return;
      }
      if (isProtectedPayload(entry.name) || PROTECTED_DIRECTORIES.has(entry.name.toLowerCase()) || containsSensitiveText(relativePath)) {
        protectedExclusions.push(sanitizeText(relativePath, 1024));
        continue;
      }
      let stats;
      try {
        stats = await snapshot.inspect(childParts);
        if (!stats) throw new PathSafetyError('A directory entry disappeared during assessment.');
      } catch (error) {
        readFailure(relativePath, error);
        continue;
      }
      const currentKind = stats.isSymbolicLink() ? 'symlink' : stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other';
      if (currentKind !== entry.kind) throw new PathSafetyError('A directory entry changed type during assessment.');
      if (currentKind === 'directory') {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        if (entry.name === 'dist' || entry.name === 'build') {
          mark(relativePath, 'excluded_directory', 'Build/output directory contents are unobserved; custom source there is not assumed absent.');
          continue;
        }
        await walk(depth + 1, childParts);
        continue;
      }
      if (currentKind === 'symlink') {
        let target: string;
        try { target = await realpath(path.join(projectRoot, ...childParts)); }
        catch (error) { readFailure(relativePath, error); continue; }
        const relativeTarget = path.relative(projectRoot, target);
        if (relativeTarget === '..' || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) {
          throw new PathSafetyError(`Symlink '${relativePath}' escapes project root boundary.`);
        }
        mark(relativePath, 'unsupported_file_type', 'Linked content is unobserved; assessment never follows it for payload reads.');
        continue;
      }
      if (currentKind !== 'file' || stats.nlink !== 1) {
        mark(relativePath, 'unsupported_file_type', 'Special or multiply linked filesystem entry is unobserved.');
        continue;
      }
      if (stats.size > maxFileSize) {
        mark(relativePath, 'size_limit_exceeded', `File size exceeds the ${maxFileSize}-byte limit.`);
        continue;
      }
      if (accumulatedBytes + stats.size > maxScanBytes) {
        limit(relativePath, 'size_limit_exceeded', `Aggregate scan byte budget (${maxScanBytes} bytes) exceeded.`);
        return;
      }
      try {
        const { content, metadata } = await snapshot.read(childParts, Math.min(maxFileSize, maxScanBytes - accumulatedBytes));
        accumulatedBytes += content.length;
        const category = categorizeFile(childParts);
        let text: string | undefined;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(content);
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
          mark(relativePath, 'unsupported_file_type', 'Non-UTF-8 payload is inventoried by digest, not interpreted as source evidence.');
        }
        const sourceCode = /\.(?:[cm]?[jt]sx?|py|go|vue|tf|sh|ps1)$/iu.test(entry.name);
        if (text !== undefined && (sourceCode ? containsSourceCredentials(text) : containsSensitiveText(text))) {
          protectedExclusions.push(relativePath);
          mark(relativePath, 'unreadable', 'Credential-bearing content was withheld; no source evidence was inferred.');
          continue;
        }
        files.push({
          path: relativePath, category, size: content.length,
          digest: sha256Hex(content), modifiedTime: metadata.mtime.toISOString()
        });
        if (text !== undefined) contentMap.set(relativePath, text);
      } catch (error) {
        readFailure(relativePath, error);
      }
    }
  }

  await walk(0, []);
  const byCategory: Record<InventoryCategory, number> = {
    source: 0,
    declarations: 0,
    locks: 0,
    tests: 0,
    build: 0,
    config: 0,
    docs: 0,
    containers: 0,
    infrastructure: 0,
    workflows: 0,
    framework: 0,
    agent: 0,
    provenance: 0
  };

  for (const file of files) byCategory[file.category]++;
  const inventory: AssessmentInventory = {
    summary: {
      totalFiles: files.length, totalBytes: files.reduce((total, file) => total + file.size, 0), byCategory
    },
    files,
    unobserved,
    limits: {
      maxFiles,
      maxFileSize,
      maxDepth,
      maxScanBytes,
      scanTimeoutMs,
      exceeded: limitsExceeded
    },
    protectedExclusions,
    contentMap
  };
  const assertCurrent = async (): Promise<boolean> => {
    try {
      await snapshot.assertCurrent(withinBudget);
      return true;
    } catch (error) {
      if (!(error instanceof SnapshotLimitError)) throw error;
      limit('.', error.reason, 'The final bounded snapshot recheck is incomplete; source facts and recommendations are withheld.');
      inventory.limits.exceeded = true;
      for (const file of files) file.unstable = true;
      contentMap.clear();
      return false;
    } finally {
      files.sort((a, b) => a.path.localeCompare(b.path));
      unobserved.sort((a, b) => a.path.localeCompare(b.path));
      protectedExclusions.sort();
    }
  };
  await assertCurrent();
  return { inventory, assertCurrent };
}
