import { readProjectFile } from '../adapters/filesystem/project-files.js';
import { validateFrameworkInstallation } from '../framework-validation.js';
import type { LiftoffManifest } from '../domain/project/contracts.js';

export const specKitBootstrapId = '000-liftoff-bootstrap';
export const specKitBootstrapPath = ['specs', specKitBootstrapId] as const;
export const specKitBootstrapTaskIds = ['B001', 'B002', 'B003', 'B004', 'B005', 'B006'] as const;

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
    if (!text.includes(`Bootstrap identity: \`${specKitBootstrapId}\``)) {
      issues.push(`${parts.join('/')} must declare the real ${specKitBootstrapId} bootstrap identity, not a framework template.`);
    }
    if (name === 'spec' && !/^## Requirements\s*$/m.test(text)) issues.push('Bootstrap spec requires explicit requirements.');
    if (name === 'plan' && (!/^## Verification\s*$/m.test(text) || !text.includes('specs/000-liftoff-bootstrap/spec.md'))) {
      issues.push('Bootstrap plan must reference its real spec and local verification plan.');
    }
    if (name === 'tasks') {
      tasks = text;
      for (const id of specKitBootstrapTaskIds) {
        if ([...text.matchAll(new RegExp(`^\\s*- \\[[ xX]\\] ${id} `, 'gm'))].length !== 1) {
          issues.push(`Bootstrap task ${id} must occur exactly once.`);
        }
      }
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
