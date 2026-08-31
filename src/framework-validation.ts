import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { getFrameworkDefinition } from './catalogs.js';
import type { CodingAgentId, ProjectPlan, SpecWorkflowId } from './types.js';

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

async function markerIssue(root: string, pathParts: string[]): Promise<string | undefined> {
  const display = pathParts.join('/');
  try {
    const details = await lstat(path.join(root, ...pathParts));
    if (details.isSymbolicLink()) {
      return `Framework marker is a forbidden symlink: ${display}`;
    }
    if (!details.isFile()) {
      return `Framework marker is not a regular file: ${display}`;
    }
    return undefined;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return `Missing framework marker: ${display}`;
    }
    return `Unable to inspect framework marker ${display}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function validateSpecKitState(
  root: string,
  selection: FrameworkSelection
): Promise<string[]> {
  const issues: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path.join(root, '.specify', 'integration.json'), 'utf8')) as unknown;
  } catch (error) {
    return [`Unable to read .specify/integration.json: ${error instanceof Error ? error.message : String(error)}`];
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return ['Spec Kit integration state must be a JSON object.'];
  }
  const state = parsed as Record<string, unknown>;
  const expectedDefault = selection.defaultAgent === 'github-copilot' ? 'copilot' : selection.defaultAgent;
  const defaultIntegration = state.default_integration ?? state.integration;
  if (defaultIntegration !== expectedDefault) {
    issues.push(`Spec Kit default integration is ${JSON.stringify(defaultIntegration)}; expected ${JSON.stringify(expectedDefault)}.`);
  }
  const installed = state.installed_integrations;
  if (!Array.isArray(installed) || installed.some((value) => typeof value !== 'string')) {
    issues.push('Spec Kit installed_integrations must be a string array.');
    return issues;
  }
  const expected = selection.agents.map((agent) => agent === 'github-copilot' ? 'copilot' : agent);
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
  const markers = [
    ...definition.baseMarkers,
    ...selection.agents.flatMap((agent) => definition.agentMarkers[agent])
  ];
  const issues = (await Promise.all(markers.map((marker) => markerIssue(root, marker))))
    .filter((issue): issue is string => issue !== undefined);
  if (selection.workflow === 'spec-kit' && !selection.defaultAgent) {
    issues.push('Spec Kit framework state is missing its default agent.');
  } else if (selection.workflow === 'spec-kit') {
    issues.push(...await validateSpecKitState(root, selection));
  }
  return issues;
}

export function frameworkSelectionFromPlan(plan: ProjectPlan): FrameworkSelection {
  return {
    workflow: plan.specWorkflow.id,
    agents: plan.agents.map((agent) => agent.id),
    ...(plan.defaultAgent ? { defaultAgent: plan.defaultAgent.id } : {})
  };
}
