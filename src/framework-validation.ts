import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { getCodingAgent, getFrameworkDefinition } from './application/project/catalog.js';
import { SPEC_KIT_AGENT_SURFACES, SPEC_KIT_WORKFLOW_IDS } from './domain/project/catalog.js';
import { validateArtifactPathParts } from './domain/project/paths.js';
import {
  OPEN_SPEC_COPILOT_CLOUD_PATHS,
  openSpecIntegrationPaths
} from './openspec-profile.js';
import type { CodingAgentId, ProjectPlan, SpecWorkflowId } from './domain/project/contracts.js';

export interface FrameworkSelection {
  workflow: SpecWorkflowId;
  agents: CodingAgentId[];
  defaultAgent?: CodingAgentId;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}

export async function frameworkMarkerIssue(
  root: string,
  pathParts: readonly string[]
): Promise<string | undefined> {
  const display = pathParts.join('/');
  try {
    validateArtifactPathParts(pathParts, 'Framework marker');
    let parent = root;
    for (const [index, part] of pathParts.entries()) {
      const names = (await readdir(parent)).filter((name) => name.toLowerCase() === part.toLowerCase());
      if (names.some((name) => name !== part)) {
        return `Framework marker has a case collision: ${display}`;
      }
      const current = path.join(parent, part);
      const details = await lstat(current);
      if (details.isSymbolicLink()) {
        return `Framework marker is a forbidden symlink: ${display}`;
      }
      const isLast = index === pathParts.length - 1;
      if (isLast ? !details.isFile() : !details.isDirectory()) {
        return `Framework marker is not a regular file or has a non-directory parent: ${display}`;
      }
      if (isLast && details.size === 0) {
        return `Framework marker is empty: ${display}`;
      }
      parent = current;
    }
    return undefined;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return `Missing framework marker: ${display}`;
    }
    return `Unable to inspect framework marker ${display}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function specKitIntegrationPaths(agent: CodingAgentId): string[][] {
  const surface = SPEC_KIT_AGENT_SURFACES[agent];
  return SPEC_KIT_WORKFLOW_IDS.map((workflow) => [
    ...surface.skillsRoot, `speckit-${workflow}`, 'SKILL.md'
  ]);
}

export function frameworkIntegrationPaths(
  workflow: SpecWorkflowId,
  agent: CodingAgentId
): string[][] {
  return workflow === 'openspec' ? openSpecIntegrationPaths(agent) : specKitIntegrationPaths(agent);
}

export const OPEN_SPEC_CODEX_TARGET_PATH = ['.agents', 'skills', '.openspec-target'] as const;
export const SPEC_KIT_CODEX_CONFIG_PATH = ['.codex', 'config.toml'] as const;

export function frameworkOutputPaths(selection: FrameworkSelection): string[][] {
  const definition = getFrameworkDefinition(selection.workflow);
  return [
    ...definition.baseMarkers,
    ...selection.agents.flatMap((agent) => frameworkIntegrationPaths(selection.workflow, agent)),
    ...(selection.agents.includes('codex')
      ? [[...(selection.workflow === 'openspec' ? OPEN_SPEC_CODEX_TARGET_PATH : SPEC_KIT_CODEX_CONFIG_PATH)]]
      : [])
  ];
}

async function unexpectedMarkerIssue(
  root: string,
  pathParts: readonly string[]
): Promise<string | undefined> {
  const display = pathParts.join('/');
  const issue = await frameworkMarkerIssue(root, pathParts);
  if (issue?.startsWith('Missing framework marker:')) {
    return undefined;
  }
  return issue ?? `Unexpected framework marker: ${display}`;
}

async function validateSpecKitState(
  root: string,
  selection: FrameworkSelection
): Promise<string[]> {
  const issues: string[] = [];
  let parsed: unknown;
  try {
    const unsafe = await frameworkMarkerIssue(root, ['.specify', 'integration.json']);
    if (unsafe) {
      return [unsafe];
    }
    parsed = JSON.parse(await readFile(path.join(root, '.specify', 'integration.json'), 'utf8')) as unknown;
  } catch (error) {
    return [`Unable to read .specify/integration.json: ${error instanceof Error ? error.message : String(error)}`];
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return ['Spec Kit integration state must be a JSON object.'];
  }
  const state = parsed as Record<string, unknown>;
  const expectedDefault = selection.defaultAgent
    ? getCodingAgent(selection.defaultAgent)?.integrationIds['spec-kit']
    : undefined;
  const defaultIntegration = state.default_integration ?? state.integration;
  if (state.default_integration !== undefined && state.integration !== undefined &&
      state.default_integration !== state.integration) {
    issues.push('Spec Kit integration and default_integration disagree.');
  }
  if (defaultIntegration !== expectedDefault) {
    issues.push(`Spec Kit default integration is ${JSON.stringify(defaultIntegration)}; expected ${JSON.stringify(expectedDefault)}.`);
  }
  const installed = state.installed_integrations;
  if (!Array.isArray(installed) || installed.some((value) => typeof value !== 'string')) {
    issues.push('Spec Kit installed_integrations must be a string array.');
    return issues;
  }
  const expected = selection.agents.map((agent) => getCodingAgent(agent)!.integrationIds['spec-kit']);
  for (const integration of expected) {
    if (!installed.includes(integration)) {
      issues.push(`Spec Kit integration state does not include selected integration ${integration}.`);
    }
  }
  return issues;
}

export async function validateFrameworkInstallation(
  root: string,
  selection: FrameworkSelection
): Promise<string[]> {
  const definition = getFrameworkDefinition(selection.workflow);
  if (selection.agents.length === 0 ||
      new Set(selection.agents).size !== selection.agents.length ||
      selection.agents.some((agent) => getCodingAgent(agent)?.id !== agent)) {
    return ['Framework selection requires nonempty, unique canonical coding-agent IDs.'];
  }
  if (selection.defaultAgent && !selection.agents.includes(selection.defaultAgent)) {
    return ['Framework default agent must be one of the selected agents.'];
  }
  if (selection.workflow === 'openspec' && selection.defaultAgent) {
    return ['OpenSpec framework state cannot record a default agent.'];
  }
  const markers = [
    ...definition.baseMarkers,
    ...selection.agents.flatMap((agent) => agent === 'codex' ? frameworkIntegrationPaths(selection.workflow, agent) : definition.agentMarkers[agent])
  ];
  const issues = (await Promise.all(markers.map((marker) => frameworkMarkerIssue(root, marker))))
    .filter((issue): issue is string => issue !== undefined);
  if (selection.workflow === 'openspec' && selection.agents.includes('codex')) {
    const targetIssue = await frameworkMarkerIssue(root, OPEN_SPEC_CODEX_TARGET_PATH);
    if (!targetIssue) {
      const target = await readFile(path.join(root, ...OPEN_SPEC_CODEX_TARGET_PATH), 'utf8');
      if (target.trim() !== 'codex') {
        issues.push('OpenSpec shared skills target does not identify the selected Codex integration.');
      }
    } else if (!targetIssue.startsWith('Missing framework marker:')) {
      issues.push(targetIssue);
    }
  }
  if (selection.workflow === 'spec-kit' && !selection.defaultAgent) {
    issues.push('Spec Kit framework state is missing its default agent.');
  } else if (selection.workflow === 'spec-kit') {
    issues.push(...await validateSpecKitState(root, selection));
  }
  return issues;
}

export async function validateFrameworkInitialization(
  root: string,
  selection: FrameworkSelection,
  copilotCloud: boolean
): Promise<string[]> {
  const issues = await validateFrameworkInstallation(root, selection);
  if (selection.workflow !== 'openspec') {
    return issues;
  }

  const integrationMarkers = selection.agents.flatMap((agent) =>
    openSpecIntegrationPaths(agent)
  );
  const integrationIssues = (await Promise.all(
    integrationMarkers.map((marker) => frameworkMarkerIssue(root, marker))
  )).filter((issue): issue is string => issue !== undefined);
  const cloudIssues = copilotCloud
    ? (await Promise.all(
        OPEN_SPEC_COPILOT_CLOUD_PATHS.map((marker) => frameworkMarkerIssue(root, marker))
      )).filter((issue): issue is string => issue !== undefined)
    : (await Promise.all(
        OPEN_SPEC_COPILOT_CLOUD_PATHS.map((marker) => unexpectedMarkerIssue(root, marker))
      )).filter((issue): issue is string => issue !== undefined);
  return [...new Set([...issues, ...integrationIssues, ...cloudIssues])];
}

export function frameworkSelectionFromPlan(
  plan: Pick<ProjectPlan, 'specWorkflow' | 'agents' | 'defaultAgent'>
): FrameworkSelection {
  return {
    workflow: plan.specWorkflow.id,
    agents: plan.agents.map((agent) => agent.id),
    ...(plan.defaultAgent ? { defaultAgent: plan.defaultAgent.id } : {})
  };
}
