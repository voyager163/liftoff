import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProjectPlan } from '../src/planner.js';
import { buildArtifacts } from '../src/templates.js';

const repositoryRoot = process.cwd();

export interface TrackedReadmeEntry {
  path: string;
  canonicalSource: string;
  logicalId: string;
  role: string;
  owner: string;
  variants: string[];
  reviewStatus: string;
  reviewNotes: string;
  localLinks: string[];
}

export interface GeneratedReadmeEntry {
  logicalId: string;
  canonicalSource: string;
  rendererFunction?: string;
  assemblySource?: string;
  facadeSource?: string;
  policySource?: string;
  category: string;
  outputPaths: string[];
  supportedWorkloads?: string[];
  supportedApiStacks?: string[];
  supportedGenAiPatterns?: string[];
  supportedEnvironments?: string[];
  applicablePatterns?: string[];
  supportedGovernanceProfiles?: string[];
  conditionalLinks: Array<{ condition: string; target: string; description: string }>;
  reviewStatus: string;
  reviewNotes: string;
}

export interface ReadmeInventory {
  schemaVersion: number;
  trackedReadmes: TrackedReadmeEntry[];
  generatedReadmes: GeneratedReadmeEntry[];
}

export class ReadmeInventoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReadmeInventoryValidationError';
  }
}

export function validateReadmeInventory(raw: unknown): ReadmeInventory {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ReadmeInventoryValidationError('Inventory root must be a non-null object.');
  }

  const data = raw as Record<string, unknown>;

  if (data.schemaVersion !== 1) {
    throw new ReadmeInventoryValidationError(
      `Unsupported schemaVersion: expected 1, found ${String(data.schemaVersion)}.`
    );
  }

  if (!Array.isArray(data.trackedReadmes)) {
    throw new ReadmeInventoryValidationError('trackedReadmes must be an array.');
  }

  if (!Array.isArray(data.generatedReadmes)) {
    throw new ReadmeInventoryValidationError('generatedReadmes must be an array.');
  }

  const seenTrackedIds = new Set<string>();
  const seenTrackedPaths = new Set<string>();

  for (let i = 0; i < data.trackedReadmes.length; i++) {
    const entry = data.trackedReadmes[i] as Record<string, unknown>;
    if (typeof entry !== 'object' || entry === null) {
      throw new ReadmeInventoryValidationError(`trackedReadmes[${i}] must be an object.`);
    }

    for (const field of ['path', 'canonicalSource', 'logicalId', 'role', 'owner']) {
      if (typeof entry[field] !== 'string' || (entry[field] as string).trim() === '') {
        throw new ReadmeInventoryValidationError(
          `trackedReadmes[${i}].${field} must be a non-empty string.`
        );
      }
    }

    const entryPath = entry.path as string;
    if (entryPath.includes('..') || path.isAbsolute(entryPath)) {
      throw new ReadmeInventoryValidationError(
        `trackedReadmes[${i}].path must be a safe relative path, found: ${entryPath}.`
      );
    }

    const logicalId = entry.logicalId as string;
    if (seenTrackedIds.has(logicalId)) {
      throw new ReadmeInventoryValidationError(
        `Duplicate logicalId in trackedReadmes: ${logicalId}.`
      );
    }
    seenTrackedIds.add(logicalId);

    if (seenTrackedPaths.has(entryPath)) {
      throw new ReadmeInventoryValidationError(
        `Duplicate path in trackedReadmes: ${entryPath}.`
      );
    }
    seenTrackedPaths.add(entryPath);

    if (!Array.isArray(entry.variants) || entry.variants.length === 0) {
      throw new ReadmeInventoryValidationError(
        `trackedReadmes[${i}].variants must be a non-empty array of strings.`
      );
    }

    if (!Array.isArray(entry.localLinks)) {
      throw new ReadmeInventoryValidationError(
        `trackedReadmes[${i}].localLinks must be an array of strings.`
      );
    }
  }

  const seenGeneratedIds = new Set<string>();

  for (let i = 0; i < data.generatedReadmes.length; i++) {
    const entry = data.generatedReadmes[i] as Record<string, unknown>;
    if (typeof entry !== 'object' || entry === null) {
      throw new ReadmeInventoryValidationError(`generatedReadmes[${i}] must be an object.`);
    }

    for (const field of ['logicalId', 'canonicalSource', 'category']) {
      if (typeof entry[field] !== 'string' || (entry[field] as string).trim() === '') {
        throw new ReadmeInventoryValidationError(
          `generatedReadmes[${i}].${field} must be a non-empty string.`
        );
      }
    }

    const logicalId = entry.logicalId as string;
    if (seenGeneratedIds.has(logicalId)) {
      throw new ReadmeInventoryValidationError(
        `Duplicate logicalId in generatedReadmes: ${logicalId}.`
      );
    }
    seenGeneratedIds.add(logicalId);

    if (!Array.isArray(entry.outputPaths) || entry.outputPaths.length === 0) {
      throw new ReadmeInventoryValidationError(
        `generatedReadmes[${i}].outputPaths must be a non-empty array of strings.`
      );
    }

    if (typeof entry.reviewStatus !== 'string' || (entry.reviewStatus as string).trim() === '') {
      throw new ReadmeInventoryValidationError(
        `generatedReadmes[${i}].reviewStatus must be a non-empty string.`
      );
    }

    if (typeof entry.reviewNotes !== 'string' || (entry.reviewNotes as string).trim() === '') {
      throw new ReadmeInventoryValidationError(
        `generatedReadmes[${i}].reviewNotes must be a non-empty string.`
      );
    }

    if (!Array.isArray(entry.conditionalLinks)) {
      throw new ReadmeInventoryValidationError(
        `generatedReadmes[${i}].conditionalLinks must be an array.`
      );
    }
  }

  return raw as ReadmeInventory;
}

