import type {
  LiftoffManifest, ManifestComponent, ManifestProjectIdentity, ProjectPlan
} from '../../domain/project/contracts.js';
import { generatedComponentsForPlan } from '../../adapters/packaged-assets/resource-catalog.js';
import { getApiStack, getPattern } from '../project/catalog.js';
import { parseManifest } from '../project/manifest.js';
import {
  DEFAULT_FUNCTION_WORKER_QUEUE_NAME, functionWorkerName, hasFunctionWorker
} from '../../generators/common/values.js';

export const COMPONENT_ROLE_MAPPING_SCHEMA_VERSION = 1 as const;

export class ComponentRoleMappingError extends Error {
  constructor(readonly code: string) {
    super(`Application component role mapping is blocked (${code}); explicit source and deployment bindings are required.`);
    this.name = 'ComponentRoleMappingError';
  }
}

interface ComponentRoleIdentity {
  readonly roleId: string;
  readonly componentId: string | null;
  readonly profileId: string;
  readonly rootPathParts: readonly string[];
}

export interface BackendArtifactRole extends ComponentRoleIdentity {
  readonly roleKind: 'backend';
  readonly binding: 'generated-defaults';
  readonly componentId: string;
  readonly artifact: {
    readonly kind: 'container-image';
    readonly imageVariable: 'backend_image';
    readonly buildContextPathParts: readonly [];
    readonly dockerfilePathParts: readonly ['Dockerfile'];
  };
  readonly runtime: {
    readonly kind: 'json-api';
    readonly applicationTargetPort: 8000;
    readonly bootstrapTargetPort: 80;
    readonly targetPortVariable: 'backend_target_port';
    readonly health: { readonly path: '/health'; readonly mediaType: 'application/json'; readonly status: 'ok' };
    readonly schema: { readonly path: '/openapi.json'; readonly mediaType: 'application/json' };
    readonly documentation: { readonly path: '/scalar'; readonly mediaType: 'text/html' };
  };
}

export interface FrontendArtifactRole extends ComponentRoleIdentity {
  readonly roleKind: 'frontend';
  readonly binding: 'generated-defaults';
  readonly componentId: string;
  readonly artifact: {
    readonly kind: 'container-image';
    readonly imageVariable: 'frontend_image';
    readonly buildContextPathParts: readonly ['frontend'];
    readonly dockerfilePathParts: readonly ['frontend', 'Dockerfile'];
    readonly staticOutputPathParts: readonly ['frontend', 'dist'];
  };
  readonly runtime: {
    readonly kind: 'vue-static-entry';
    readonly applicationTargetPort: 80;
    readonly document: { readonly path: '/'; readonly mediaType: 'text/html' };
  };
}

export interface FunctionWorkerArtifactRole extends ComponentRoleIdentity {
  readonly roleKind: 'worker';
  readonly binding: 'generated-defaults';
  readonly componentId: null;
  readonly profileComponentId: string;
  readonly artifact: {
    readonly kind: 'function-source';
    readonly sharedSourceRootPathParts: readonly ['backend'];
  };
  readonly runtime: {
    readonly kind: 'servicebus-trigger-skeleton';
    readonly defaultQueueName: typeof DEFAULT_FUNCTION_WORKER_QUEUE_NAME;
    readonly queueNameVariable: 'function_worker_queue_name';
    readonly pythonVersionVariable: 'functions_python_version';
    readonly functionAppNameOutput: 'function_app_name';
  };
}

export interface UnboundComponentRole extends ComponentRoleIdentity {
  readonly roleKind: 'backend' | 'frontend';
  readonly binding: 'explicit-deployment-required';
  readonly componentId: string;
  readonly artifact: null;
  readonly runtime: null;
}

export type AnyComponentRole =
  | BackendArtifactRole | FrontendArtifactRole | FunctionWorkerArtifactRole | UnboundComponentRole;

export interface ApplicationComponentRolesSummary {
  readonly schemaVersion: 1;
  readonly authority: 'none';
  readonly workloadKind: ManifestProjectIdentity['workload']['kind'];
  readonly binding: 'generated-defaults' | 'explicit-deployment-required';
  readonly workerApplicability: 'required' | 'not-required' | 'unresolved';
  readonly allRoles: readonly AnyComponentRole[];
  readonly blockers: readonly string[];
}

function componentRole(component: ManifestComponent): 'backend' | 'frontend' {
  if (component.profile.id === 'vue-component') return 'frontend';
  const stack = getApiStack(component.profile.id);
  const pattern = component.profile.id.startsWith('genai-') ? getPattern(component.profile.id.slice(6)) : undefined;
  if (stack?.id === component.profile.id || pattern && `genai-${pattern.id}` === component.profile.id) return 'backend';
  throw new ComponentRoleMappingError('unsupported-component-profile');
}

function identity(component: ManifestComponent): ComponentRoleIdentity & { componentId: string } {
  return {
    roleId: `${componentRole(component)}:${component.id}`,
    componentId: component.id, profileId: component.profile.id,
    rootPathParts: [...component.rootPathParts]
  };
}

