import { readFile } from 'node:fs/promises';
import { parse as parseHcl } from '@cdktf/hcl2json';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { buildProjectPlan } from '../src/application/project/planning.js';
import { apiStacks, patterns } from '../src/application/project/catalog.js';
import { parseManifest } from '../src/application/project/manifest.js';
import { buildArtifacts } from '../src/templates.js';
import {
  currentStandardsManifestContext, getProfileIdentity
} from '../src/adapters/packaged-assets/resource-catalog.js';
import { canonicalSha256, isRecord } from '../src/domain/governance/activation/canonical-json.js';
import {
  DEFAULT_FUNCTION_WORKER_QUEUE_NAME, functionWorkerName, hasFunctionWorker
} from '../src/generators/common/values.js';
import type {
  GeneratedArtifact, LiftoffManifestV8, ManifestComponent, ProjectOptions
} from '../src/domain/project/contracts.js';
import * as roleMapping from '../src/application/azure-activation/component-role-mapping.js';
import {
  ComponentRoleMappingError, deriveComponentRolesForManifest, deriveComponentRolesForPlan
} from '../src/application/azure-activation/component-role-mapping.js';

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Expected a structured generated artifact.');
  return value;
}

function block(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1) throw new Error('Expected one actual HCL block.');
  return object(value[0]);
}

function artifact(files: readonly GeneratedArtifact[], logicalName: string): GeneratedArtifact {
  const selected = files.find((file) => file.logicalName === logicalName);
  if (!selected) throw new Error(`Missing generated artifact ${logicalName}.`);
  return selected;
}

function manifest(value: unknown): LiftoffManifestV8 {
  const parsed = parseManifest(value);
  if (parsed.artifactVersion !== 8) throw new Error('Expected a current manifest fixture.');
  return parsed;
}

function adopted(components: ManifestComponent[]): LiftoffManifestV8 {
  const context = currentStandardsManifestContext();
  return manifest({
    artifactVersion: 8, generatedBy: 'Mission Control Liftoff', liftoffVersion: '0.13.0',
    project: { name: 'Declared component fixture', workload: { kind: 'components' }, specWorkflow: 'openspec', agents: [] },
    framework: { state: 'uninitialized', adapter: 'openspec' },
    governance: { profile: 'none', state: 'disabled' },
    managedArtifacts: [], projectArtifacts: [],
    standards: {
      schemaVersion: 1, catalogDigest: context.profiles.digest, resourceCatalogDigest: context.resourceCatalogDigest,
      components
    },
    provenance: {
      kind: 'adopted', recordId: canonicalSha256('structural fixture, not issued adoption authority'),
      observationDigest: canonicalSha256('fixture component observation'), repairs: []
    }
  });
}

const profiles: Array<{ name: string; options: ProjectOptions }> = [
  ...apiStacks.map((stack) => ({
    name: stack.id, options: { projectType: 'standard' as const, apiStack: stack.id }
  })),
  ...patterns.map((pattern) => ({
    name: `genai-${pattern.id}`, options: { projectType: 'genai' as const, pattern: pattern.id }
  }))
];
const matrix = profiles.flatMap((profile) => [false, true].map((frontend) => ({ ...profile, frontend })));

