import { specKitBootstrapId, specKitBootstrapPath, specKitBootstrapTaskIds, appendSpecKitDocumentIssues, appendSpecKitTaskIssues } from '../domain/governance/activation/local-check-values.js';
export { specKitBootstrapId, specKitBootstrapPath, specKitBootstrapTaskIds };
import { readProjectFile } from '../adapters/filesystem/project-files.js';
import { validateFrameworkInstallation } from '../framework-validation.js';
import type { LiftoffManifest } from '../domain/project/contracts.js';


export async function inspectSpecKitBootstrap(
  projectRoot: string,
  manifest: LiftoffManifest
): Promise<{ issues: string[]; tasks?: string }> {
  const issues: string[] = [];
  let tasks: string | undefined;
  for (const name of ['spec', 'plan', 'tasks'] as const) {
    const parts = [...specKitBootstrapPath, `${name}.md`];
    const bytes = await readProjectFile(projectRoot, parts);
    if (!bytes) {
      issues.push(`Spec Kit seed-adoption-required: ${parts.join('/')} is missing. Separately reviewed project adoption is required; update, force, and inspection do not create it.`);
      continue;
    }
    const text = bytes.toString('utf8');
    appendSpecKitDocumentIssues(name, text, parts, issues);
    if (name === 'tasks') {
      tasks = text;
      appendSpecKitTaskIssues(text, issues);
    }
  }
  // Official installation state is independent of the project-owned bundle.
  issues.push(...await validateFrameworkInstallation(projectRoot, {
    workflow: 'spec-kit', agents: [...manifest.project.agents], defaultAgent: manifest.project.defaultAgent
  }));
  return { issues, tasks };
}

export function completedSpecKitTasks(tasks: string): string {
  return tasks.replace(/^(\s*- \[)[ xX](\] B00[1-6] )/gm, '$1x$2');
}
