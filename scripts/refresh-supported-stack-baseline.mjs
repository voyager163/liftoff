#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const baselinePath = path.join(repositoryRoot, 'assets', 'supported-stack.json');
const write = process.argv.includes('--write');

function sortRecord(value = {}) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right)
  ));
}

async function readJson(pathParts) {
  return JSON.parse(await readFile(path.join(repositoryRoot, ...pathParts), 'utf8'));
}

async function npmProject(
  manifestPathParts,
  lockPathParts = undefined,
  selectionExceptions = undefined,
  freshnessPolicy = 'latest'
) {
  const packageJson = await readJson(manifestPathParts);
  const resolvedLockPathParts = lockPathParts ?? [
    ...manifestPathParts.slice(0, -1),
    'package-lock.json'
  ];
  const lock = await readJson(resolvedLockPathParts);
  const direct = (group) => sortRecord(packageJson[group]);
  const resolved = (group) => Object.fromEntries(Object.keys(packageJson[group] ?? {})
    .sort()
    .map((name) => {
      const version = lock.packages?.[`node_modules/${name}`]?.version;
      if (typeof version !== 'string' || version.length === 0) {
        throw new Error(`${resolvedLockPathParts.join('/')} does not resolve direct dependency ${name}.`);
      }
      return [name, version];
    }));
  return {
    manifestPathParts,
    lockPathParts: resolvedLockPathParts,
    freshnessPolicy,
    requirements: {
      dependencies: direct('dependencies'),
      devDependencies: direct('devDependencies')
    },
    resolved: {
      dependencies: resolved('dependencies'),
      devDependencies: resolved('devDependencies')
    },
    ...(selectionExceptions ? { selectionExceptions } : {})
  };
}

const version = (value, minimumVersion, releaseLine, channel, source, selectionReason) => ({
  version: value,
  minimumVersion,
  releaseLine,
  channel,
  source,
  ...(selectionReason ? { selectionReason } : {})
});

const image = (name, tag, digest, source, selectionReason) => ({
  image: name,
  tag,
  digest,
  platforms: ['linux/amd64', 'linux/arm64'],
  source,
  ...(selectionReason ? { selectionReason } : {})
});

