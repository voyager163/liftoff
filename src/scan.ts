import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ApiStackId, ProjectOptions } from './domain/project/contracts.js';
import { goDependencyNames, nodeDependencyNames, pythonDependencyNames } from './domain/migration/dependencies.js';
import { excludesMigrationDirectory, needsMigrationPlacement } from './domain/migration/inventory.js';

export interface ScanFinding {
  kind:
    | 'python-deps'
    | 'node-deps'
    | 'go-deps'
    | 'go-source'
    | 'framework'
    | 'api-stack'
    | 'genai'
    | 'retrieval'
    | 'frontend'
    | 'env-file'
    | 'docker'
    | 'compose'
    | 'ci'
    | 'tests'
    | 'test-config'
    | 'github-config'
    | 'db-migrations'
    | 'spec-workflow'
    | 'cloud';
  evidence: string;
  sourcePath: string;
  value?: string;
}

export interface LegacyInventory {
  rootName: string;
  findings: ScanFinding[];
  unrecognized: string[];
  diagnostics?: Array<{ sourcePath: string; message: string }>;
}

export interface ScanDefault {
  field: string;
  value: string;
  evidence: string;
}

const COMPOSE_FILES = new Set(['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']);
const PYTHON_FRAMEWORKS = ['fastapi', 'flask', 'django'];
const RETRIEVAL_DEPS = new Set([
  'pgvector', 'chromadb', 'faiss', 'faiss-cpu', 'faiss-gpu',
  'pinecone', 'pinecone-client', 'qdrant', 'qdrant-client'
]);
const FRONTEND_DEPS = ['react', 'vue', 'next', 'svelte'];
const PYTHON_DEPENDENCY_FILES = new Set(['requirements.txt', 'pyproject.toml', 'setup.py', 'setup.cfg']);
const GO_API_MODULES = ['github.com/danielgtaylor/huma/v2', 'github.com/go-chi/chi'];

function hasGoApi(names: string[]): boolean {
  return names.some((name) => GO_API_MODULES.some((module) => name === module || name.startsWith(`${module}/`)));
}

async function readIfFile(root: string, name: string): Promise<string | undefined> {
  try {
    return await readFile(path.join(root, name), 'utf8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return undefined;
    throw error;
  }
}

async function findGoSources(root: string, parts: string[] = []): Promise<Array<{ sourcePath: string; content: string }>> {
  const directory = path.join(root, ...parts);
  const entries = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name === right.name ? 0 : left.name < right.name ? -1 : 1);
  const sources: Array<{ sourcePath: string; content: string }> = [];

  for (const entry of entries) {
    if (excludesMigrationDirectory(entry.name)) {
      continue;
    }
    const entryParts = [...parts, entry.name];
    if (entry.isDirectory()) {
      sources.push(...await findGoSources(root, entryParts));
    } else if (entry.isFile() && entry.name.endsWith('.go')) {
      sources.push({
        sourcePath: entryParts.join('/'),
        content: await readFile(path.join(root, ...entryParts), 'utf8')
      });
    }
  }
  return sources;
}

