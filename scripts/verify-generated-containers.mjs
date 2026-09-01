#!/usr/bin/env node
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import spawn from 'cross-spawn';
import { buildProjectPlan } from '../dist/planner.js';
import { buildArtifacts } from '../dist/templates.js';
import { writeArtifacts } from '../dist/file-system.js';

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'liftoff-container-verify-'));
const imageTags = [
  'liftoff-template-python:verify',
  'liftoff-template-node:verify',
  'liftoff-template-go:verify',
  'liftoff-template-frontend:verify',
  'liftoff-template-genai-worker:verify',
  'liftoff-template-genai-non-worker:verify',
  'liftoff-template-genai-generic:verify'
];

function run(args, cwd) {
  const result = spawn.sync('docker', args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: 20 * 60_000,
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `docker ${args.join(' ')} failed in ${cwd}\n` +
      `${result.error?.message ?? ''}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`
    );
  }
}

function safeRegistryEnvironment(name) {
  const configuredRegistry = process.env[name];
  if (configuredRegistry) {
    const parsed = new URL(configuredRegistry);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error(
        `${name} must not contain credentials, query parameters, or fragments.`
      );
    }
    return parsed.toString();
  }
  return undefined;
}

function buildArgs(tag, registryKind) {
  const registry = registryKind === 'npm'
    ? safeRegistryEnvironment('npm_config_registry')
    : registryKind === 'python'
      ? safeRegistryEnvironment('UV_DEFAULT_INDEX')
      : undefined;
  const buildArgument = registryKind === 'npm'
    ? `NPM_CONFIG_REGISTRY=${registry}`
    : `UV_DEFAULT_INDEX=${registry}`;
  return [
    'build',
    ...(registry ? ['--build-arg', buildArgument] : []),
    '--tag',
    tag,
    '.'
  ];
}

try {
  const plans = [
    {
      name: 'node',
      plan: buildProjectPlan({
        projectName: 'Container Node',
        projectType: 'standard',
        apiStack: 'node',
        cloud: 'azure'
      }, { requireProjectName: true }),
      builds: [{
        pathParts: [],
        tag: 'liftoff-template-node:verify',
        registryKind: 'npm'
      }]
    },
    {
      name: 'go',
      plan: buildProjectPlan({
        projectName: 'Container Go',
        projectType: 'standard',
        apiStack: 'go',
        cloud: 'azure'
      }, { requireProjectName: true }),
      builds: [{
        pathParts: [],
        tag: 'liftoff-template-go:verify'
      }]
    },
    {
      name: 'frontend',
      plan: buildProjectPlan({
        projectName: 'Container Frontend',
        projectType: 'standard',
        apiStack: 'node',
        cloud: 'azure',
        includeFrontend: true
      }, { requireProjectName: true }),
      builds: [{
        pathParts: ['frontend'],
        tag: 'liftoff-template-frontend:verify',
        registryKind: 'npm'
      }]
    },
    {
      name: 'python',
      plan: buildProjectPlan({
        projectName: 'Container Python',
        projectType: 'standard',
        apiStack: 'python',
        cloud: 'azure'
      }, { requireProjectName: true }),
      builds: [{
        pathParts: [],
        tag: 'liftoff-template-python:verify',
        registryKind: 'python'
      }]
    },
    {
      name: 'genai-worker',
      plan: buildProjectPlan({
        projectName: 'Container GenAI Worker',
        pattern: 'rag',
        cloud: 'azure'
      }, { requireProjectName: true }),
      builds: [{
        pathParts: [],
        tag: 'liftoff-template-genai-worker:verify',
        registryKind: 'python'
      }]
    },
    {
      name: 'genai-non-worker',
      plan: buildProjectPlan({
        projectName: 'Container GenAI Non Worker',
        pattern: 'chatbot',
        cloud: 'azure'
      }, { requireProjectName: true }),
      builds: [{
        pathParts: [],
        tag: 'liftoff-template-genai-non-worker:verify',
        registryKind: 'python'
      }]
    },
    {
      name: 'genai-generic',
      plan: buildProjectPlan({
        projectName: 'Container GenAI Generic',
        pattern: 'generic',
        cloud: 'azure'
      }, { requireProjectName: true }),
      builds: [{
        pathParts: [],
        tag: 'liftoff-template-genai-generic:verify',
        registryKind: 'python'
      }]
    }
  ];

  for (const entry of plans) {
    const projectRoot = path.join(tempRoot, entry.name);
    await writeArtifacts(projectRoot, buildArtifacts(entry.plan));
    run(['compose', 'config', '-q'], projectRoot);
    if (entry.plan.workload === 'genai') {
      run(['compose', '--profile', 'observability', 'config', '-q'], projectRoot);
    }
    for (const build of entry.builds) {
      run(
        buildArgs(build.tag, build.registryKind),
        path.join(projectRoot, ...build.pathParts)
      );
    }
  }
  console.log(
    'Generated Python, Node.js, Go, frontend, and worker/non-worker/generic GenAI containers verified.'
  );
} finally {
  for (const imageTag of imageTags) {
    spawn.sync('docker', ['image', 'rm', '--force', imageTag], {
      encoding: 'utf8',
      shell: false
    });
  }
  await rm(tempRoot, { recursive: true, force: true });
}
