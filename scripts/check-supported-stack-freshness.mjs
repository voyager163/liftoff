#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyFreshness,
  compareStableVersions,
  requireStableVersion,
  selectLatestCompatibleVersion,
  selectLatestNodeLts
} from './supported-stack-freshness.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const baseline = JSON.parse(
  await readFile(path.join(repositoryRoot, 'assets', 'supported-stack.json'), 'utf8')
);
const timeoutMs = 30_000;
const npmLatestRequests = new Map();
const npmCompatibleRequests = new Map();

async function fetchJson(url, label) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'voyager163-liftoff-baseline-check' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}.`);
  }
  return response.json();
}

async function npmLatest(name) {
  if (!npmLatestRequests.has(name)) {
    npmLatestRequests.set(name, (async () => {
      const encoded = encodeURIComponent(name);
      const value = await fetchJson(
        `https://registry.npmjs.org/${encoded}/latest`,
        `npm ${name}`
      );
      return requireStableVersion(value.version, `npm ${name}`);
    })());
  }
  return npmLatestRequests.get(name);
}

async function npmLatestCompatible(name, specifier) {
  const key = `${name}\0${specifier}`;
  if (!npmCompatibleRequests.has(key)) {
    npmCompatibleRequests.set(key, (async () => {
      const encoded = encodeURIComponent(name);
      const value = await fetchJson(
        `https://registry.npmjs.org/${encoded}`,
        `npm ${name}`
      );
      return selectLatestCompatibleVersion(Object.keys(value.versions ?? {}), specifier);
    })());
  }
  return npmCompatibleRequests.get(key);
}

async function pypiLatest(name) {
  const value = await fetchJson(`https://pypi.org/pypi/${name}/json`, `PyPI ${name}`);
  return requireStableVersion(value.info?.version, `PyPI ${name}`);
}

async function goLatest(name) {
  const value = await fetchJson(
    `https://proxy.golang.org/${name}/@latest`,
    `Go module ${name}`
  );
  return `v${requireStableVersion(value.Version, `Go module ${name}`)}`;
}

function command(executable, args, label) {
  const result = spawnSync(executable, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: timeoutMs,
    shell: false
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr.trim() || `exit ${result.status}`;
    throw new Error(
      `${label} failed: ${detail}`
    );
  }
  return result.stdout.trim();
}

const checks = [];
const add = (
  id,
  current,
  load,
  reviewedCandidate = undefined,
  selectionReason = undefined
) => checks.push({ id, current, load, reviewedCandidate, selectionReason });

add('runtime.node', baseline.runtimes.node.version, async () => {
  const releases = await fetchJson('https://nodejs.org/dist/index.json', 'Node.js releases');
  return selectLatestNodeLts(releases);
});
add('runtime.python', baseline.runtimes.python.version, async () => {
  const html = await (await fetch('https://www.python.org/downloads/', {
    signal: AbortSignal.timeout(timeoutMs)
  })).text();
  const match = html.match(/Download Python (\d+\.\d+\.\d+)/);
  if (!match) throw new Error('Python downloads page did not expose a stable release.');
  return requireStableVersion(match[1], 'Python');
});
add('runtime.go', baseline.runtimes.go.version, async () => {
  const releases = await fetchJson('https://go.dev/dl/?mode=json', 'Go releases');
  const latest = releases.find((release) => release.stable === true);
  return requireStableVersion(latest?.version, 'Go');
});
add('runtime.opentofu', baseline.runtimes.opentofu.version, async () => {
  const release = await fetchJson(
    'https://api.github.com/repos/opentofu/opentofu/releases/latest',
    'OpenTofu releases'
  );
  return requireStableVersion(release.tag_name, 'OpenTofu');
});
add('package-manager.npm', baseline.packageManagers.npm.version, () => npmLatest('npm'));
add('package-manager.uv', baseline.packageManagers.uv.version, () => pypiLatest('uv'));
add('framework.openspec', baseline.frameworks.openspec.version, () =>
  npmLatest('@fission-ai/openspec'));
add('framework.spec-kit', baseline.frameworks['spec-kit'].version, () =>
  pypiLatest('specify-cli'));

for (const [projectId, project] of Object.entries(baseline.npmProjects)) {
  for (const [groupName, requirements] of Object.entries(project.requirements)) {
    for (const [name, specifier] of Object.entries(requirements)) {
      const current = project.resolved[groupName][name];
      if (!current) {
        throw new Error(
          `Npm project ${projectId} does not record resolved dependency ${name}.`
        );
      }
      const exception = project.selectionExceptions?.[name];
      add(
        `npm.${projectId}.${name}`,
        current,
        () => project.freshnessPolicy === 'declared-range'
          ? npmLatestCompatible(name, specifier)
          : npmLatest(name),
        exception?.reviewedCandidateVersion,
        exception?.reason
      );
    }
  }
}