describe('component metadata roles, not runtime or deployment proof', () => {
  it.each(matrix)('matches actual $name generated artifacts with frontend=$frontend', async ({ options, frontend }) => {
    const plan = buildProjectPlan({
      ...options, projectName: 'Component roles', cloud: 'azure', includeFrontend: frontend,
      environments: ['dev'], specWorkflow: 'openspec'
    }, { requireProjectName: true });
    const files = buildArtifacts(plan);
    const recorded = manifest(JSON.parse(artifact(files, 'manifest').content));
    const original = structuredClone(recorded);
    const fromPlan = deriveComponentRolesForPlan(plan);
    const fromManifest = deriveComponentRolesForManifest(recorded);
    expect(fromManifest).toEqual(fromPlan);
    expect(recorded).toEqual(original);
    expect(fromPlan).toMatchObject({ authority: 'none', binding: 'generated-defaults', blockers: [] });
    expect(new Set(fromPlan.allRoles.map((role) => role.roleId)).size).toBe(fromPlan.allRoles.length);
    expect(fromPlan.allRoles.filter((role) => role.componentId !== null).map((role) => ({
      id: role.componentId, profileId: role.profileId, rootPathParts: role.rootPathParts
    }))).toEqual(recorded.standards.components.map((component) => ({
      id: component.id, profileId: component.profile.id, rootPathParts: component.rootPathParts
    })));

    const compose = object(parseYaml(artifact(files, 'docker-compose').content));
    const services = object(compose.services);
    const hcl = object(await parseHcl('application.tf', artifact(files, 'opentofu-application-main').content));
    const resources = object(hcl.resource);
    const containerApps = object(resources.azurerm_container_app);
    const variables = object(object(await parseHcl('variables.tf', artifact(files, 'opentofu-application-variables').content)).variable);
    const backend = fromPlan.allRoles.find((role) => role.roleKind === 'backend');
    if (!backend || backend.binding !== 'generated-defaults' || backend.roleKind !== 'backend') throw new Error('Missing generated backend role.');
    expect(backend.componentId).toBe('backend');
    expect(backend.artifact).toEqual({
      kind: 'container-image', imageVariable: 'backend_image', buildContextPathParts: [],
      dockerfilePathParts: ['Dockerfile']
    });
    expect(object(object(services.backend).build)).toEqual({ context: '.', dockerfile: 'Dockerfile' });
    const backendDockerfile = files.find((file) => file.pathParts.join('/') === backend.artifact.dockerfilePathParts.join('/'));
    expect(backendDockerfile?.content).toContain(`EXPOSE ${backend.runtime.applicationTargetPort}`);
    expect(block(block(block(containerApps.backend).template).container).image).toBe('${var.backend_image}');
    expect(block(block(containerApps.backend).ingress).target_port).toBe('${var.backend_target_port}');
    expect(block(variables.backend_target_port).default).toBe(backend.runtime.bootstrapTargetPort);
    expect(backend.runtime.applicationTargetPort).not.toBe(backend.runtime.bootstrapTargetPort);
    expect(backend.runtime.schema).toEqual({ path: '/openapi.json', mediaType: 'application/json' });
    expect(backend.runtime.documentation).toEqual({ path: '/scalar', mediaType: 'text/html' });
    const healthSource = artifact(files, plan.workload === 'standard'
      ? plan.apiStack.id === 'go-huma' ? 'go-backend-api'
        : plan.apiStack.id === 'node-fastify' ? 'node-backend-app' : 'backend-health-routes'
      : 'backend-health-routes').content;
    expect(healthSource).toContain(backend.runtime.health.path);
    if (plan.workload === 'standard' && plan.apiStack.id === 'go-huma') {
      expect(healthSource).toContain('json:"status"');
      expect(healthSource).toContain('output.Body.Status = "ok"');
    } else {
      expect(healthSource).toMatch(/status['"]?\s*:\s*['"]ok['"]/u);
    }

    const ui = fromPlan.allRoles.find((role) => role.roleKind === 'frontend');
    if (frontend) {
      if (!ui || ui.binding !== 'generated-defaults' || ui.roleKind !== 'frontend') throw new Error('Missing generated frontend role.');
      expect(ui.componentId).toBe('frontend');
      expect(ui.artifact).toEqual({
        kind: 'container-image', imageVariable: 'frontend_image', buildContextPathParts: ['frontend'],
        dockerfilePathParts: ['frontend', 'Dockerfile'], staticOutputPathParts: ['frontend', 'dist']
      });
      expect(object(object(services.frontend).build)).toEqual({ context: './frontend' });
      expect(artifact(files, 'frontend-dockerfile').pathParts).toEqual(ui.artifact.dockerfilePathParts);
      expect(artifact(files, 'frontend-dockerfile').content).toContain('COPY --from=build /app/dist /usr/share/nginx/html');
      expect(object(object(JSON.parse(artifact(files, 'frontend-package').content)).scripts).build).toBe('vite build');
      expect(artifact(files, 'frontend-index').content).toContain('<div id="app"></div>');
      expect(block(block(block(containerApps.frontend).template).container).image).toBe('${var.frontend_image}');
      expect(block(block(containerApps.frontend).ingress).target_port).toBe(ui.runtime.applicationTargetPort);
      expect(ui.runtime.document.mediaType).not.toBe(backend.runtime.health.mediaType);
    } else {
      expect(ui).toBeUndefined();
      expect(containerApps.frontend).toBeUndefined();
      expect(services.frontend).toBeUndefined();
      expect(files.some((file) => file.pathParts[0] === 'frontend')).toBe(false);
    }

    const worker = fromPlan.allRoles.find((role) => role.roleKind === 'worker');
    expect(fromPlan.workerApplicability).toBe(hasFunctionWorker(plan) ? 'required' : 'not-required');
    if (hasFunctionWorker(plan)) {
      if (plan.workload !== 'genai' || !worker || worker.roleKind !== 'worker') throw new Error('Missing generated worker role.');
      expect(worker.componentId).toBeNull();
      expect(worker.profileComponentId).toBe('backend');
      expect(worker.rootPathParts).toEqual(['functions', functionWorkerName(plan)]);
      expect(artifact(files, 'function-worker-app').pathParts).toEqual([...worker.rootPathParts, 'function_app.py']);
      expect(worker.artifact).toEqual({ kind: 'function-source', sharedSourceRootPathParts: ['backend'] });
      expect(worker.runtime.kind).toBe('servicebus-trigger-skeleton');
      expect(artifact(files, 'function-worker-readme').content).toContain('does not index documents');
      const functionApp = block(object(resources.azurerm_linux_function_app).worker);
      expect(object(functionApp.app_settings).SERVICEBUS_QUEUE_NAME).toBe('${var.function_worker_queue_name}');
      expect(block(block(functionApp.site_config).application_stack).python_version).toBe('${var.functions_python_version}');
      expect(block(variables.function_worker_queue_name).default).toBe(DEFAULT_FUNCTION_WORKER_QUEUE_NAME);
      const outputs = object(object(await parseHcl('outputs.tf', artifact(files, 'opentofu-application-outputs').content)).output);
      expect(outputs[worker.runtime.functionAppNameOutput]).toBeDefined();
      expect(variables[worker.runtime.functionAppNameOutput]).toBeUndefined();
    } else {
      expect(worker).toBeUndefined();
      expect(resources.azurerm_linux_function_app).toBeUndefined();
      expect(files.some((file) => file.logicalName === 'function-worker-app')).toBe(false);
    }
  });

  it('keeps adopted Vue build output, hosting, endpoints and worker applicability unbound', () => {
    const input = adopted([{ id: 'web-ui', profile: getProfileIdentity('vue-component'), rootPathParts: ['apps', 'custom-ui'] }]);
    const original = structuredClone(input);
    const roles = deriveComponentRolesForManifest(input);
    expect(input).toEqual(original);
    expect(roles).toMatchObject({
      authority: 'none', binding: 'explicit-deployment-required', workerApplicability: 'unresolved',
      allRoles: [{
        roleId: 'frontend:web-ui', componentId: 'web-ui', roleKind: 'frontend', profileId: 'vue-component',
        rootPathParts: ['apps', 'custom-ui'], artifact: null, runtime: null
      }]
    });
    expect(roles.blockers).toHaveLength(1);
    expect(JSON.stringify(roles)).not.toContain('dist');
    expect(JSON.stringify(roles)).not.toContain('container-app');
  });

  it('preserves real declared mixed component boundaries without inventing full workload deployment', () => {
    const input = adopted([
      { id: 'orders-api', profile: getProfileIdentity('python-fastapi'), rootPathParts: ['services', 'orders'] },
      { id: 'orders-ui', profile: getProfileIdentity('vue-component'), rootPathParts: ['web', 'orders'] }
    ]);
    const roles = deriveComponentRolesForManifest(input);
    expect(roles.binding).toBe('explicit-deployment-required');
    expect(roles.allRoles.map((role) => [role.componentId, role.roleKind, role.rootPathParts])).toEqual([
      ['orders-api', 'backend', ['services', 'orders']], ['orders-ui', 'frontend', ['web', 'orders']]
    ]);
    expect(roles.allRoles.every((role) => role.artifact === null && role.runtime === null)).toBe(true);
    expect(roles.workerApplicability).toBe('unresolved');
  });

  it.each(['catalog', 'profile', 'empty', 'duplicate-id', 'overlap', 'escape', 'fake-generated'] as const)(
    'rejects %s manifest metadata instead of inferring default Vue or deployment facts', (change) => {
      const input = adopted([{ id: 'ui', profile: getProfileIdentity('vue-component'), rootPathParts: ['ui'] }]);
      if (change === 'catalog') input.standards.catalogDigest = `sha256:${'0'.repeat(64)}`;
      if (change === 'profile') input.standards.components[0]!.profile.digest = `sha256:${'0'.repeat(64)}`;
      if (change === 'empty') input.standards.components = [];
      if (change === 'duplicate-id') input.standards.components.push({ ...input.standards.components[0]!, rootPathParts: ['other'] });
      if (change === 'overlap') input.standards.components.push({ ...input.standards.components[0]!, id: 'nested', rootPathParts: ['ui', 'nested'] });
      if (change === 'escape') input.standards.components[0]!.rootPathParts = ['..', 'outside'];
      if (change === 'fake-generated') {
        const generated = buildArtifacts(buildProjectPlan({
          projectName: 'Generated', projectType: 'standard', apiStack: 'node-fastify'
        }, { requireProjectName: true }));
        input.provenance = manifest(JSON.parse(artifact(generated, 'manifest').content)).provenance;
      }
      expect(() => deriveComponentRolesForManifest(input)).toThrow();
    }
  );

  it('refuses historical manifests until their separately reviewed current metadata migration', async () => {
    const old = parseManifest(JSON.parse(await readFile(new URL('./fixtures/manifest-v7-standard-released.json', import.meta.url), 'utf8')));
    expect(() => deriveComponentRolesForManifest(old)).toThrow(/current-manifest-required/);
  });

  it('refuses altered canonical worker declarations rather than maintaining a parallel pattern list', () => {
    const plan = buildProjectPlan({ projectName: 'Worker selection', pattern: 'rag' }, { requireProjectName: true });
    if (plan.workload !== 'genai') throw new Error('Expected a GenAI fixture.');
    const changed = structuredClone(plan);
    changed.pattern.worker = !changed.pattern.worker;
    expect(() => deriveComponentRolesForPlan(changed)).toThrow(/changed-pattern-worker-declaration/);
    expect(hasFunctionWorker(plan)).toBe(true);
  });

  it('does not expose ad-hoc response validators or interpret metadata as runtime proof', () => {
    expect(roleMapping).not.toHaveProperty('validateHealthProbeResponse');
    expect(roleMapping).not.toHaveProperty('validateDocumentationRouteResponse');
    expect(() => Reflect.apply(deriveComponentRolesForPlan, undefined, [null])).toThrow(ComponentRoleMappingError);
    expect(() => Reflect.apply(deriveComponentRolesForManifest, undefined, [null])).toThrow();
  });
});
