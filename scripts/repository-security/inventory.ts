import { createHash } from 'node:crypto';
import path from 'node:path';
import { portableParts, SecurityEvidenceError } from './evidence.ts';
import type { RegisteredWorkspace } from './workspace.ts';

interface Baseline {
  npmProjects: Record<string, { lockPathParts?: string[] }>;
  pythonProjects: Record<string, { lockTemplatePathParts: string[]; optionalDependencies: Record<string, unknown> }>;
  goModules: Record<string, { moduleTemplatePathParts: string[] }>;
  containers: Record<string, { image: string; digest: string; platforms: string[] }>;
}

export interface Graph {
  id: string;
  ecosystem: 'npm' | 'pypi' | 'go';
  pathParts: string[];
  extras: string[];
}

export interface GeneratedCase {
  id: string;
  options: {
    projectName: string;
    projectType?: string;
    apiStack?: string;
    pattern?: string;
    cloud: string;
    includeFrontend?: boolean;
    environments: string[];
  };
  requiredLanguages: string[];
  requiredArtifacts: string[];
}

const npmIds = {
  'liftoff-cli': 'liftoff', 'telemetry-ingest': 'telemetry-ingest',
  'node-backend': 'node-backend', 'standard-frontend': 'frontend'
};
const pythonIds = ['standard-backend', 'genai-backend', 'function-worker'];
const goIds = ['go-backend'];
export const committedIacRoots = [
  ['infrastructure', 'opentofu', 'bootstrap'],
  ['infrastructure', 'opentofu', 'telemetry'],
  ['assets', 'locks', 'opentofu-azure']
];
export const sourceRoots = [
  { id: 'cli', pathParts: ['src'], language: 'javascript-typescript' },
  { id: 'repository-tools', pathParts: ['scripts'], language: 'javascript-typescript' },
  { id: 'repository-security-python', pathParts: ['scripts', 'repository-security'], language: 'python' },
  { id: 'telemetry', pathParts: ['services', 'telemetry-ingest', 'src'], language: 'javascript-typescript' },
  { id: 'actions', pathParts: ['.github', 'workflows'], language: 'actions' }
];
export const packageSecurityInputs = [
  ['package.json'], ['README.md'], ['LICENSE'], ['dist', 'cli.js'], ['assets', 'supported-stack.json']
];
export const imageCases = [
  { id: 'node', generatedCase: 'standard-node', context: [], platform: 'linux/amd64' },
  { id: 'go', generatedCase: 'standard-go', context: [], platform: 'linux/amd64' },
  { id: 'frontend', generatedCase: 'standard-frontend', context: ['frontend'], platform: 'linux/amd64' },
  { id: 'python', generatedCase: 'standard-python', context: [], platform: 'linux/amd64' },
  { id: 'genai-worker', generatedCase: 'genai-rag', context: [], platform: 'linux/amd64' },
  { id: 'genai-non-worker', generatedCase: 'genai-chatbot', context: [], platform: 'linux/amd64' },
  { id: 'genai-generic', generatedCase: 'genai-generic', context: [], platform: 'linux/amd64' },
  { id: 'telemetry-ingest', generatedCase: null, context: ['services', 'telemetry-ingest'], platform: 'linux/amd64' }
];
export const generatedPatternIds = [
  'generic', 'rag', 'chatbot', 'agent', 'prompt', 'multi-agent', 'fine-tuned', 'streaming', 'workflow'
];
export const generatedStackIds = ['node', 'go', 'python'];
const languageForStack: Record<string, string> = { node: 'javascript-typescript', go: 'go', python: 'python' };
const lockForStack: Record<string, string> = { node: 'node-backend-lock', go: 'go-backend-checksums', python: 'backend-uv-lock' };