const pythonDependencies = new Map();
for (const project of Object.values(baseline.pythonProjects)) {
  for (const [name, current] of Object.entries(project.dependencies)) {
    pythonDependencies.set(name, current);
  }
  for (const group of Object.values(project.optionalDependencies)) {
    for (const [name, current] of Object.entries(group)) {
      pythonDependencies.set(name, current);
    }
  }
}
for (const [name, current] of pythonDependencies) {
  add(`pypi.${name}`, current, () => pypiLatest(name));
}

for (const [name, current] of Object.entries(
  baseline.goModules['go-backend'].dependencies
)) {
  add(`go.${name}`, current, () => goLatest(name));
}
for (const [name, current] of Object.entries(baseline.goModules['go-backend'].tools)) {
  add(`go.${name}`, current, () => goLatest(name));
}

for (const [name, provider] of Object.entries(baseline.opentofu.providers)) {
  add(`opentofu-provider.${name}`, provider.version, async () => {
    const response = await fetchJson(
      `https://registry.terraform.io/v1/providers/${provider.source}/versions`,
      `OpenTofu provider ${provider.source}`
    );
    const versions = response.versions
      .map((entry) => entry.version)
      .filter((value) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))
      .sort(compareStableVersions);
    if (versions.length === 0) {
      throw new Error(`OpenTofu provider ${provider.source} returned no stable versions.`);
    }
    return versions.at(-1);
  });
}

for (const [name, entry] of Object.entries(baseline.containers)) {
  add(`container.${name}`, entry.digest, async () => {
    const output = command(
      'docker',
      [
        'buildx',
        'imagetools',
        'inspect',
        `${entry.image}:${entry.tag}`,
        '--format',
        '{{json .Manifest}}'
      ],
      `Container ${entry.image}:${entry.tag}`
    );
    const manifest = JSON.parse(output);
    if (typeof manifest.digest !== 'string') {
      throw new Error(`Container ${entry.image}:${entry.tag} returned no digest.`);
    }
    const platforms = new Set(
      (manifest.manifests ?? []).map((item) =>
        `${item.platform?.os}/${item.platform?.architecture}`
      )
    );
    for (const platform of entry.platforms) {
      if (!platforms.has(platform)) {
        throw new Error(`Container ${entry.image}:${entry.tag} lacks ${platform}.`);
      }
    }
    return manifest.digest;
  });
}

for (const [name, action] of Object.entries(baseline.githubActions)) {
  add(`github-action.${name}`, action.commit, async () => {
    const output = command(
      'git',
      [
        'ls-remote',
        `https://github.com/${action.repository}.git`,
        `refs/tags/${action.ref}`,
        `refs/tags/${action.ref}^{}`
      ],
      `GitHub Action ${action.repository}@${action.ref}`
    );
    const lines = output.split(/\r?\n/).filter(Boolean);
    const peeled = lines.find((line) => line.endsWith('^{}'));
    const sha = (peeled ?? lines[0] ?? '').split(/\s+/)[0];
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error(`GitHub Action ${action.repository}@${action.ref} returned no commit.`);
    }
    return sha;
  });
}

add(
  'upstream.power-apps-code-app',
  baseline.upstreams['power-apps-code-app'].commit,
  async () => {
    const output = command(
      'git',
      ['ls-remote', `${baseline.upstreams['power-apps-code-app'].repository}.git`, 'refs/heads/main'],
      'Power Apps starter repository'
    );
    const sha = output.split(/\s+/)[0];
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error('Power Apps starter repository returned no main commit.');
    }
    return sha;
  }
);

const results = await Promise.all(checks.map(async (check) => {
  try {
    const candidate = await check.load();
    return {
      id: check.id,
      current: check.current,
      candidate,
      status: classifyFreshness(
        check.current,
        candidate,
        check.reviewedCandidate
      ),
      selectionReason: check.selectionReason
    };
  } catch (error) {
    return {
      id: check.id,
      current: check.current,
      status: 'error',
      error: error instanceof Error ? error.message : String(error)
    };
  }
}));

for (const result of results) {
  if (result.status === 'current') {
    process.stdout.write(`[current] ${result.id}: ${result.current}\n`);
  } else if (result.status === 'reviewed') {
    process.stdout.write(
      `[reviewed] ${result.id}: ${result.current}; excluded ${result.candidate}: ${result.selectionReason}\n`
    );
  } else if (result.status === 'stale') {
    process.stdout.write(`[stale] ${result.id}: ${result.current} -> ${result.candidate}\n`);
  } else {
    process.stderr.write(`[error] ${result.id}: ${result.error}\n`);
  }
}

if (results.some((result) => result.status !== 'current' && result.status !== 'reviewed')) {
  process.exitCode = 1;
}