function generatedRoles(
  workloadKind: 'standard' | 'genai', components: readonly ManifestComponent[], patternId?: string
): ApplicationComponentRolesSummary {
  const backend = components.filter((component) => componentRole(component) === 'backend');
  const frontends = components.filter((component) => componentRole(component) === 'frontend');
  if (backend.length !== 1 || frontends.length > 1 ||
    backend[0]!.rootPathParts.join('/') !== 'backend' ||
    frontends.some((component) => component.rootPathParts.join('/') !== 'frontend')) {
    throw new ComponentRoleMappingError('generated-component-boundaries');
  }
  const allRoles: AnyComponentRole[] = [{
    ...identity(backend[0]!), roleKind: 'backend', binding: 'generated-defaults',
    artifact: { kind: 'container-image', imageVariable: 'backend_image', buildContextPathParts: [], dockerfilePathParts: ['Dockerfile'] },
    runtime: {
      kind: 'json-api', applicationTargetPort: 8000, bootstrapTargetPort: 80, targetPortVariable: 'backend_target_port',
      health: { path: '/health', mediaType: 'application/json', status: 'ok' },
      schema: { path: '/openapi.json', mediaType: 'application/json' },
      documentation: { path: '/scalar', mediaType: 'text/html' }
    }
  }];
  if (frontends[0]) {
    allRoles.push({
      ...identity(frontends[0]), roleKind: 'frontend', binding: 'generated-defaults',
      artifact: {
        kind: 'container-image', imageVariable: 'frontend_image', buildContextPathParts: ['frontend'],
        dockerfilePathParts: ['frontend', 'Dockerfile'], staticOutputPathParts: ['frontend', 'dist']
      },
      runtime: { kind: 'vue-static-entry', applicationTargetPort: 80, document: { path: '/', mediaType: 'text/html' } }
    });
  }
  const pattern = workloadKind === 'genai' && patternId ? getPattern(patternId) : undefined;
  if (workloadKind === 'genai' && (!pattern || pattern.id !== patternId)) {
    throw new ComponentRoleMappingError('unknown-pattern');
  }
  if (pattern && hasFunctionWorker({ workload: 'genai', provider: { id: 'azure' }, pattern })) {
    const workerName = functionWorkerName({ pattern });
    allRoles.push({
      roleId: `worker:${workerName}`, roleKind: 'worker', binding: 'generated-defaults',
      componentId: null, profileComponentId: backend[0]!.id, profileId: backend[0]!.profile.id,
      rootPathParts: ['functions', workerName],
      artifact: { kind: 'function-source', sharedSourceRootPathParts: ['backend'] },
      runtime: {
        kind: 'servicebus-trigger-skeleton', defaultQueueName: DEFAULT_FUNCTION_WORKER_QUEUE_NAME,
        queueNameVariable: 'function_worker_queue_name', pythonVersionVariable: 'functions_python_version',
        functionAppNameOutput: 'function_app_name'
      }
    });
  }
  return {
    schemaVersion: COMPONENT_ROLE_MAPPING_SCHEMA_VERSION, authority: 'none', workloadKind,
    binding: 'generated-defaults',
    workerApplicability: allRoles.some((role) => role.roleKind === 'worker') ? 'required' : 'not-required',
    allRoles, blockers: []
  };
}

export function deriveComponentRolesForPlan(plan: ProjectPlan): ApplicationComponentRolesSummary {
  if (!plan || (plan.workload !== 'standard' && plan.workload !== 'genai') || plan.provider?.id !== 'azure') {
    throw new ComponentRoleMappingError('unsupported-generated-workload');
  }
  if (plan.workload === 'genai' && getPattern(plan.pattern.id)?.worker !== plan.pattern.worker) {
    throw new ComponentRoleMappingError('changed-pattern-worker-declaration');
  }
  return generatedRoles(plan.workload, generatedComponentsForPlan(plan),
    plan.workload === 'genai' ? plan.pattern.id : undefined);
}

export function deriveComponentRolesForManifest(input: LiftoffManifest): ApplicationComponentRolesSummary {
  const manifest = parseManifest(input);
  if (manifest.artifactVersion !== 8) throw new ComponentRoleMappingError('current-manifest-required');
  const workload = manifest.project.workload;
  if (manifest.provenance.kind === 'adopted' || workload.kind === 'components') {
    return {
      schemaVersion: COMPONENT_ROLE_MAPPING_SCHEMA_VERSION, authority: 'none', workloadKind: workload.kind,
      binding: 'explicit-deployment-required', workerApplicability: 'unresolved',
      allRoles: manifest.standards.components.map((component): UnboundComponentRole => ({
        ...identity(component), roleKind: componentRole(component),
        binding: 'explicit-deployment-required', artifact: null, runtime: null
      })),
      blockers: ['Declared component profiles do not establish build outputs, hosting, runtime endpoints or worker applicability. Review explicit source and deployment bindings.']
    };
  }
  if (workload.cloud !== 'azure') throw new ComponentRoleMappingError('unsupported-generated-provider');
  return generatedRoles(workload.kind, manifest.standards.components,
    workload.kind === 'genai' ? workload.pattern : undefined);
}