export const generatedSecurityCases: GeneratedCase[] = [
  ...generatedStackIds.map(stack => ({
    id: `standard-${stack}`,
    options: { projectName: `Security ${stack}`, projectType: 'standard', apiStack: stack, cloud: 'azure',
      environments: ['dev', 'staging', 'prod'] },
    requiredLanguages: [languageForStack[stack]!],
    requiredArtifacts: [lockForStack[stack]!, 'docker-compose', 'opentofu-application-main']
  })),
  {
    id: 'standard-frontend',
    options: { projectName: 'Security frontend', projectType: 'standard', apiStack: 'node', cloud: 'azure',
      includeFrontend: true, environments: ['dev', 'staging', 'prod'] },
    requiredLanguages: ['javascript-typescript'],
    requiredArtifacts: ['node-backend-lock', 'frontend-lock', 'docker-compose', 'opentofu-application-main']
  },
  ...generatedPatternIds.map(pattern => ({
    id: `genai-${pattern}`,
    options: { projectName: `Security ${pattern}`, pattern, cloud: 'azure',
      includeFrontend: true, environments: ['dev', 'staging', 'prod'] },
    requiredLanguages: ['python', 'javascript-typescript'],
    requiredArtifacts: ['backend-uv-lock', 'frontend-lock', 'docker-compose', 'opentofu-application-main']
  }))
];

function sameSet(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && new Set(actual).size === actual.length &&
    actual.every(item => expected.includes(item));
}

export function dependencyInventory(
  baseline: Baseline, npmInventory: readonly { id: string; pathParts: readonly string[] }[]
): Graph[] {
  if (!sameSet(Object.keys(baseline.npmProjects), Object.values(npmIds)) ||
      !sameSet(npmInventory.map(item => item.id), Object.keys(npmIds)) ||
      !sameSet(Object.keys(baseline.pythonProjects), pythonIds) ||
      !sameSet(Object.keys(baseline.goModules), goIds)) throw new SecurityEvidenceError('unmapped-dependency-graph');
  const graphs: Graph[] = npmInventory.map(entry => {
    const mapping = Object.entries(npmIds).find(([id]) => id === entry.id);
    if (!mapping) throw new SecurityEvidenceError('unmapped-npm-graph');
    const parts = portableParts(entry.pathParts);
    if (JSON.stringify(parts) !== JSON.stringify(baseline.npmProjects[mapping[1]]?.lockPathParts)) {
      throw new SecurityEvidenceError('npm-inventory-drift');
    }
    return { id: entry.id, ecosystem: 'npm', pathParts: parts, extras: [] };
  });
  for (const id of pythonIds) {
    const graph = baseline.pythonProjects[id]!;
    graphs.push({ id, ecosystem: 'pypi', pathParts: portableParts(graph.lockTemplatePathParts),
      extras: Object.keys(graph.optionalDependencies).sort() });
  }
  for (const id of goIds) {
    graphs.push({ id, ecosystem: 'go', pathParts: portableParts(baseline.goModules[id]!.moduleTemplatePathParts), extras: [] });
  }
  return graphs;
}

export function verifyInputInventory(graphs: readonly Graph[], observed: readonly (readonly string[])[]): void {
  if (graphs.length === 0) throw new SecurityEvidenceError('empty-dependency-inventory');
  const expected = new Set(graphs.map(graph => portableParts(graph.pathParts).join('/')));
  const actual = observed.map(parts => portableParts(parts).join('/'));
  if (!sameSet(actual, [...expected])) throw new SecurityEvidenceError('dependency-input-mismatch');
}

export function verifyRepositoryInventory(
  baseline: Baseline, npmInventory: readonly { id: string; pathParts: readonly string[] }[],
  trackedPaths: readonly (readonly string[])[]
): { graphs: Graph[]; sources: typeof sourceRoots; iac: typeof committedIacRoots; images: typeof imageCases } {
  const graphs = dependencyInventory(baseline, npmInventory);
  const files = trackedPaths.map(parts => portableParts(parts).join('/'));
  if (files.length === 0 || new Set(files.map(file => file.toLowerCase())).size !== files.length) {
    throw new SecurityEvidenceError('invalid-tracked-inventory');
  }
  const graphNames = ['package-lock.json', 'uv.lock', 'go.mod'];
  const actualGraphs = trackedPaths.filter(parts => graphNames.includes(parts.at(-1)!));
  verifyInputInventory(graphs, actualGraphs);
  for (const source of sourceRoots) {
    if (!files.some(file => file.startsWith(`${source.pathParts.join('/')}/`))) {
      throw new SecurityEvidenceError('missing-source-root');
    }
  }
  for (const parts of committedIacRoots) {
    if (!files.includes([...parts, 'versions.tf'].join('/')) ||
        !files.includes([...parts, '.terraform.lock.hcl'].join('/'))) {
      throw new SecurityEvidenceError('missing-committed-iac');
    }
  }
  if (!files.includes('services/telemetry-ingest/Dockerfile') ||
      !files.includes('assets/locks/go-backend/go.sum') ||
      !files.includes('assets/locks/python-genai/function-requirements.txt')) {
    throw new SecurityEvidenceError('missing-runtime-input');
  }
  if (!sameSet(generatedPatternIds, generatedSecurityCases.flatMap(entry =>
    entry.options.pattern ? [entry.options.pattern] : []))) throw new SecurityEvidenceError('missing-generated-pattern');
  return { graphs, sources: sourceRoots, iac: committedIacRoots, images: imageCases };
}