async function githubConfigurationPaths(root: string, parts: string[]): Promise<string[]> {
  const entries = (await readdir(path.join(root, ...parts), { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  if (!entries.length) return [parts.join('/')];
  const paths: string[] = [];
  for (const entry of entries) {
    if (excludesMigrationDirectory(entry.name)) continue;
    const child = [...parts, entry.name];
    paths.push(...(entry.isDirectory() ? await githubConfigurationPaths(root, child) : [child.join('/')]));
  }
  return paths;
}

export async function scanLegacyProject(sourceRoot: string): Promise<LegacyInventory> {
  const entries = (await readdir(sourceRoot, { withFileTypes: true }))
    .sort((left, right) => left.name === right.name ? 0 : left.name < right.name ? -1 : 1);
  const findings: ScanFinding[] = [];
  const diagnostics: NonNullable<LegacyInventory['diagnostics']> = [];
  const recognized = new Set<string>();
  const found = (name: string, finding: ScanFinding) => {
    recognized.add(name);
    findings.push(finding);
  };

  for (const entry of entries) {
    const name = entry.name;

    if (entry.isFile()) {
      if (PYTHON_DEPENDENCY_FILES.has(name)) {
        found(name, { kind: 'python-deps', evidence: `Python dependency file ${name}`, sourcePath: name });
        const parsed = pythonDependencyNames(name, (await readIfFile(sourceRoot, name)) ?? '');
        if (parsed.diagnostic) diagnostics.push({ sourcePath: name, message: parsed.diagnostic });
        const dependencies = new Set(parsed.names);
        for (const framework of PYTHON_FRAMEWORKS) {
          if (dependencies.has(framework)) {
            findings.push({ kind: 'framework', evidence: `${framework} in ${name}`, sourcePath: name });
            if (framework === 'fastapi') {
              findings.push({ kind: 'api-stack', value: 'python-fastapi', evidence: `fastapi in ${name}`, sourcePath: name });
            }
          }
        }
        if (dependencies.has('pydantic-ai') || dependencies.has('pydantic-ai-slim')) {
          findings.push({ kind: 'genai', value: 'genai', evidence: `PydanticAI dependency in ${name}`, sourcePath: name });
        }
        if (parsed.names.some((dependency) => RETRIEVAL_DEPS.has(dependency))) {
          findings.push({ kind: 'retrieval', evidence: `retrieval dependency in ${name}`, sourcePath: name });
        }
        if (parsed.names.some((dependency) => dependency.startsWith('azure-'))) {
          findings.push({ kind: 'cloud', evidence: `azure-* dependency in ${name}`, sourcePath: name });
        }
        continue;
      }
      if (name === 'package.json') {
        found(name, { kind: 'node-deps', evidence: 'package.json', sourcePath: name });
        const parsed = nodeDependencyNames((await readIfFile(sourceRoot, name)) ?? '');
        if (parsed.diagnostic) diagnostics.push({ sourcePath: name, message: parsed.diagnostic });
        const dependencies = new Set(parsed.names);
        if (dependencies.has('express')) {
          findings.push({ kind: 'framework', evidence: 'express in package.json', sourcePath: name });
        }
        if (dependencies.has('fastify')) {
          findings.push({ kind: 'framework', evidence: 'fastify in package.json', sourcePath: name });
          findings.push({ kind: 'api-stack', value: 'node-fastify', evidence: 'fastify in package.json', sourcePath: name });
        }
        if (FRONTEND_DEPS.some((dep) => dependencies.has(dep))) {
          findings.push({ kind: 'frontend', evidence: 'frontend framework in package.json', sourcePath: name });
        }
        continue;
      }
      if (name === 'go.mod') {
        found(name, { kind: 'go-deps', evidence: 'go.mod', sourcePath: name });
        const dependencies = goDependencyNames((await readIfFile(sourceRoot, name)) ?? '');
        if (hasGoApi(dependencies)) {
          findings.push({ kind: 'api-stack', value: 'go-huma', evidence: 'Huma or Chi dependency in go.mod', sourcePath: name });
        }
        if (dependencies.some((dependency) => dependency.toLowerCase().startsWith('github.com/azure/azure-sdk-for-go/'))) {
          findings.push({ kind: 'cloud', evidence: 'Azure SDK dependency in go.mod', sourcePath: name });
        }
        continue;
      }
      if (name.endsWith('.go')) {
        found(name, { kind: 'go-source', evidence: `Go source file ${name}`, sourcePath: name });
        const dependencies = goDependencyNames((await readIfFile(sourceRoot, name)) ?? '', true);
        if (hasGoApi(dependencies)) {
          findings.push({ kind: 'api-stack', value: 'go-huma', evidence: `Huma or Chi import in ${name}`, sourcePath: name });
        }
        continue;
      }
      if (name === '.env' || name.startsWith('.env.')) {
        found(name, { kind: 'env-file', evidence: `environment file ${name}`, sourcePath: name });
        continue;
      }
      if (name === 'Dockerfile') {
        found(name, { kind: 'docker', evidence: 'Dockerfile', sourcePath: name });
        continue;
      }
      if (COMPOSE_FILES.has(name)) {
        found(name, { kind: 'compose', evidence: name, sourcePath: name });
        continue;
      }
      if (name.endsWith('.bicep') || name.endsWith('.tf')) {
        found(name, { kind: 'cloud', evidence: `infrastructure file ${name}`, sourcePath: name });
        continue;
      }
      if (name === 'pytest.ini') {
        found(name, { kind: 'test-config', evidence: 'Python test configuration pytest.ini', sourcePath: name });
        continue;
      }
    }

    if (entry.isDirectory()) {
      if (name === '.github') {
        recognized.add(name);
        const children = (await readdir(path.join(sourceRoot, name), { withFileTypes: true }))
          .sort((left, right) => left.name.localeCompare(right.name, 'en'));
        if (!children.length) found(name, { kind: 'github-config', evidence: 'empty .github directory', sourcePath: name });
        for (const child of children) {
          if (excludesMigrationDirectory(child.name)) continue;
          const parts = [name, child.name];
          if (child.name === 'workflows' && child.isDirectory()) {
            found(name, { kind: 'ci', evidence: '.github/workflows', sourcePath: parts.join('/') });
          } else {
            const paths = child.isDirectory() ? await githubConfigurationPaths(sourceRoot, parts) : [parts.join('/')];
            for (const sourcePath of paths) found(name, { kind: 'github-config', evidence: `GitHub configuration ${sourcePath}`, sourcePath });
          }
        }
        continue;
      }
      if (name === 'tests' || name === 'test') {
        found(name, { kind: 'tests', evidence: `${name}/ directory`, sourcePath: name });
        continue;
      }
      if (name === 'alembic' || name === 'migrations') {
        found(name, { kind: 'db-migrations', evidence: `${name}/ directory`, sourcePath: name });
        continue;
      }
      if (name === 'openspec') {
        found(name, { kind: 'spec-workflow', evidence: 'existing openspec/ directory', sourcePath: name });
        continue;
      }
      if (name === '.specify') {
        found(name, { kind: 'spec-workflow', evidence: 'existing .specify/ directory', sourcePath: name });
        continue;
      }
      if (name === 'frontend') {
        found(name, { kind: 'frontend', evidence: 'frontend/ directory', sourcePath: name });
        continue;
      }
    }

  }

  if (recognized.has('go.mod')) {
    const existingGoSources = new Set(
      findings.filter((finding) => finding.kind === 'go-source').map((finding) => finding.sourcePath)
    );
    for (const source of await findGoSources(sourceRoot)) {
      if (existingGoSources.has(source.sourcePath)) {
        continue;
      }
      findings.push({ kind: 'go-source', evidence: `Go source file ${source.sourcePath}`, sourcePath: source.sourcePath });
      if (hasGoApi(goDependencyNames(source.content, true))) {
        findings.push({
          kind: 'api-stack',
          value: 'go-huma',
          evidence: `Huma or Chi import in ${source.sourcePath}`,
          sourcePath: source.sourcePath
        });
      }
    }
  }

  const unrecognized = entries
    .map((entry) => entry.name)
    .filter((name) => !recognized.has(name) && needsMigrationPlacement(name))
    .sort();

  return {
    rootName: path.basename(sourceRoot),
    findings,
    unrecognized,
    diagnostics
  };
}

export function scanDefaults(inventory: LegacyInventory): { options: ProjectOptions; provenance: ScanDefault[] } {
  const options: ProjectOptions = { projectName: inventory.rootName };
  const provenance: ScanDefault[] = [{ field: 'projectName', value: inventory.rootName, evidence: 'source directory name' }];
  const first = (kind: ScanFinding['kind']) => inventory.findings.find((finding) => finding.kind === kind);

  const frontend = first('frontend');
  if (frontend) {
    options.includeFrontend = true;
    provenance.push({ field: 'frontend', value: 'yes', evidence: frontend.evidence });
  }

  const spec = first('spec-workflow');
  if (spec) {
    options.specWorkflow = spec.evidence.includes('.specify') ? 'spec-kit' : 'openspec';
    provenance.push({ field: 'specWorkflow', value: options.specWorkflow, evidence: spec.evidence });
  }

  const cloud = first('cloud');
  if (cloud) {
    options.cloud = 'azure';
    provenance.push({ field: 'cloud', value: 'azure', evidence: cloud.evidence });
  }

  const retrieval = first('retrieval');
  const genai = first('genai');
  const stackFindings = inventory.findings.filter((finding) => finding.kind === 'api-stack' && finding.value);
  const stackIds = [...new Set(stackFindings.map((finding) => finding.value as ApiStackId))];
  const conflictingGenAiStack = Boolean(retrieval || genai) && stackIds.some((stackId) => stackId !== 'python-fastapi');
  if (conflictingGenAiStack) {
    provenance.push({
      field: 'projectType',
      value: 'unresolved',
      evidence: `conflicting GenAI and ${stackIds.filter((stackId) => stackId !== 'python-fastapi').join(', ')} evidence`
    });
  } else if (retrieval || genai) {
    options.projectType = 'genai';
    options.apiStack = 'python-fastapi';
    provenance.push({
      field: 'projectType',
      value: 'genai',
      evidence: (retrieval ?? genai)!.evidence
    });
    provenance.push({
      field: 'apiStack',
      value: 'python-fastapi',
      evidence: 'approved GenAI API stack'
    });
  } else if (stackIds.length === 1) {
    const stackFinding = stackFindings.find((finding) => finding.value === stackIds[0])!;
    options.projectType = 'standard';
    options.apiStack = stackIds[0];
    provenance.push({ field: 'projectType', value: 'standard', evidence: stackFinding.evidence });
    provenance.push({ field: 'apiStack', value: stackIds[0], evidence: stackFinding.evidence });
  } else if (stackIds.length > 1) {
    provenance.push({
      field: 'apiStack',
      value: 'unresolved',
      evidence: `conflicting evidence for ${stackIds.join(', ')}`
    });
  }

  if (retrieval && !conflictingGenAiStack) {
    options.pattern = 'rag';
    provenance.push({ field: 'pattern', value: 'rag', evidence: retrieval.evidence });
  }

  return { options, provenance };
}