async function loadInventory(): Promise<ReadmeInventory> {
  const content = await readFile(path.join(repositoryRoot, 'assets/documentation/readme-inventory.json'), 'utf8');
  return validateReadmeInventory(JSON.parse(content));
}

describe('README inventory', () => {
  it('defines a valid schema version and structure', async () => {
    const inventory = await loadInventory();
    expect(inventory.schemaVersion).toBe(1);
    expect(Array.isArray(inventory.trackedReadmes)).toBe(true);
    expect(Array.isArray(inventory.generatedReadmes)).toBe(true);
  });

  it('inventories the exact known tracked README paths', async () => {
    const inventory = await loadInventory();
    const expectedPaths = [
      'README.md',
      'infrastructure/opentofu/bootstrap/README.md',
      'infrastructure/opentofu/telemetry/README.md',
      'src/application/state-migration/README.md'
    ];

    const actualPaths = inventory.trackedReadmes.map((entry) => entry.path).sort();
    expect(actualPaths).toEqual(expectedPaths.sort());

    for (const entry of inventory.trackedReadmes) {
      expect(entry.canonicalSource).toBe(entry.path);
      expect(entry.logicalId.length).toBeGreaterThan(0);
      expect(entry.role.length).toBeGreaterThan(0);
      expect(entry.owner.length).toBeGreaterThan(0);
      expect(entry.variants.length).toBeGreaterThan(0);
      // Ensure file exists on disk
      await access(path.join(repositoryRoot, entry.path));
    }
  });

  it('resolves all declared local links for tracked READMEs', async () => {
    const inventory = await loadInventory();
    for (const entry of inventory.trackedReadmes) {
      for (const target of entry.localLinks) {
        const resolved = path.resolve(repositoryRoot, target);
        try {
          await access(resolved);
        } catch {
          throw new Error(`Tracked README ${entry.path} declared link does not resolve: ${target}`);
        }
      }
    }
  });

  it('inventories all active generated README logical IDs and their canonical sources', async () => {
    const inventory = await loadInventory();
    const expectedLogicalIds = [
      'root-readme',
      'opentofu-readme',
      'functions-readme',
      'function-worker-readme',
      'pattern-prompt-readme',
      'repository-governance-guide'
    ];

    const actualLogicalIds = inventory.generatedReadmes.map((entry) => entry.logicalId).sort();
    expect(actualLogicalIds).toEqual(expectedLogicalIds.sort());

    for (const entry of inventory.generatedReadmes) {
      expect(entry.canonicalSource.length).toBeGreaterThan(0);
      expect(entry.category.length).toBeGreaterThan(0);
      expect(entry.outputPaths.length).toBeGreaterThan(0);
      expect(entry.reviewStatus).toBe('refreshed');
      expect(entry.reviewNotes.length).toBeGreaterThan(0);

      // Verify canonical source file exists and mentions the logical ID or renderer function
      const sourceContent = await readFile(path.join(repositoryRoot, entry.canonicalSource), 'utf8');
      if (entry.rendererFunction) {
        expect(sourceContent).toContain(entry.rendererFunction);
      } else {
        expect(sourceContent).toContain(entry.logicalId);
      }
    }
  });

  it('maps specific active generated logical IDs to their canonical implementation files', async () => {
    const inventory = await loadInventory();
    const byId = new Map(inventory.generatedReadmes.map((entry) => [entry.logicalId, entry]));

    expect(byId.get('root-readme')?.canonicalSource).toBe('src/generators/common/base.ts');
    expect(byId.get('opentofu-readme')?.canonicalSource).toBe('src/generators/infrastructure/azure.ts');
    expect(byId.get('functions-readme')?.canonicalSource).toBe('src/generators/genai/functions.ts');
    expect(byId.get('function-worker-readme')?.canonicalSource).toBe('src/generators/genai/functions.ts');
    expect(byId.get('pattern-prompt-readme')?.canonicalSource).toBe('src/generators/genai/patterns.ts');
    expect(byId.get('repository-governance-guide')?.canonicalSource).toBe(
      'src/application/repository-governance/agent-rendering.ts'
    );
    expect(byId.get('repository-governance-guide')?.assemblySource).toBe(
      'src/application/repository-governance/artifacts.ts'
    );
  });

  it('validates schema preconditions and rejects malformed inventory payloads', () => {
    expect(() => validateReadmeInventory(null)).toThrow(ReadmeInventoryValidationError);
    expect(() => validateReadmeInventory([])).toThrow(ReadmeInventoryValidationError);
    expect(() => validateReadmeInventory({ schemaVersion: 2 })).toThrow(
      'Unsupported schemaVersion: expected 1, found 2.'
    );
    expect(() => validateReadmeInventory({ schemaVersion: 1, trackedReadmes: 'not-array' })).toThrow(
      'trackedReadmes must be an array.'
    );
    expect(() =>
      validateReadmeInventory({
        schemaVersion: 1,
        trackedReadmes: [],
        generatedReadmes: 'not-array'
      })
    ).toThrow('generatedReadmes must be an array.');
  });

  it('rejects tracked README entries with missing fields or directory traversal', () => {
    expect(() =>
      validateReadmeInventory({
        schemaVersion: 1,
        trackedReadmes: [{ path: '', canonicalSource: 'x', logicalId: 'x', role: 'x', owner: 'x', variants: ['x'], localLinks: [] }],
        generatedReadmes: []
      })
    ).toThrow('trackedReadmes[0].path must be a non-empty string.');

    expect(() =>
      validateReadmeInventory({
        schemaVersion: 1,
        trackedReadmes: [{ path: '../escaped/README.md', canonicalSource: 'x', logicalId: 'x', role: 'x', owner: 'x', variants: ['x'], localLinks: [] }],
        generatedReadmes: []
      })
    ).toThrow('trackedReadmes[0].path must be a safe relative path');

    expect(() =>
      validateReadmeInventory({
        schemaVersion: 1,
        trackedReadmes: [
          { path: 'a.md', canonicalSource: 'a.md', logicalId: 'dup', role: 'x', owner: 'x', variants: ['x'], localLinks: [] },
          { path: 'b.md', canonicalSource: 'b.md', logicalId: 'dup', role: 'x', owner: 'x', variants: ['x'], localLinks: [] }
        ],
        generatedReadmes: []
      })
    ).toThrow('Duplicate logicalId in trackedReadmes: dup.');

    expect(() =>
      validateReadmeInventory({
        schemaVersion: 1,
        trackedReadmes: [
          { path: 'same.md', canonicalSource: 'same.md', logicalId: 'id1', role: 'x', owner: 'x', variants: ['x'], localLinks: [] },
          { path: 'same.md', canonicalSource: 'same.md', logicalId: 'id2', role: 'x', owner: 'x', variants: ['x'], localLinks: [] }
        ],
        generatedReadmes: []
      })
    ).toThrow('Duplicate path in trackedReadmes: same.md.');
  });

  it('rejects generated README entries with missing fields or duplicate logical IDs', () => {
    expect(() =>
      validateReadmeInventory({
        schemaVersion: 1,
        trackedReadmes: [],
        generatedReadmes: [{ logicalId: '', canonicalSource: 'x', category: 'x', outputPaths: ['x'], variants: ['x'], localLinks: [] }]
      })
    ).toThrow('generatedReadmes[0].logicalId must be a non-empty string.');

    expect(() =>
      validateReadmeInventory({
        schemaVersion: 1,
        trackedReadmes: [],
        generatedReadmes: [
          { logicalId: 'dup-gen', canonicalSource: 'a.ts', category: 'x', outputPaths: ['a'], conditionalLinks: [], reviewStatus: 'refreshed', reviewNotes: 'n' },
          { logicalId: 'dup-gen', canonicalSource: 'b.ts', category: 'x', outputPaths: ['b'], conditionalLinks: [], reviewStatus: 'refreshed', reviewNotes: 'n' }
        ]
      })
    ).toThrow('Duplicate logicalId in generatedReadmes: dup-gen.');

    expect(() =>
      validateReadmeInventory({
        schemaVersion: 1,
        trackedReadmes: [],
        generatedReadmes: [{ logicalId: 'gen1', canonicalSource: 'x', category: 'x', outputPaths: [], conditionalLinks: [], reviewStatus: 'refreshed', reviewNotes: 'n' }]
      })
    ).toThrow('generatedReadmes[0].outputPaths must be a non-empty array of strings.');
  });

  it('validates active generated README rendering across real project plans', () => {
    // 1. Standard application without governance: root-readme and opentofu-readme are emitted; no governance guide
    const standardUngovernedPlan = buildProjectPlan({
      projectName: 'standard-ungoverned',
      projectType: 'standard',
      apiStack: 'node-fastify',
      governanceProfile: 'none'
    }, { requireProjectName: true });
    const standardArtifacts = buildArtifacts(standardUngovernedPlan);
    expect(standardArtifacts.some((a) => a.logicalName === 'root-readme')).toBe(true);
    expect(standardArtifacts.some((a) => a.logicalName === 'opentofu-readme')).toBe(true);
    expect(standardArtifacts.some((a) => a.logicalName === 'repository-governance-guide')).toBe(false);
    expect(standardArtifacts.some((a) => a.logicalName === 'functions-readme')).toBe(false);
    expect(standardArtifacts.some((a) => a.logicalName === 'pattern-prompt-readme')).toBe(false);

    // 2. Standard application with governance: repository-governance-guide is emitted
    const standardGovernedPlan = buildProjectPlan({
      projectName: 'standard-governed',
      projectType: 'standard',
      apiStack: 'python-fastapi',
      governanceProfile: 'single-maintainer-gitflow'
    }, { requireProjectName: true });
    const governedArtifacts = buildArtifacts(standardGovernedPlan);
    expect(governedArtifacts.some((a) => a.logicalName === 'repository-governance-guide')).toBe(true);
    const govGuide = governedArtifacts.find((a) => a.logicalName === 'repository-governance-guide');
    expect(govGuide?.pathParts).toEqual(['.liftoff', 'governance', 'README.md']);

    // 3. GenAI application without worker (generic): pattern-prompt-readme emitted, no functions-readme
    const genAiGenericPlan = buildProjectPlan({
      projectName: 'genai-generic',
      projectType: 'genai',
      pattern: 'generic',
      cloud: 'azure'
    }, { requireProjectName: true });
    const genericArtifacts = buildArtifacts(genAiGenericPlan);
    expect(genericArtifacts.some((a) => a.logicalName === 'pattern-prompt-readme')).toBe(true);
    const promptReadme = genericArtifacts.find((a) => a.logicalName === 'pattern-prompt-readme');
    expect(promptReadme?.pathParts).toEqual(['backend', 'orchestration', 'prompts', 'README.md']);
    expect(genericArtifacts.some((a) => a.logicalName === 'functions-readme')).toBe(false);
    expect(genericArtifacts.some((a) => a.logicalName === 'function-worker-readme')).toBe(false);

    // 4. GenAI application with worker (rag): functions-readme and function-worker-readme emitted
    const genAiRagPlan = buildProjectPlan({
      projectName: 'genai-rag',
      projectType: 'genai',
      pattern: 'rag',
      cloud: 'azure'
    }, { requireProjectName: true });
    const ragArtifacts = buildArtifacts(genAiRagPlan);
    expect(ragArtifacts.some((a) => a.logicalName === 'functions-readme')).toBe(true);
    expect(ragArtifacts.some((a) => a.logicalName === 'function-worker-readme')).toBe(true);
    const funcReadme = ragArtifacts.find((a) => a.logicalName === 'functions-readme');
    expect(funcReadme?.pathParts).toEqual(['functions', 'README.md']);
    const workerReadme = ragArtifacts.find((a) => a.logicalName === 'function-worker-readme');
    expect(workerReadme?.pathParts).toEqual(['functions', 'rag-worker', 'README.md']);
  });

  it('ensures the tracked root README satisfies the line-count limit and baseline constraints', async () => {
    const readmeContent = await readFile(path.join(repositoryRoot, 'README.md'), 'utf8');
    const lines = readmeContent.split('\n');
    expect(lines.length).toBeLessThan(135);
    expect(readmeContent).not.toContain('Status: implemented');
    expect(readmeContent).toContain('Repair contract 1 is available in 0.12.3;');
    expect(readmeContent).toContain('unpublished native-only candidate');
    expect(readmeContent).toContain('channels remain release blockers');
  });
});