export interface GeneratedArtifactInput {
  logicalName: string;
  category: string;
  pathParts: string[];
  content: string;
}
export interface GeneratedInput {
  logicalName: string;
  pathParts: string[];
  digest: string;
  kind: 'javascript-typescript' | 'python' | 'go' | 'iac' | 'docker' | 'dependency' | 'supporting';
}

const languageExtensions: Record<string, GeneratedInput['kind']> = {
  '.ts': 'javascript-typescript', '.js': 'javascript-typescript', '.mjs': 'javascript-typescript',
  '.vue': 'javascript-typescript', '.py': 'python', '.go': 'go', '.tf': 'iac', '.tfvars': 'iac'
};
const dependencyNames = ['package.json', 'package-lock.json', 'pyproject.toml', 'uv.lock', 'go.mod', 'go.sum',
  'requirements.txt', '.terraform.lock.hcl'];
const generatedCategories = [
  'backend', 'backend-test', 'configuration', 'database', 'documentation', 'environment',
  'frontend', 'functions', 'functions-test', 'governance', 'infrastructure',
  'local-development', 'manifest', 'pattern', 'project', 'runtime', 'seed'
];
const securityCodeCategories = ['backend', 'backend-test', 'frontend', 'functions', 'functions-test', 'pattern', 'runtime'];
const supportingCodeExtensions = ['.json', '.jsonl', '.toml', '.lock', '.txt', '.html', '.css', '.md', '.yml', '.yaml', '.sql'];
const supportingCodeNames = ['Dockerfile', '.dockerignore', '.gitignore', '.funcignore', '.env.example', 'Makefile', 'go.mod', 'go.sum'];

export function generatedInputInventory(entry: GeneratedCase, artifacts: readonly GeneratedArtifactInput[]): GeneratedInput[] {
  if (artifacts.length === 0) throw new SecurityEvidenceError('empty-generation');
  const names = new Set<string>(), paths = new Set<string>();
  const inputs = artifacts.map(artifact => {
    if (!generatedCategories.includes(artifact.category)) throw new SecurityEvidenceError('unmapped-generated-category');
    const parts = portableParts(artifact.pathParts), key = parts.join('/').toLowerCase();
    if (names.has(artifact.logicalName) || paths.has(key)) throw new SecurityEvidenceError('duplicate-generated-input');
    names.add(artifact.logicalName); paths.add(key);
    const name = parts.at(-1)!, extension = path.posix.extname(name);
    let kind: GeneratedInput['kind'] = languageExtensions[extension] ?? 'supporting';
    if (dependencyNames.includes(name)) kind = 'dependency';
    if (name === 'Dockerfile' || name === 'docker-compose.yml') kind = 'docker';
    if (kind === 'supporting' && securityCodeCategories.includes(artifact.category) &&
        !supportingCodeExtensions.includes(extension) && !supportingCodeNames.includes(name)) {
      throw new SecurityEvidenceError('unmapped-generated-code');
    }
    return { logicalName: artifact.logicalName, pathParts: parts,
      digest: `sha256:${createHash('sha256').update(artifact.content).digest('hex')}`, kind };
  });
  if (entry.requiredArtifacts.some(name => !names.has(name)) ||
      entry.requiredLanguages.some(language => !inputs.some(input => input.kind === language))) {
    throw new SecurityEvidenceError('incomplete-generated-coverage');
  }
  return inputs;
}

export async function materializeSecurityCase(
  entry: GeneratedCase, artifacts: readonly GeneratedArtifactInput[], workspace: RegisteredWorkspace
): Promise<GeneratedInput[]> {
  const inputs = generatedInputInventory(entry, artifacts);
  for (const artifact of artifacts) await workspace.write([entry.id, ...artifact.pathParts], artifact.content);
  for (const artifact of artifacts) await workspace.verify([entry.id, ...artifact.pathParts], artifact.content);
  return inputs;
}
