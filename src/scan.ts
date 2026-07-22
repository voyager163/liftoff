import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ApiStackId, ProjectOptions } from './types.js';

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
}

export interface ScanDefault {
  field: string;
  value: string;
  evidence: string;
}

// top-level entries that are derived/VCS state or self-explanatory project furniture -
// excluded from staging and never worth a placement decision
const IGNORED_ENTRIES = /^(\.git|node_modules|vendor|\.venv|venv|__pycache__|dist|build|\.next|\.DS_Store|\.gitignore|README.*|LICENSE.*)$/i;

const COMPOSE_FILES = new Set(['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']);
const PYTHON_FRAMEWORKS = ['fastapi', 'flask', 'django'];
const RETRIEVAL_DEPS = ['pgvector', 'chromadb', 'faiss', 'pinecone', 'qdrant'];
const FRONTEND_DEPS = ['react', 'vue', 'next', 'svelte'];

async function readIfFile(root: string, name: string): Promise<string | undefined> {
  try {
    return await readFile(path.join(root, name), 'utf8');
  } catch {
    return undefined;
  }
}

async function findGoSources(root: string, parts: string[] = []): Promise<Array<{ sourcePath: string; content: string }>> {
  const directory = path.join(root, ...parts);
  const entries = (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name === right.name ? 0 : left.name < right.name ? -1 : 1);
  const sources: Array<{ sourcePath: string; content: string }> = [];

  for (const entry of entries) {
    if (IGNORED_ENTRIES.test(entry.name)) {
      continue;
    }
    const entryParts = [...parts, entry.name];
    if (entry.isDirectory()) {
      sources.push(...await findGoSources(root, entryParts));
    } else if (entry.isFile() && entry.name.endsWith('.go')) {
      sources.push({
        sourcePath: entryParts.join('/'),
        content: (await readFile(path.join(root, ...entryParts), 'utf8')).toLowerCase()
      });
    }
  }
  return sources;
}

export async function scanLegacyProject(sourceRoot: string): Promise<LegacyInventory> {
  const entries = (await readdir(sourceRoot, { withFileTypes: true }))
    .sort((left, right) => left.name === right.name ? 0 : left.name < right.name ? -1 : 1);
  const findings: ScanFinding[] = [];
  const recognized = new Set<string>();
  const found = (name: string, finding: ScanFinding) => {
    recognized.add(name);
    findings.push(finding);
  };

  for (const entry of entries) {
    const name = entry.name;

    if (entry.isFile()) {
      if (name === 'requirements.txt' || name === 'pyproject.toml') {
        found(name, { kind: 'python-deps', evidence: `Python dependency file ${name}`, sourcePath: name });
        const content = ((await readIfFile(sourceRoot, name)) ?? '').toLowerCase();
        for (const framework of PYTHON_FRAMEWORKS) {
          if (content.includes(framework)) {
            findings.push({ kind: 'framework', evidence: `${framework} in ${name}`, sourcePath: name });
            if (framework === 'fastapi') {
              findings.push({ kind: 'api-stack', value: 'python-fastapi', evidence: `fastapi in ${name}`, sourcePath: name });
            }
          }
        }
        if (content.includes('pydantic-ai') || content.includes('pydantic_ai')) {
          findings.push({ kind: 'genai', value: 'genai', evidence: `PydanticAI dependency in ${name}`, sourcePath: name });
        }
        if (RETRIEVAL_DEPS.some((dep) => content.includes(dep))) {
          findings.push({ kind: 'retrieval', evidence: `retrieval dependency in ${name}`, sourcePath: name });
        }
        if (content.includes('azure-')) {
          findings.push({ kind: 'cloud', evidence: `azure-* dependency in ${name}`, sourcePath: name });
        }
        continue;
      }
      if (name === 'package.json') {
        found(name, { kind: 'node-deps', evidence: 'package.json', sourcePath: name });
        const content = ((await readIfFile(sourceRoot, name)) ?? '').toLowerCase();
        if (content.includes('"express"')) {
          findings.push({ kind: 'framework', evidence: 'express in package.json', sourcePath: name });
        }
        if (content.includes('"fastify"')) {
          findings.push({ kind: 'framework', evidence: 'fastify in package.json', sourcePath: name });
          findings.push({ kind: 'api-stack', value: 'node-fastify', evidence: 'fastify in package.json', sourcePath: name });
        }
        if (FRONTEND_DEPS.some((dep) => content.includes(`"${dep}"`))) {
          findings.push({ kind: 'frontend', evidence: 'frontend framework in package.json', sourcePath: name });
        }
        continue;
      }
      if (name === 'go.mod') {
        found(name, { kind: 'go-deps', evidence: 'go.mod', sourcePath: name });
        const content = ((await readIfFile(sourceRoot, name)) ?? '').toLowerCase();
        if (content.includes('huma/v2') || content.includes('go-chi/chi')) {
          findings.push({ kind: 'api-stack', value: 'go-huma', evidence: 'Huma or Chi dependency in go.mod', sourcePath: name });
        }
        if (content.includes('azure-sdk-for-go')) {
          findings.push({ kind: 'cloud', evidence: 'Azure SDK dependency in go.mod', sourcePath: name });
        }
        continue;
      }
      if (name.endsWith('.go')) {
        found(name, { kind: 'go-source', evidence: `Go source file ${name}`, sourcePath: name });
        const content = ((await readIfFile(sourceRoot, name)) ?? '').toLowerCase();
        if (content.includes('huma/v2') || content.includes('go-chi/chi')) {
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
      if (name === 'pytest.ini' || name === 'setup.cfg' || name === 'setup.py') {
        recognized.add(name);
        continue;
      }
    }

    if (entry.isDirectory()) {
      if (name === '.github') {
        found(name, { kind: 'ci', evidence: '.github/workflows', sourcePath: path.posix.join('.github', 'workflows') });
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
      recognized.add(source.sourcePath.split('/')[0]);
      findings.push({ kind: 'go-source', evidence: `Go source file ${source.sourcePath}`, sourcePath: source.sourcePath });
      if (source.content.includes('huma/v2') || source.content.includes('go-chi/chi')) {
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
    .filter((name) => !recognized.has(name) && !IGNORED_ENTRIES.test(name))
    .sort();

  return {
    rootName: path.basename(sourceRoot),
    findings,
    unrecognized
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
