import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'rolldown/parseAst';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function computeCanonicalJson(value) {
  if (value === undefined) {
    return 'null';
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => computeCanonicalJson(v)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${computeCanonicalJson(value[k])}`).join(',')}}`;
  }
  throw new Error('Unsupported canonical JSON type');
}

function computeProfileDigest(profile) {
  const capEntries = Object.entries(profile.capabilities)
    .filter(([_, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));

  const canonical = computeCanonicalJson({
    schemaVersion: profile.schemaVersion,
    id: profile.id,
    label: profile.label,
    revision: profile.revision,
    category: profile.category,
    targetWorkload: profile.targetWorkload,
    supported: profile.supported,
    componentBoundaries: [...profile.componentBoundaries].sort(),
    capabilities: Object.fromEntries(capEntries),
    evaluationCoverage: profile.evaluationCoverage.map((rule) => ({
      id: rule.id,
      description: rule.description,
      kind: rule.kind,
      mandatory: rule.mandatory
    })),
    ...(profile.requiredArtifacts && profile.requiredArtifacts.length > 0
      ? { requiredArtifacts: [...profile.requiredArtifacts].sort() }
      : {})
  });
  return `sha256:${sha256Hex(Buffer.from(canonical, 'utf8'))}`;
}

function computeProfileCatalogDigest(catalog) {
  const canonical = computeCanonicalJson({
    schemaVersion: catalog.schemaVersion,
    catalogId: catalog.catalogId,
    revision: catalog.revision,
    profiles: Object.fromEntries(
      Object.keys(catalog.profiles)
        .sort()
        .map((k) => {
          const p = catalog.profiles[k];
          const capEntries = Object.entries(p.capabilities)
            .filter(([_, v]) => v !== undefined)
            .sort(([a], [b]) => a.localeCompare(b));
          return [
            k,
            {
              schemaVersion: p.schemaVersion,
              id: p.id,
              label: p.label,
              revision: p.revision,
              digest: p.digest,
              category: p.category,
              targetWorkload: p.targetWorkload,
              supported: p.supported,
              componentBoundaries: [...p.componentBoundaries].sort(),
              capabilities: Object.fromEntries(capEntries),
              evaluationCoverage: p.evaluationCoverage,
              ...(p.requiredArtifacts && p.requiredArtifacts.length > 0
                ? { requiredArtifacts: [...p.requiredArtifacts].sort() }
                : {})
            }
          ];
        })
    ),
    unsupportedStacks: Object.fromEntries(
      Object.keys(catalog.unsupportedStacks)
        .sort()
        .map((k) => {
          const u = catalog.unsupportedStacks[k];
          return [
            k,
            {
              id: u.id,
              label: u.label,
              supported: u.supported,
              assessmentOnly: u.assessmentOnly,
              reason: u.reason,
              remedy: u.remedy
            }
          ];
        })
    )
  });
  return `sha256:${sha256Hex(Buffer.from(canonical, 'utf8'))}`;
}

function computeComponentDigest(component, catalogResources) {
  const canonical = computeCanonicalJson({
    id: component.id,
    label: component.label,
    category: component.category,
    revision: component.revision,
    dependencies: [...component.dependencies].sort(),
    resources: [...component.resources].sort().map((rId) => {
      const r = catalogResources[rId];
      return r
        ? {
            id: r.id,
            path: r.path,
            category: r.category,
            digest: r.digest,
            size: r.size,
            lifecycle: r.lifecycle
          }
        : rId;
    }),
    artifactLifecycles: Object.fromEntries(
      Object.keys(component.artifactLifecycles)
        .sort()
        .map((k) => [k, component.artifactLifecycles[k]])
    )
  });
  return `sha256:${sha256Hex(Buffer.from(canonical, 'utf8'))}`;
}

function computeTemplateCatalogDigest(catalog) {
  const canonical = computeCanonicalJson({
    schemaVersion: catalog.schemaVersion,
    catalogId: catalog.catalogId,
    revision: catalog.revision,
    components: Object.fromEntries(
      Object.keys(catalog.components)
        .sort()
        .map((k) => {
          const c = catalog.components[k];
          return [
            k,
            {
              id: c.id,
              label: c.label,
              category: c.category,
              revision: c.revision,
              digest: c.digest,
              dependencies: [...c.dependencies].sort(),
              resources: [...c.resources].sort(),
              artifactLifecycles: Object.fromEntries(
                Object.keys(c.artifactLifecycles).sort().map((ak) => [ak, c.artifactLifecycles[ak]])
              )
            }
          ];
        })
    ),
    resources: Object.fromEntries(
      Object.keys(catalog.resources)
        .sort()
        .map((k) => {
          const r = catalog.resources[k];
          return [
            k,
            {
              id: r.id,
              path: r.path,
              category: r.category,
              componentId: r.componentId,
              digest: r.digest,
              size: r.size,
              lifecycle: r.lifecycle,
              logicalName: r.logicalName,
              description: r.description
            }
          ];
        })
    ),
    retirements: catalog.retirements
      ? Object.fromEntries(
          Object.keys(catalog.retirements)
            .sort()
            .map((k) => {
              const ret = catalog.retirements[k];
              return [
                k,
                {
                  retiredLogicalName: ret.retiredLogicalName,
                  category: ret.category,
                  pathParts: ret.pathParts,
                  replacementLogicalName: ret.replacementLogicalName,
                  reason: ret.reason
                }
              ];
            })
        )
      : undefined
  });
  return `sha256:${sha256Hex(Buffer.from(canonical, 'utf8'))}`;
}

// 1. Build Standards Profiles Catalog
const standardRules = [
  { id: 'RULE-LIFTOFF-MANIFEST', description: 'Root manifest validation and lifecycle conformance', kind: 'marker', mandatory: true },
  { id: 'RULE-DEP-LOCK', description: 'Pinned lockfile presence and integrity verification', kind: 'dependency', mandatory: true },
  { id: 'RULE-API-HEALTH', description: 'Deterministic health endpoint returning status ok', kind: 'entrypoint', mandatory: true },
  { id: 'RULE-API-DOCS', description: 'Prefix-safe OpenAPI/Scalar documentation route', kind: 'routing', mandatory: true },
  { id: 'RULE-TEST-SUITE', description: 'Integrated automated test suite passing in private workspace', kind: 'test', mandatory: true },
  { id: 'RULE-CONT-COMPOSE', description: 'Multi-service container orchestration declaration', kind: 'docker', mandatory: true }
];

const genAiRules = [
  ...standardRules,
  { id: 'RULE-GENAI-MODEL-CONFIG', description: 'Deterministic model and provider configuration', kind: 'entrypoint', mandatory: true },
  { id: 'RULE-GENAI-PATTERN-CONTRACT', description: 'Honest pattern-specific implementation route', kind: 'routing', mandatory: true }
];

const vueRules = [
  { id: 'RULE-FRONTEND-PACKAGE', description: 'Frontend package.json and locked dependencies', kind: 'dependency', mandatory: true },
  { id: 'RULE-FRONTEND-ENTRY', description: 'Vue 3 main.ts and App.vue root component', kind: 'entrypoint', mandatory: true },
  { id: 'RULE-FRONTEND-BUILD', description: 'Vite and Tailwind CSS build configuration', kind: 'build', mandatory: true }
];

function canonicalPatternMetadata() {
  const filename = path.join(root, 'src/domain/project/catalog.ts');
  const source = parseAst(readFileSync(filename, 'utf8'), { lang: 'ts' }, filename);
  const declarations = [];
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.id.name === 'patterns') {
      declarations.push(node);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(source);
  if (declarations.length !== 1 || declarations[0].init?.type !== 'ArrayExpression') {
    throw new Error('Canonical project pattern metadata must be one explicit literal inventory.');
  }
  return declarations[0].init.elements.map((entry) => {
    if (entry?.type !== 'ObjectExpression') throw new Error('Pattern metadata must use explicit object declarations.');
    const literal = (name) => {
      const matches = entry.properties.filter((property) =>
        property.type === 'Property' && property.kind === 'init' && !property.computed && !property.method &&
        (property.key.type === 'Identifier' ? property.key.name : property.key.value) === name);
      if (matches.length !== 1) throw new Error(`Canonical pattern field ${name} is missing or duplicated.`);
      const value = matches[0].value;
      if (value.type === 'Literal' && ['string', 'boolean'].includes(typeof value.value)) return value.value;
      throw new Error(`Canonical pattern field ${name} requires an explicit string or boolean, not an inferred expression.`);
    };
    return {
      id: literal('id'), label: literal('label'), scaffoldStatus: literal('scaffoldStatus'),
      worker: literal('worker'), vectorStore: literal('requiresVectorStore')
    };
  });
}
const patternsMeta = canonicalPatternMetadata();

const profiles = {};

// Standard API profiles
const makeStandardProfile = (id, label, language, framework) => {
  const profileBase = {
    schemaVersion: 1,
    id,
    label,
    revision: '2026.09.01',
    category: 'backend',
    targetWorkload: 'standard',
    supported: true,
    componentBoundaries: ['backend'],
    capabilities: {
      backend: true,
      language,
      framework,
      cloud: 'azure',
      generationSupported: true,
      adoptionSupported: true,
      assessmentSupported: true
    },
    evaluationCoverage: standardRules
  };
  return {
    ...profileBase,
    digest: computeProfileDigest(profileBase)
  };
};

profiles['python-fastapi'] = makeStandardProfile(
  'python-fastapi',
  'Python / FastAPI Standard API',
  'python',
  'fastapi'
);

profiles['node-fastify'] = makeStandardProfile(
  'node-fastify',
  'Node.js / Fastify Standard API',
  'typescript',
  'fastify'
);

profiles['go-huma'] = makeStandardProfile(
  'go-huma',
  'Go / Huma Standard API',
  'go',
  'huma'
);

// Truthful Vue-only component profile
const vueBase = {
  schemaVersion: 1,
  id: 'vue-component',
  label: 'Vue 3 Component (Frontend Only)',
  revision: '2026.09.01',
  category: 'frontend',
  targetWorkload: 'component-only',
  supported: true,
  componentBoundaries: ['frontend'],
  capabilities: {
    backend: false,
    language: 'typescript',
    framework: 'vue',
    cloud: 'none',
    generationSupported: false,
    adoptionSupported: true,
    assessmentSupported: true
  },
  evaluationCoverage: vueRules
};
profiles['vue-component'] = {
  ...vueBase,
  digest: computeProfileDigest(vueBase)
};

// 9 Honest GenAI patterns
for (const p of patternsMeta) {
  const fullId = `genai-${p.id}`;
  const base = {
    schemaVersion: 1,
    id: fullId,
    label: `GenAI Pattern: ${p.label}`,
    revision: '2026.09.01',
    category: 'genai',
    targetWorkload: 'genai',
    supported: true,
    componentBoundaries: ['backend', 'orchestration'],
    capabilities: {
      backend: true,
      language: 'python',
      framework: 'fastapi',
      cloud: 'azure',
      generationSupported: true,
      adoptionSupported: true,
      assessmentSupported: true,
      pattern: p.id,
      scaffoldStatus: p.scaffoldStatus,
      vectorStore: p.vectorStore,
      worker: p.worker
    },
    evaluationCoverage: genAiRules
  };
  profiles[fullId] = {
    ...base,
    digest: computeProfileDigest(base)
  };
}

const unsupportedStacks = {
  express: {
    id: 'express',
    label: 'Express.js',
    supported: false,
    assessmentOnly: true,
    reason: 'Express is not an approved Liftoff API stack. Liftoff standardizes on Node.js Fastify for high-performance schema-validated APIs.',
    remedy: 'Run read-only standards assessment diagnostics. Liftoff does not perform automatic Express-to-Fastify migration.'
  },
  django: {
    id: 'django',
    label: 'Django',
    supported: false,
    assessmentOnly: true,
    reason: 'Django monolithic architecture is not a supported Liftoff standard API profile.',
    remedy: 'Run read-only standards assessment diagnostics. Liftoff uses FastAPI for asynchronous ASGI Python backends.'
  },
  flask: {
    id: 'flask',
    label: 'Flask',
    supported: false,
    assessmentOnly: true,
    reason: 'Flask is not an approved Liftoff standard API stack.',
    remedy: 'Run read-only standards assessment diagnostics. Liftoff standardizes on FastAPI with Pydantic.'
  },
  spring: {
    id: 'spring',
    label: 'Spring Boot (Java / Kotlin)',
    supported: false,
    assessmentOnly: true,
    reason: 'Java/Spring Boot is outside the supported Liftoff runtime matrix.',
    remedy: 'Assessment only. Liftoff supports Python, Node.js, and Go backends.'
  },
  aspnetcore: {
    id: 'aspnetcore',
    label: 'ASP.NET Core (C# / .NET)',
    supported: false,
    assessmentOnly: true,
    reason: '.NET / ASP.NET Core is outside the supported Liftoff runtime matrix.',
    remedy: 'Assessment only. Liftoff supports Python, Node.js, and Go backends.'
  },
  rails: {
    id: 'rails',
    label: 'Ruby on Rails',
    supported: false,
    assessmentOnly: true,
    reason: 'Ruby on Rails is not a supported Liftoff standards profile.',
    remedy: 'Assessment only.'
  },
  nextjs: {
    id: 'nextjs',
    label: 'Next.js Full-Stack',
    supported: false,
    assessmentOnly: true,
    reason: 'Next.js server-side fullstack framework is not supported for Liftoff API backend generation.',
    remedy: 'Assessment only. Liftoff separates headless APIs (FastAPI/Fastify/Huma) from single-page Vue components.'
  },
  remix: {
    id: 'remix',
    label: 'Remix',
    supported: false,
    assessmentOnly: true,
    reason: 'Remix is not a supported Liftoff standards profile.',
    remedy: 'Assessment only.'
  },
  angular: {
    id: 'angular',
    label: 'Angular',
    supported: false,
    assessmentOnly: true,
    reason: 'Angular is not a supported Liftoff frontend framework.',
    remedy: 'Assessment only. Liftoff standardizes on Vue 3 with Vite.'
  },
  svelte: {
    id: 'svelte',
    label: 'Svelte / SvelteKit',
    supported: false,
    assessmentOnly: true,
    reason: 'Svelte is not a supported Liftoff frontend framework.',
    remedy: 'Assessment only. Liftoff standardizes on Vue 3 with Vite.'
  },
  'power-apps-code-app': {
    id: 'power-apps-code-app',
    label: 'Power Apps Code App (Retired)',
    supported: false,
    assessmentOnly: true,
    reason: 'Power Apps code app workload is retired and unsupported by Liftoff. Choose a GenAI or standard API workload.',
    remedy: 'Power Apps workload is retired. No conversion, generation, or adoption is permitted.'
  }
};

const profileCatalogBase = {
  schemaVersion: 1,
  catalogId: 'liftoff-standards-profiles',
  revision: '2026.09.01',
  profiles,
  unsupportedStacks
};

const profileCatalog = {
  ...profileCatalogBase,
  digest: computeProfileCatalogDigest(profileCatalogBase)
};

writeFileSync(
  path.join(root, 'assets/profiles/catalog.json'),
  `${JSON.stringify(profileCatalog, null, 2)}\n`,
  'utf8'
);
console.log('Wrote assets/profiles/catalog.json');

// 2. Build Template & Resource Catalog
function inspectFile(relPath) {
  const fullPath = path.join(root, relPath);
  const buf = readFileSync(fullPath);
  return {
    path: relPath,
    size: buf.length,
    digest: `sha256:${sha256Hex(buf)}`
  };
}

const resources = {};

function addResource(id, relPath, category, componentId, lifecycle = 'managed-core', desc = '') {
  const info = inspectFile(relPath);
  resources[id] = {
    id,
    path: relPath,
    category,
    componentId,
    digest: info.digest,
    size: info.size,
    lifecycle,
    description: desc
  };
}

// Common base resources
addResource('templates.common.dockerignore', 'assets/templates/components/common/dockerignore.txt', 'template', 'common-base', 'project', 'Default container build ignore patterns');
addResource('templates.common.gitignore', 'assets/templates/components/common/gitignore.txt', 'template', 'common-base', 'project', 'Default version control ignore patterns');
addResource('baselines.supported-stack', 'assets/supported-stack.json', 'baseline', 'common-base', 'managed-core', 'Release supported-stack runtime and tooling baseline');

// Frontend resources
addResource('templates.frontend.styles', 'assets/templates/components/frontend/styles.css', 'template', 'frontend-vue', 'project', 'Tailwind CSS style entrypoint');
addResource('templates.frontend.main', 'assets/templates/components/frontend/main.ts', 'template', 'frontend-vue', 'project', 'Vue 3 application bootstrapping');
addResource('templates.frontend.vite-config', 'assets/templates/components/frontend/vite.config.ts', 'template', 'frontend-vue', 'project', 'Vite build tool configuration');
addResource('templates.frontend.tailwind-config', 'assets/templates/components/frontend/tailwind.config.ts', 'template', 'frontend-vue', 'project', 'Tailwind CSS configuration');
addResource('templates.frontend.env-example', 'assets/templates/components/frontend/env.example', 'template', 'frontend-vue', 'project', 'Frontend environment example');
addResource('templates.frontend.dockerignore', 'assets/templates/components/frontend/dockerignore.txt', 'template', 'frontend-vue', 'project', 'Frontend container ignore patterns');
addResource('locks.frontend.package-json', 'assets/locks/frontend/package.json', 'lock', 'frontend-vue', 'project', 'Frontend dependencies declaration');
addResource('locks.frontend.package-lock', 'assets/locks/frontend/package-lock.json', 'lock', 'frontend-vue', 'project', 'Frontend pinned npm lockfile');

// Python standard backend
addResource('locks.python-standard.pyproject', 'assets/locks/python-standard/pyproject.toml', 'lock', 'backend-python-fastapi', 'project', 'Standard Python dependencies');
addResource('locks.python-standard.uv-lock', 'assets/locks/python-standard/uv.lock', 'lock', 'backend-python-fastapi', 'project', 'Standard Python pinned uv lockfile');

// Node standard backend
addResource('locks.node-backend.package-json', 'assets/locks/node-backend/package.json', 'lock', 'backend-node-fastify', 'project', 'Fastify backend dependencies');
addResource('locks.node-backend.package-lock', 'assets/locks/node-backend/package-lock.json', 'lock', 'backend-node-fastify', 'project', 'Fastify backend pinned npm lockfile');

// Go standard backend
addResource('locks.go-backend.go-mod', 'assets/locks/go-backend/go.mod', 'lock', 'backend-go-huma', 'project', 'Go module definition');
addResource('locks.go-backend.go-sum', 'assets/locks/go-backend/go.sum', 'lock', 'backend-go-huma', 'project', 'Go module checksums');

// GenAI common
addResource('locks.python-genai.pyproject', 'assets/locks/python-genai/pyproject.toml', 'lock', 'genai-common', 'project', 'GenAI backend dependencies');
addResource('locks.python-genai.uv-lock', 'assets/locks/python-genai/uv.lock', 'lock', 'genai-common', 'project', 'GenAI backend pinned uv lockfile');
addResource('locks.python-genai.function-requirements', 'assets/locks/python-genai/function-requirements.txt', 'lock', 'genai-common', 'project', 'Azure Functions worker requirements');

// Infrastructure OpenTofu
addResource('locks.opentofu-azure.versions', 'assets/locks/opentofu-azure/versions.tf', 'lock', 'infrastructure-azure-opentofu', 'project', 'OpenTofu pinned Azure providers');
addResource('locks.opentofu-azure.provider-lock', 'assets/locks/opentofu-azure/.terraform.lock.hcl', 'lock', 'infrastructure-azure-opentofu', 'project', 'OpenTofu provider lockfile');

// Governance
addResource('governance.single-maintainer-gitflow.policy', 'assets/governance/single-maintainer-gitflow/policy.md', 'governance', 'governance-single-maintainer-gitflow', 'managed-core', 'Single Maintainer GitFlow governance policy');
addResource('governance.single-maintainer-gitflow.activation-v2-graph', 'assets/governance/single-maintainer-gitflow/activation-v2-graph.json', 'governance', 'governance-single-maintainer-gitflow', 'managed-core', 'Activation v2 phase graph');
addResource('governance.single-maintainer-gitflow.assessment-controls', 'assets/governance/single-maintainer-gitflow/assessment-controls.json', 'governance', 'governance-single-maintainer-gitflow', 'managed-core', 'Governance assessment controls');

// Repair
addResource('repair.windows.job-controller', 'assets/repair/windows-job-controller.ps1', 'repair', 'repair-windows', 'managed-core', 'Windows job object process controller script');

// Canonical Skills
addResource('skills.catalog', 'assets/skills/catalog.json', 'skill', 'canonical-skills', 'managed-core', 'Canonical agent skills catalog');
addResource('skills.setup', 'assets/skills/setup/SKILL.md', 'skill', 'canonical-skills', 'managed-core', 'Liftoff setup skill definition');
addResource('skills.assess', 'assets/skills/assess/SKILL.md', 'skill', 'canonical-skills', 'managed-core', 'Liftoff assessment skill definition');
addResource('skills.init', 'assets/skills/init/SKILL.md', 'skill', 'canonical-skills', 'managed-core', 'Liftoff initialization skill definition');
addResource('skills.adopt', 'assets/skills/adopt/SKILL.md', 'skill', 'canonical-skills', 'managed-core', 'Liftoff adoption skill definition');
addResource('skills.update', 'assets/skills/update/SKILL.md', 'skill', 'canonical-skills', 'managed-core', 'Liftoff update skill definition');
addResource('skills.repair', 'assets/skills/repair/SKILL.md', 'skill', 'canonical-skills', 'managed-core', 'Liftoff repair skill definition');
addResource('skills.azure', 'assets/skills/azure/SKILL.md', 'skill', 'canonical-skills', 'managed-core', 'Liftoff Azure skill definition');
addResource('skills.governance', 'assets/skills/governance/SKILL.md', 'skill', 'canonical-skills', 'managed-core', 'Liftoff governance skill definition');
addResource('skills.governance-assess', 'assets/skills/governance-assess/SKILL.md', 'skill', 'canonical-skills', 'managed-core', 'Liftoff governance assessment skill definition');
addResource('skills.cli-upgrade', 'assets/skills/cli-upgrade/SKILL.md', 'skill', 'canonical-skills', 'managed-core', 'Liftoff CLI upgrade skill definition');
addResource('skills.migrate', 'assets/skills/migrate/SKILL.md', 'skill', 'canonical-skills', 'managed-core', 'Liftoff migration skill definition');

const components = {
  'common-base': {
    id: 'common-base',
    label: 'Common Base Template Components',
    category: 'common',
    revision: '2026.09.01',
    dependencies: ['baselines.supported-stack'],
    resources: [
      'templates.common.dockerignore',
      'templates.common.gitignore',
      'baselines.supported-stack'
    ],
    artifactLifecycles: {
      'root-readme': 'project',
      'root-gitignore': 'project',
      'root-dockerignore': 'project',
      'env-example': 'project',
      'liftoff-config': 'desired-state',
      'docker-compose': 'project',
      'liftoff-repair-copilot': 'managed-core',
      'liftoff-repair-claude': 'managed-core',
      'liftoff-repair-codex': 'managed-core'
    }
  },
  'frontend-vue': {
    id: 'frontend-vue',
    label: 'Reusable Vue 3 Frontend Component',
    category: 'frontend',
    revision: '2026.09.01',
    dependencies: ['locks.frontend.package-lock'],
    resources: [
      'templates.frontend.styles',
      'templates.frontend.main',
      'templates.frontend.vite-config',
      'templates.frontend.tailwind-config',
      'templates.frontend.env-example',
      'templates.frontend.dockerignore',
      'locks.frontend.package-json',
      'locks.frontend.package-lock'
    ],
    artifactLifecycles: {
      'frontend-package': 'project',
      'frontend-lock': 'project',
      'frontend-index': 'project',
      'frontend-main': 'project',
      'frontend-app': 'project',
      'frontend-env-example': 'project',
      'frontend-styles': 'project',
      'frontend-vite-config': 'project',
      'frontend-tailwind-config': 'project',
      'frontend-dockerfile': 'project',
      'frontend-dockerignore': 'project'
    }
  },
  'backend-python-fastapi': {
    id: 'backend-python-fastapi',
    label: 'FastAPI Python Backend Component',
    category: 'backend',
    revision: '2026.09.01',
    dependencies: ['locks.python-standard.uv-lock'],
    resources: [
      'locks.python-standard.pyproject',
      'locks.python-standard.uv-lock'
    ],
    artifactLifecycles: {
      'backend-pyproject': 'project',
      'backend-uv-lock': 'project',
      'backend-dockerfile': 'project',
      'backend-package': 'project',
      'backend-api-package': 'project',
      'backend-main': 'project',
      'backend-routes-package': 'project',
      'backend-health-routes': 'project',
      'backend-config-package': 'project',
      'backend-settings': 'project',
      'backend-auth-dependency': 'project',
      'backend-observability-package': 'project',
      'backend-observability': 'project',
      'backend-test-health': 'project',
      'database-alembic-ini': 'project',
      'database-alembic-env': 'project',
      'database-schema': 'project',
      'database-initial-migration': 'project'
    }
  },
  'backend-node-fastify': {
    id: 'backend-node-fastify',
    label: 'Fastify Node.js Backend Component',
    category: 'backend',
    revision: '2026.09.01',
    dependencies: ['locks.node-backend.package-lock'],
    resources: [
      'locks.node-backend.package-json',
      'locks.node-backend.package-lock'
    ],
    artifactLifecycles: {
      'node-backend-package': 'project',
      'node-backend-lock': 'project',
      'node-backend-tsconfig': 'project',
      'node-backend-app': 'project',
      'node-backend-server': 'project',
      'node-backend-routes-package': 'project',
      'node-backend-health-routes': 'project',
      'node-backend-config': 'project',
      'node-backend-vitest-config': 'project',
      'node-backend-test-health': 'project',
      'backend-dockerfile': 'project',
      'node-backend-drizzle-config': 'project',
      'node-backend-database': 'project',
      'node-backend-schema': 'project',
      'database-node-migration': 'project',
      'database-node-migration-journal': 'project',
      'database-node-migration-snapshot': 'project',
      'database-schema': 'project'
    }
  },
  'backend-go-huma': {
    id: 'backend-go-huma',
    label: 'Go / Huma Backend Component',
    category: 'backend',
    revision: '2026.09.01',
    dependencies: ['locks.go-backend.go-sum'],
    resources: [
      'locks.go-backend.go-mod',
      'locks.go-backend.go-sum'
    ],
    artifactLifecycles: {
      'go-backend-module': 'project',
      'go-backend-checksums': 'project',
      'go-backend-main': 'project',
      'go-backend-api': 'project',
      'go-backend-routes': 'project',
      'go-backend-config': 'project',
      'go-backend-test-health': 'project',
      'backend-dockerfile': 'project',
      'go-backend-database': 'project',
      'go-backend-makefile': 'project',
      'go-runtime-config-example': 'project',
      'go-backend-migration-command': 'project',
      'database-go-migration': 'project',
      'database-schema': 'project'
    }
  },
  'genai-common': {
    id: 'genai-common',
    label: 'GenAI Common Backend Component',
    category: 'genai',
    revision: '2026.09.01',
    dependencies: ['locks.python-genai.uv-lock'],
    resources: [
      'locks.python-genai.pyproject',
      'locks.python-genai.uv-lock',
      'locks.python-genai.function-requirements'
    ],
    artifactLifecycles: {
      'backend-pyproject': 'project',
      'backend-uv-lock': 'project',
      'backend-dockerfile': 'project',
      'backend-main': 'project',
      'backend-routes-package': 'project',
      'backend-health-routes': 'project',
      'backend-pattern-routes': 'project',
      'backend-config-package': 'project',
      'backend-settings': 'project',
      'backend-model-config': 'project',
      'backend-messaging-tool': 'project',
      'backend-auth-dependency': 'project',
      'backend-observability-package': 'project',
      'backend-observability': 'project',
      'backend-orchestration-package': 'project',
      'backend-tools-package': 'project',
      'backend-package': 'project',
      'backend-api-package': 'project',
      'backend-test-health': 'project',
      'backend-test-messaging': 'project',
      'backend-test-tracing': 'project',
      'database-alembic-ini': 'project',
      'database-alembic-env': 'project',
      'database-schema': 'project',
      'database-initial-migration': 'project',
      'functions-readme': 'project',
      'function-worker-app': 'project',
      'function-worker-funcignore': 'project',
      'function-worker-gitignore': 'project',
      'function-worker-host': 'project',
      'function-worker-local-settings': 'project',
      'function-worker-readme': 'project',
      'function-worker-requirements': 'project',
      'function-worker-test': 'project'
    }
  },
  'genai-generic': {
    id: 'genai-generic',
    label: 'GenAI Generic Pattern Component',
    category: 'genai',
    revision: '2026.09.01',
    dependencies: ['locks.python-genai.uv-lock'],
    resources: ['locks.python-genai.uv-lock'],
    artifactLifecycles: {
      'pattern-agent': 'project',
      'pattern-agent-package': 'project',
      'pattern-agent-test': 'project',
      'pattern-prompt': 'project',
      'pattern-prompt-readme': 'project'
    }
  },
  'genai-rag': {
    id: 'genai-rag',
    label: 'GenAI RAG Pattern Component',
    category: 'genai',
    revision: '2026.09.01',
    dependencies: ['locks.python-genai.uv-lock'],
    resources: ['locks.python-genai.uv-lock'],
    artifactLifecycles: {
      'rag-vector-store': 'project',
      'rag-retrieval-package': 'project',
      'pattern-agent': 'project',
      'pattern-agent-package': 'project',
      'pattern-agent-test': 'project',
      'pattern-prompt': 'project',
      'pattern-prompt-readme': 'project',
      'pattern-worker': 'project',
      'backend-workers-package': 'project'
    }
  },
  'genai-chatbot': {
    id: 'genai-chatbot',
    label: 'GenAI Chatbot Pattern Component',
    category: 'genai',
    revision: '2026.09.01',
    dependencies: ['locks.python-genai.uv-lock'],
    resources: ['locks.python-genai.uv-lock'],
    artifactLifecycles: {
      'pattern-agent': 'project',
      'pattern-agent-package': 'project',
      'pattern-agent-test': 'project',
      'pattern-prompt': 'project',
      'pattern-prompt-readme': 'project'
    }
  },
  'genai-agent': {
    id: 'genai-agent',
    label: 'GenAI Autonomous Agent Pattern Component',
    category: 'genai',
    revision: '2026.09.01',
    dependencies: ['locks.python-genai.uv-lock'],
    resources: ['locks.python-genai.uv-lock'],
    artifactLifecycles: {
      'pattern-agent': 'project',
      'pattern-agent-package': 'project',
      'pattern-agent-test': 'project',
      'pattern-prompt': 'project',
      'pattern-prompt-readme': 'project',
      'pattern-worker': 'project',
      'backend-workers-package': 'project'
    }
  },
  'genai-prompt': {
    id: 'genai-prompt',
    label: 'GenAI Prompt Pipeline Pattern Component',
    category: 'genai',
    revision: '2026.09.01',
    dependencies: ['locks.python-genai.uv-lock'],
    resources: ['locks.python-genai.uv-lock'],
    artifactLifecycles: {
      'pattern-agent': 'project',
      'pattern-agent-package': 'project',
      'pattern-agent-test': 'project',
      'pattern-prompt': 'project',
      'pattern-prompt-readme': 'project'
    }
  },
  'genai-multi-agent': {
    id: 'genai-multi-agent',
    label: 'GenAI Multi-Agent Pattern Component',
    category: 'genai',
    revision: '2026.09.01',
    dependencies: ['locks.python-genai.uv-lock'],
    resources: ['locks.python-genai.uv-lock'],
    artifactLifecycles: {
      'pattern-agent': 'project',
      'pattern-agent-package': 'project',
      'pattern-agent-test': 'project',
      'pattern-prompt': 'project',
      'pattern-prompt-readme': 'project',
      'pattern-worker': 'project',
      'backend-workers-package': 'project'
    }
  },
  'genai-fine-tuned': {
    id: 'genai-fine-tuned',
    label: 'GenAI Fine-Tuned Model Pattern Component',
    category: 'genai',
    revision: '2026.09.01',
    dependencies: ['locks.python-genai.uv-lock'],
    resources: ['locks.python-genai.uv-lock'],
    artifactLifecycles: {
      'fine-tuned-eval-dataset': 'project',
      'pattern-agent': 'project',
      'pattern-agent-package': 'project',
      'pattern-agent-test': 'project',
      'pattern-prompt': 'project',
      'pattern-prompt-readme': 'project'
    }
  },
  'genai-streaming': {
    id: 'genai-streaming',
    label: 'GenAI Streaming Pattern Component',
    category: 'genai',
    revision: '2026.09.01',
    dependencies: ['locks.python-genai.uv-lock'],
    resources: ['locks.python-genai.uv-lock'],
    artifactLifecycles: {
      'pattern-agent': 'project',
      'pattern-agent-package': 'project',
      'pattern-agent-test': 'project',
      'pattern-prompt': 'project',
      'pattern-prompt-readme': 'project'
    }
  },
  'genai-workflow': {
    id: 'genai-workflow',
    label: 'GenAI Orchestrated Workflow Pattern Component',
    category: 'genai',
    revision: '2026.09.01',
    dependencies: ['locks.python-genai.uv-lock'],
    resources: ['locks.python-genai.uv-lock'],
    artifactLifecycles: {
      'pattern-worker': 'project',
      'backend-workers-package': 'project',
      'pattern-agent': 'project',
      'pattern-agent-package': 'project',
      'pattern-agent-test': 'project',
      'pattern-prompt': 'project',
      'pattern-prompt-readme': 'project'
    }
  },
  'infrastructure-azure-opentofu': {
    id: 'infrastructure-azure-opentofu',
    label: 'Azure OpenTofu Infrastructure Component',
    category: 'infrastructure',
    revision: '2026.09.01',
    dependencies: ['locks.opentofu-azure.provider-lock'],
    resources: [
      'locks.opentofu-azure.versions',
      'locks.opentofu-azure.provider-lock'
    ],
    artifactLifecycles: {
      'opentofu-application-main': 'project',
      'opentofu-application-variables': 'project',
      'opentofu-application-outputs': 'project',
      'opentofu-application-versions': 'project',
      'opentofu-readme': 'project',
      'opentofu-dev-provider-lock': 'project',
      'opentofu-dev-providers': 'project',
      'opentofu-dev-variables': 'project',
      'opentofu-dev-main': 'project',
      'opentofu-dev-outputs': 'project',
      'opentofu-dev-local-state': 'project',
      'opentofu-dev-remote-state-example': 'project',
      'opentofu-dev-tfvars': 'project',
      'opentofu-dev-versions': 'project',
      'opentofu-staging-provider-lock': 'project',
      'opentofu-staging-providers': 'project',
      'opentofu-staging-variables': 'project',
      'opentofu-staging-main': 'project',
      'opentofu-staging-outputs': 'project',
      'opentofu-staging-local-state': 'project',
      'opentofu-staging-remote-state-example': 'project',
      'opentofu-staging-tfvars': 'project',
      'opentofu-staging-versions': 'project',
      'opentofu-prod-provider-lock': 'project',
      'opentofu-prod-providers': 'project',
      'opentofu-prod-variables': 'project',
      'opentofu-prod-main': 'project',
      'opentofu-prod-outputs': 'project',
      'opentofu-prod-local-state': 'project',
      'opentofu-prod-remote-state-example': 'project',
      'opentofu-prod-tfvars': 'project',
      'opentofu-prod-versions': 'project',
      'environment-dev-backend': 'project',
      'environment-dev-functions': 'project',
      'environment-staging-backend': 'project',
      'environment-staging-functions': 'project',
      'environment-prod-backend': 'project',
      'environment-prod-functions': 'project'
    }
  },
  'workflow-openspec': {
    id: 'workflow-openspec',
    label: 'OpenSpec Spec-Driven Workflow Component',
    category: 'workflow',
    revision: '2026.09.01',
    dependencies: ['baselines.supported-stack'],
    resources: ['baselines.supported-stack'],
    artifactLifecycles: {
      'openspec-config': 'seed',
      'openspec-seed-change-metadata': 'seed',
      'openspec-seed-proposal': 'seed',
      'openspec-seed-design': 'seed',
      'openspec-seed-tasks': 'seed',
      'openspec-seed-spec': 'seed',
      'openspec-spec-placeholder': 'seed'
    }
  },
  'workflow-speckit': {
    id: 'workflow-speckit',
    label: 'Spec Kit Spec-Driven Workflow Component',
    category: 'workflow',
    revision: '2026.09.01',
    dependencies: ['baselines.supported-stack'],
    resources: ['baselines.supported-stack'],
    artifactLifecycles: {
      'spec-kit-constitution': 'seed',
      'spec-kit-spec-template': 'framework',
      'spec-kit-plan-template': 'framework',
      'spec-kit-bootstrap-spec': 'seed',
      'spec-kit-bootstrap-plan': 'seed',
      'spec-kit-bootstrap-tasks': 'seed',
      'specs-placeholder': 'seed'
    }
  },
  'governance-single-maintainer-gitflow': {
    id: 'governance-single-maintainer-gitflow',
    label: 'Single Maintainer GitFlow Governance Component',
    category: 'governance',
    revision: '2026.09.01',
    dependencies: ['governance.single-maintainer-gitflow.policy'],
    resources: [
      'governance.single-maintainer-gitflow.policy',
      'governance.single-maintainer-gitflow.activation-v2-graph',
      'governance.single-maintainer-gitflow.assessment-controls'
    ],
    artifactLifecycles: {
      'repository-governance-policy': 'managed-core',
      'repository-governance-context': 'managed-core',
      'repository-governance-guide': 'managed-core',
      'repository-governance-phase-graph': 'managed-core',
      'repository-governance-compatibility': 'managed-core',
      'repository-governance-credential-policy-schema': 'managed-core',
      'liftoff-setup-copilot': 'managed-core',
      'liftoff-governance-assess-copilot': 'managed-core',
      'liftoff-setup-claude': 'managed-core',
      'liftoff-governance-assess-claude': 'managed-core',
      'liftoff-setup-codex': 'managed-core',
      'liftoff-governance-assess-codex': 'managed-core'
    }
  },
  'repair-windows': {
    id: 'repair-windows',
    label: 'Windows Process Supervision Component',
    category: 'common',
    revision: '2026.09.01',
    dependencies: ['repair.windows.job-controller'],
    resources: [
      'repair.windows.job-controller'
    ],
    artifactLifecycles: {}
  },
  'canonical-skills': {
    id: 'canonical-skills',
    label: 'Canonical Agent Skills Library',
    category: 'workflow',
    revision: '2026.09.01',
    dependencies: [],
    resources: [
      'skills.catalog',
      'skills.setup',
      'skills.assess',
      'skills.init',
      'skills.adopt',
      'skills.update',
      'skills.repair',
      'skills.azure',
      'skills.governance',
      'skills.governance-assess',
      'skills.cli-upgrade',
      'skills.migrate'
    ],
    artifactLifecycles: {}
  }
};

// Compute component digests based on resources
for (const comp of Object.values(components)) {
  comp.digest = computeComponentDigest(comp, resources);
}

const retirements = {
  'repository-governance-copilot-launcher': {
    retiredLogicalName: 'repository-governance-copilot-launcher',
    category: 'governance',
    pathParts: ['.github', 'prompts', 'liftoff-repository-governance.prompt.md'],
    replacementLogicalName: 'liftoff-setup-copilot',
    reason: 'Replaced by unified liftoff-setup prompt.'
  },
  'repository-governance-claude-launcher': {
    retiredLogicalName: 'repository-governance-claude-launcher',
    category: 'governance',
    pathParts: ['.claude', 'commands', 'liftoff-repository-governance.md'],
    replacementLogicalName: 'liftoff-setup-claude',
    reason: 'Replaced by unified liftoff-setup command.'
  }
};

const templateCatalogBase = {
  schemaVersion: 1,
  catalogId: 'liftoff-template-catalog',
  revision: '2026.09.01',
  components,
  resources,
  retirements
};

const templateCatalog = {
  ...templateCatalogBase,
  digest: computeTemplateCatalogDigest(templateCatalogBase)
};

writeFileSync(
  path.join(root, 'assets/templates/catalog.json'),
  `${JSON.stringify(templateCatalog, null, 2)}\n`,
  'utf8'
);
console.log('Wrote assets/templates/catalog.json');
