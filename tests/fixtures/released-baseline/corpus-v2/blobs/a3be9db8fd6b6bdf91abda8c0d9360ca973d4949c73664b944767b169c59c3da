import type { LiftoffManifest } from '../contracts.js';
import { FileSystemError } from '../errors.js';
import type { ManifestContractContext } from './context.js';
import { assertOnlyFields, isRecord, optionalString, requiredBoolean, requiredString, SEMVER_PATTERN } from './fields.js';

export function createManifestProjectReader(catalog: ManifestContractContext['catalog']) {
  const { getApiStack, canonicalizeCodingAgents, getEnvironment, getCodingAgent, getPattern,
    getProvider, getProjectType, getSpecWorkflow, listRegions } = catalog;

  function normalizeManifestProject(project: unknown, artifactVersion: number): LiftoffManifest['project'] {
    if (!isRecord(project)) {
      throw new FileSystemError('Manifest.project must be a JSON object.');
    }
    if (artifactVersion >= 4) {
      return normalizeV4ManifestProject(project);
    }

    const name = requiredString(project, 'name', 'Manifest.project');
    const patternValue = optionalString(project, 'pattern', 'Manifest.project');
    const projectTypeValue = optionalString(project, 'projectType', 'Manifest.project');
    const projectType = getProjectType(projectTypeValue ?? (patternValue ? 'genai' : ''));
    if (!projectType || projectTypeValue !== undefined && projectType.id !== projectTypeValue) {
      throw new FileSystemError('Manifest project identity is missing a valid projectType.');
    }

    const apiStackValue = optionalString(project, 'apiStack', 'Manifest.project');
    const apiStack = getApiStack(apiStackValue ?? (projectType.id === 'genai' ? 'python-fastapi' : ''));
    if (!apiStack || apiStackValue !== undefined && apiStack.id !== apiStackValue) {
      throw new FileSystemError(`Manifest project type ${projectType.id} is missing a valid apiStack.`);
    }

    const pattern = patternValue ? getPattern(patternValue) : undefined;
    if (patternValue && (!pattern || pattern.id !== patternValue)) {
      throw new FileSystemError(`Manifest project pattern ${JSON.stringify(patternValue)} is invalid.`);
    }
    if (projectType.id === 'genai' && (!pattern || apiStack.id !== 'python-fastapi')) {
      throw new FileSystemError('GenAI manifests require a valid pattern and the python-fastapi API stack.');
    }
    if (projectType.id === 'standard' && pattern) {
      throw new FileSystemError('Standard manifests cannot record a GenAI pattern.');
    }

    const cloudValue = requiredString(project, 'cloud', 'Manifest.project');
    const provider = getProvider(cloudValue);
    if (!provider || provider.id !== cloudValue || provider.status !== 'available') {
      throw new FileSystemError(`Manifest project cloud ${JSON.stringify(cloudValue)} is invalid or unavailable.`);
    }
    const regionValue = requiredString(project, 'region', 'Manifest.project');
    if (!listRegions(provider.id).some((region) => region.slug === regionValue)) {
      throw new FileSystemError(`Manifest project region ${JSON.stringify(regionValue)} is invalid for ${provider.id}.`);
    }

    const frontend = project.frontend;
    if (typeof frontend !== 'boolean') {
      throw new FileSystemError('Manifest.project.frontend must be a boolean.');
    }

    const specWorkflowValue = requiredString(project, 'specWorkflow', 'Manifest.project');
    const specWorkflow = getSpecWorkflow(specWorkflowValue);
    if (!specWorkflow || specWorkflow.id !== specWorkflowValue) {
      throw new FileSystemError(`Manifest project specWorkflow ${JSON.stringify(specWorkflowValue)} is invalid.`);
    }

    let agents: LiftoffManifest['project']['agents'] = [];
    let defaultAgent: LiftoffManifest['project']['defaultAgent'];
    if (artifactVersion >= 3) {
      if (!Array.isArray(project.agents)) {
        throw new FileSystemError('Manifest.project.agents must be an array.');
      }
      const rawAgents = project.agents.map((value, index) => {
        if (typeof value !== 'string') {
          throw new FileSystemError(`Manifest.project.agents[${index}] must be a string.`);
        }
        const agent = getCodingAgent(value);
        if (!agent || agent.id !== value) {
          throw new FileSystemError(`Manifest project agent ${JSON.stringify(value)} is invalid.`);
        }
        return agent.id;
      });
      const canonical = canonicalizeCodingAgents(rawAgents).agents.map((agent) => agent.id);
      if (canonical.length !== rawAgents.length || canonical.some((agent, index) => agent !== rawAgents[index])) {
        throw new FileSystemError('Manifest.project.agents must be unique and in canonical order.');
      }
      agents = canonical;

      const defaultAgentValue = optionalString(project, 'defaultAgent', 'Manifest.project');
      if (defaultAgentValue) {
        const resolved = getCodingAgent(defaultAgentValue);
        if (!resolved || resolved.id !== defaultAgentValue) {
          throw new FileSystemError(`Manifest project defaultAgent ${JSON.stringify(defaultAgentValue)} is invalid.`);
        }
        defaultAgent = resolved.id;
      }
    }

    if (!Array.isArray(project.environments) || project.environments.length === 0) {
      throw new FileSystemError('Manifest.project.environments must be a non-empty string array.');
    }
    const environments = project.environments.map((value, index) => {
      if (typeof value !== 'string') {
        throw new FileSystemError(`Manifest.project.environments[${index}] must be a string.`);
      }
      const environment = getEnvironment(value);
      if (!environment || environment.id !== value) {
        throw new FileSystemError(`Manifest project environment ${JSON.stringify(value)} is invalid.`);
      }
      return environment.id;
    });
    if (new Set(environments).size !== environments.length) {
      throw new FileSystemError('Manifest.project.environments must not contain duplicates.');
    }

    return {
      name,
      workload: projectType.id === 'genai'
        ? {
            kind: 'genai',
            apiStack: apiStack.id,
            pattern: pattern!.id,
            cloud: provider.id,
            region: regionValue,
            frontend,
            environments
          }
        : {
            kind: 'standard',
            apiStack: apiStack.id,
            cloud: provider.id,
            region: regionValue,
            frontend,
            environments
          },
      specWorkflow: specWorkflow.id,
      agents,
      ...(defaultAgent ? { defaultAgent } : {})
    };
  }

  function normalizeV4ManifestProject(project: Record<string, unknown>): LiftoffManifest['project'] {
    assertOnlyFields(
      project,
      ['name', 'workload', 'specWorkflow', 'agents', 'defaultAgent'],
      'Manifest.project'
    );
    const name = requiredString(project, 'name', 'Manifest.project');
    if (!isRecord(project.workload)) {
      throw new FileSystemError('Manifest.project.workload must be a JSON object.');
    }
    const workload = normalizeV4ManifestWorkload(project.workload);
    const specWorkflowValue = requiredString(project, 'specWorkflow', 'Manifest.project');
    const specWorkflow = getSpecWorkflow(specWorkflowValue);
    if (!specWorkflow || specWorkflow.id !== specWorkflowValue) {
      throw new FileSystemError(`Manifest project specWorkflow ${JSON.stringify(specWorkflowValue)} is invalid.`);
    }
    if (!Array.isArray(project.agents)) {
      throw new FileSystemError('Manifest.project.agents must be an array.');
    }
    const rawAgents = project.agents.map((value, index) => {
      if (typeof value !== 'string') {
        throw new FileSystemError(`Manifest.project.agents[${index}] must be a string.`);
      }
      const agent = getCodingAgent(value);
      if (!agent || agent.id !== value) {
        throw new FileSystemError(`Manifest project agent ${JSON.stringify(value)} is invalid.`);
      }
      return agent.id;
    });
    const agents = canonicalizeCodingAgents(rawAgents).agents.map((agent) => agent.id);
    if (agents.length !== rawAgents.length || agents.some((agent, index) => agent !== rawAgents[index])) {
      throw new FileSystemError('Manifest.project.agents must be unique and in canonical order.');
    }
    const defaultAgentValue = optionalString(project, 'defaultAgent', 'Manifest.project');
    let defaultAgent: LiftoffManifest['project']['defaultAgent'];
    if (defaultAgentValue) {
      const resolved = getCodingAgent(defaultAgentValue);
      if (!resolved || resolved.id !== defaultAgentValue) {
        throw new FileSystemError(`Manifest project defaultAgent ${JSON.stringify(defaultAgentValue)} is invalid.`);
      }
      defaultAgent = resolved.id;
    }
    return {
      name,
      workload,
      specWorkflow: specWorkflow.id,
      agents,
      ...(defaultAgent ? { defaultAgent } : {})
    };
  }

  function normalizeV4ManifestWorkload(
    workload: Record<string, unknown>
  ): LiftoffManifest['project']['workload'] {
    const kind = requiredString(workload, 'kind', 'Manifest.project.workload');
    if (kind !== 'genai' && kind !== 'standard') {
      throw new FileSystemError(`Manifest project workload kind ${JSON.stringify(kind)} is invalid.`);
    }
    const allowed = kind === 'genai'
      ? ['kind', 'apiStack', 'pattern', 'cloud', 'region', 'frontend', 'environments']
      : ['kind', 'apiStack', 'cloud', 'region', 'frontend', 'environments'];
    assertOnlyFields(workload, allowed, 'Manifest.project.workload');
    const apiStackValue = requiredString(workload, 'apiStack', 'Manifest.project.workload');
    const apiStack = getApiStack(apiStackValue);
    if (!apiStack || apiStack.id !== apiStackValue) {
      throw new FileSystemError(`Manifest project workload apiStack ${JSON.stringify(apiStackValue)} is invalid.`);
    }
    const patternValue = kind === 'genai'
      ? requiredString(workload, 'pattern', 'Manifest.project.workload')
      : undefined;
    const pattern = patternValue ? getPattern(patternValue) : undefined;
    if (kind === 'genai' && (!pattern || pattern.id !== patternValue || apiStack.id !== 'python-fastapi')) {
      throw new FileSystemError('GenAI manifest workloads require a valid pattern and python-fastapi API stack.');
    }
    const cloudValue = requiredString(workload, 'cloud', 'Manifest.project.workload');
    const provider = getProvider(cloudValue);
    if (!provider || provider.id !== cloudValue || provider.status !== 'available') {
      throw new FileSystemError(`Manifest project workload cloud ${JSON.stringify(cloudValue)} is invalid or unavailable.`);
    }
    const region = requiredString(workload, 'region', 'Manifest.project.workload');
    if (!listRegions(provider.id).some((candidate) => candidate.slug === region)) {
      throw new FileSystemError(`Manifest project workload region ${JSON.stringify(region)} is invalid for ${provider.id}.`);
    }
    if (!Array.isArray(workload.environments) || workload.environments.length === 0) {
      throw new FileSystemError('Manifest.project.workload.environments must be a non-empty string array.');
    }
    const environments = workload.environments.map((value, index) => {
      if (typeof value !== 'string') {
        throw new FileSystemError(`Manifest.project.workload.environments[${index}] must be a string.`);
      }
      const environment = getEnvironment(value);
      if (!environment || environment.id !== value) {
        throw new FileSystemError(`Manifest project workload environment ${JSON.stringify(value)} is invalid.`);
      }
      return environment.id;
    });
    if (new Set(environments).size !== environments.length) {
      throw new FileSystemError('Manifest.project.workload.environments must not contain duplicates.');
    }
    const common = {
      apiStack: apiStack.id,
      cloud: provider.id,
      region,
      frontend: requiredBoolean(workload, 'frontend', 'Manifest.project.workload'),
      environments
    };
    return kind === 'genai'
      ? { kind, ...common, pattern: pattern!.id }
      : { kind, ...common };
  }

  function normalizeManifestFramework(
    value: unknown,
    artifactVersion: number,
    project: LiftoffManifest['project']
  ): LiftoffManifest['framework'] {
    if (artifactVersion === 2) {
      return { state: 'legacy', adapter: project.specWorkflow };
    }
    if (!isRecord(value)) {
      throw new FileSystemError('Manifest.framework must be a JSON object.');
    }
    if (artifactVersion >= 5) {
      assertOnlyFields(
        value,
        ['state', 'adapter', 'contractVersion'],
        'Manifest.framework'
      );
    }
    const state = requiredString(value, 'state', 'Manifest.framework');
    if (state !== 'initialized' && state !== 'legacy') {
      throw new FileSystemError('Manifest.framework.state must be "initialized" or "legacy".');
    }
    const adapterValue = requiredString(value, 'adapter', 'Manifest.framework');
    const adapter = getSpecWorkflow(adapterValue);
    if (!adapter || adapter.id !== adapterValue || adapter.id !== project.specWorkflow) {
      throw new FileSystemError('Manifest.framework.adapter must match Manifest.project.specWorkflow.');
    }
    const contractVersion = optionalString(value, 'contractVersion', 'Manifest.framework');
    if (contractVersion && !SEMVER_PATTERN.test(contractVersion)) {
      throw new FileSystemError('Manifest.framework.contractVersion must be a valid semantic version.');
    }
    if (state === 'legacy') {
      if (contractVersion || project.agents.length > 0 || project.defaultAgent) {
        throw new FileSystemError('Legacy framework state cannot claim a contract version or configured agents.');
      }
      return { state, adapter: adapter.id };
    }
    if (!contractVersion) {
      throw new FileSystemError('Initialized framework state requires Manifest.framework.contractVersion.');
    }
    if (project.agents.length === 0) {
      throw new FileSystemError('Initialized framework state requires at least one configured agent.');
    }
    if (adapter.id === 'spec-kit') {
      if (!project.defaultAgent || !project.agents.includes(project.defaultAgent)) {
        throw new FileSystemError('Spec Kit manifests require a selected defaultAgent.');
      }
    } else if (project.defaultAgent) {
      throw new FileSystemError('OpenSpec manifests cannot record a defaultAgent.');
    }
    return { state, adapter: adapter.id, contractVersion };
  }

  return { normalizeManifestProject, normalizeManifestFramework };
}