const baseline = {
  schemaVersion: 1,
  id: '2026.08.31',
  verifiedOn: '2026-08-31',
  supportedHostPlatforms: [
    'darwin/arm64',
    'darwin/x64',
    'linux/arm64',
    'linux/x64',
    'win32/x64'
  ],
  runtimes: {
    node: version('24.20.0', '24.20.0', '24', 'lts', 'https://nodejs.org/en/about/previous-releases'),
    python: version('3.14.7', '3.14.0', '3.14', 'stable', 'https://www.python.org/downloads/'),
    go: version('1.27.0', '1.27.0', '1.27', 'stable', 'https://go.dev/dl/'),
    opentofu: version('1.12.6', '1.12.6', '1.12', 'stable', 'https://github.com/opentofu/opentofu/releases/tag/v1.12.6')
  },
  packageManagers: {
    npm: version('12.0.2', '12.0.2', '12', 'stable', 'https://www.npmjs.com/package/npm'),
    uv: version('0.12.7', '0.12.7', '0.12', 'stable', 'https://github.com/astral-sh/uv/releases/tag/0.12.7')
  },
  frameworks: {
    openspec: version('1.11.0', '1.11.0', '1.11', 'stable', 'https://www.npmjs.com/package/@fission-ai/openspec'),
    'spec-kit': version('1.0.1', '1.0.1', '1.0', 'stable', 'https://pypi.org/project/specify-cli/1.0.1/')
  },
  npmProjects: {
    liftoff: await npmProject(['package.json'], ['package-lock.json']),
    'telemetry-ingest': await npmProject(['services', 'telemetry-ingest', 'package.json']),
    'node-backend': await npmProject(['assets', 'locks', 'node-backend', 'package.json']),
    frontend: await npmProject(['assets', 'locks', 'frontend', 'package.json']),
    'power-apps-code-app': await npmProject(
      [
        'assets',
        'power-apps-code-app',
        '3438c352483e40982f6c5c0fc36fd71f8e7adbbb',
        'starter',
        'package.json'
      ],
      undefined,
      {
        '@microsoft/power-apps': {
          selectedVersion: '1.2.7',
          reviewedCandidateVersion: '1.3.0',
          reason: 'Power Apps SDK 1.2.12 and newer remove the project-local power-apps CLI required by the current Liftoff workload contract; adopting the new global pa CLI requires a separate reviewed workload migration.'
        }
      },
      'declared-range'
    )
  },
  pythonProjects: {
    'genai-backend': {
      lockTemplatePathParts: ['assets', 'locks', 'python-genai', 'uv.lock'],
      requiresPython: '>=3.14,<3.15',
      dependencies: {
        alembic: '1.19.1',
        asyncpg: '0.31.0',
        'azure-communication-email': '1.1.0',
        'azure-identity': '1.25.3',
        'azure-servicebus': '7.14.3',
        'azure-storage-blob': '12.30.1',
        fastapi: '0.141.1',
        langfuse: '4.14.4',
        psycopg: '3.3.4',
        pydantic: '2.13.4',
        'pydantic-ai-slim': '2.33.0',
        'pydantic-settings': '2.15.0',
        redis: '8.1.0',
        'scalar-fastapi': '1.8.2',
        sqlalchemy: '2.0.52',
        uvicorn: '0.52.4'
      },
      optionalDependencies: {
        functions: { 'azure-functions': '2.3.0' },
        test: { httpx2: '2.12.0', pytest: '9.1.1' }
      }
    },
    'standard-backend': {
      lockTemplatePathParts: ['assets', 'locks', 'python-standard', 'uv.lock'],
      requiresPython: '>=3.14,<3.15',
      dependencies: {
        alembic: '1.19.1',
        asyncpg: '0.31.0',
        'azure-communication-email': '1.1.0',
        'azure-servicebus': '7.14.3',
        'azure-storage-blob': '12.30.1',
        fastapi: '0.141.1',
        psycopg: '3.3.4',
        pydantic: '2.13.4',
        'pydantic-settings': '2.15.0',
        redis: '8.1.0',
        'scalar-fastapi': '1.8.2',
        sqlalchemy: '2.0.52',
        uvicorn: '0.52.4'
      },
      optionalDependencies: {
        test: { httpx2: '2.12.0', pytest: '9.1.1' }
      }
    },
    'function-worker': {
      lockTemplatePathParts: ['assets', 'locks', 'python-genai', 'uv.lock'],
      requiresPython: '>=3.14,<3.15',
      dependencies: { 'azure-functions': '2.3.0' },
      optionalDependencies: { test: { pytest: '9.1.1' } }
    }
  },
  goModules: {
    'go-backend': {
      moduleTemplatePathParts: ['assets', 'locks', 'go-backend', 'go.mod'],
      goVersion: '1.27.0',
      dependencies: {
        'github.com/danielgtaylor/huma/v2': 'v2.39.1',
        'github.com/go-chi/chi/v5': 'v5.3.2',
        'github.com/jackc/pgx/v5': 'v5.10.0'
      },
      tools: {
        'github.com/pressly/goose/v3': 'v3.27.3'
      }
    }
  },
  opentofu: {
    version: version('1.12.6', '1.12.6', '1.12', 'stable', 'https://github.com/opentofu/opentofu/releases/tag/v1.12.6'),
    lockPlatforms: [
      'darwin_amd64',
      'darwin_arm64',
      'linux_amd64',
      'linux_arm64',
      'windows_amd64'
    ],
    providers: {
      azapi: { source: 'Azure/azapi', version: '2.12.0' },
      azurerm: { source: 'hashicorp/azurerm', version: '5.3.0' },
      time: { source: 'hashicorp/time', version: '0.14.1' }
    }
  },
  githubActions: {
    checkout: {
      repository: 'actions/checkout',
      ref: 'v7',
      commit: '3d3c42e5aac5ba805825da76410c181273ba90b1',
      source: 'https://github.com/actions/checkout/releases/tag/v7'
    },
    'setup-node': {
      repository: 'actions/setup-node',
      ref: 'v7',
      commit: '820762786026740c76f36085b0efc47a31fe5020',
      source: 'https://github.com/actions/setup-node/releases/tag/v7'
    },
    'setup-python': {
      repository: 'actions/setup-python',
      ref: 'v7',
      commit: '5fda3b95a4ea91299a34e894583c3862153e4b97',
      source: 'https://github.com/actions/setup-python/releases/tag/v7'
    },
    'setup-go': {
      repository: 'actions/setup-go',
      ref: 'v7',
      commit: 'b7ad1dad31e06c5925ef5d2fc7ad053ef454303e',
      source: 'https://github.com/actions/setup-go/releases/tag/v7'
    },
    'setup-opentofu': {
      repository: 'opentofu/setup-opentofu',
      ref: 'v2',
      commit: 'a1320f892987e89d278cc92dc5adc984fb93aca4',
      source: 'https://github.com/opentofu/setup-opentofu/releases/tag/v2'
    }
  },
  containers: {
    'python-runtime': image('python', '3.14-slim', 'sha256:cae66f2ef0ec51a9891263eeee7f987dacf0a9879e8aa9353d5606e0530619a5', 'https://hub.docker.com/_/python'),
    'uv-tool': image('ghcr.io/astral-sh/uv', '0.12.7', 'sha256:95f2aa1fe59274951cfe9b0cbc7972e879ff1004bc8945d130a32eb0dbd85945', 'https://github.com/astral-sh/uv/pkgs/container/uv'),
    'node-runtime': image('node', '24-alpine', 'sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf', 'https://hub.docker.com/_/node'),
    'go-build': image('golang', '1.27-alpine', 'sha256:4c9fe60190a2a3350ddc51de80d0224b8a6698d12bdfc999fee45ea9d6c46dbc', 'https://hub.docker.com/_/golang'),
    'alpine-runtime': image('alpine', '3.24', 'sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b', 'https://hub.docker.com/_/alpine'),
    'nginx-runtime': image('nginx', '1.30-alpine', 'sha256:97d490c12ba55b4946b01546d1c3ed324e8d41ab1c9fcb2a616aa470620e5b46', 'https://hub.docker.com/_/nginx'),
    postgres: image('postgres', '18-alpine', 'sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2', 'https://hub.docker.com/_/postgres'),
    pgvector: image('pgvector/pgvector', 'pg18', 'sha256:2ba9ca5f2e7daa0f0e7723cba1ee9167bab54efd3640516a44ac1a928dd67e7a', 'https://hub.docker.com/r/pgvector/pgvector'),
    redis: image('redis', '8-alpine', 'sha256:becdda6c7f4b3fb42e42fd7f120bbf5c54c4caaaf16f26da24e4563d2c1f0576', 'https://hub.docker.com/_/redis'),
    azurite: image('mcr.microsoft.com/azure-storage/azurite', '3.37.0', 'sha256:830430c1da1a2d537e08f3e6764dd1f5ae00cf0346bcaf625b968ec3f0971fd5', 'https://mcr.microsoft.com/v2/azure-storage/azurite/tags/list'),
    mailpit: image('axllent/mailpit', 'v1.31.0', 'sha256:c96991d9bef73594c246d89ca81411d4e916f03e76a7d2d72fa2ab5dd3c9ce24', 'https://hub.docker.com/r/axllent/mailpit'),
    'langfuse-web': image('langfuse/langfuse', '4', 'sha256:d9be058ee32564854bf54ff24a46603701bef96badecd95dab89c17b1d62171b', 'https://hub.docker.com/r/langfuse/langfuse'),
    'langfuse-worker': image('langfuse/langfuse-worker', '4', 'sha256:d4cbfe486b0eaaead437f8c5f626420b0275557bf7f89229e4edc8fc6683f01e', 'https://hub.docker.com/r/langfuse/langfuse-worker'),
    clickhouse: image('clickhouse/clickhouse-server', '25.12', 'sha256:8a790dd3468db22b1d4e7b18a176f378ff5ff6053b9c48dd4ea1fa71a24c5ba6', 'https://hub.docker.com/r/clickhouse/clickhouse-server'),
    minio: image('minio/minio', 'RELEASE.2025-09-07T16-13-09Z', 'sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e', 'https://hub.docker.com/r/minio/minio'),
    'container-apps-bootstrap': image('nginx', '1.30-alpine', 'sha256:97d490c12ba55b4946b01546d1c3ed324e8d41ab1c9fcb2a616aa470620e5b46', 'https://hub.docker.com/_/nginx', 'The previous Azure sample image publishes only a mutable latest tag; nginx stable serves an unauthenticated port-80 bootstrap endpoint with an immutable multi-architecture digest.'),
    'telemetry-node': image('node', '24-bookworm-slim', 'sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e', 'https://hub.docker.com/_/node')
  },
  upstreams: {
    'power-apps-code-app': {
      repository: 'https://github.com/microsoft/PowerAppsCodeApps',
      path: 'templates/starter',
      commit: '3438c352483e40982f6c5c0fc36fd71f8e7adbbb',
      compatibleSourceCommits: [
        '3438c352483e40982f6c5c0fc36fd71f8e7adbbb',
        '22e5c0bc0ef7ba516d9ad6281d6b0c4eb114df55'
      ],
      source: 'https://github.com/microsoft/PowerAppsCodeApps/commit/3438c352483e40982f6c5c0fc36fd71f8e7adbbb'
    }
  }
};

const output = `${JSON.stringify(baseline, null, 2)}\n`;
if (write) {
  await writeFile(baselinePath, output, 'utf8');
  process.stdout.write(`Wrote ${path.relative(repositoryRoot, baselinePath)}\n`);
} else {
  let current = '';
  try {
    current = await readFile(baselinePath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
  if (current !== output) {
    process.stdout.write(output);
    process.exitCode = 1;
  } else {
    process.stdout.write('Supported-stack baseline is current.\n');
  }
}
