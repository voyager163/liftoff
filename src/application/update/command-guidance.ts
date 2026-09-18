import {
  commandShellForPlatform,
  formatShellDirectoryCommands
} from '../../adapters/process/shell-command.js';
import type { ExternalCommand } from '../../domain/project/contracts.js';
import { localSeedPhaseLabel } from '../../governance-activation/seed-lifecycle.js';
import { createStructuredContinuation, type StructuredContinuationV1 } from '../../protocol/continuation.js';

export function formatRevalidationPhaseBlocker(
  nextIncomplete: string | null,
  nextReady: string | null,
  approvedPhase: string,
  blockers: readonly string[]
): string | undefined {
  const describe = (phase: string) => `${localSeedPhaseLabel(phase)} (${phase})`;
  if (nextIncomplete !== approvedPhase) {
    return `The next incomplete phase is ${nextIncomplete ? describe(nextIncomplete) : 'none'}, but the approved operation is ${describe(approvedPhase)}. Obtain a fresh preview; phase order cannot be skipped. ${blockers.join(' ')}`.trim();
  }
  if (nextReady !== approvedPhase) {
    return `${describe(approvedPhase)} is the next incomplete phase but is not ready to execute. ${blockers.join(' ') || 'Its current prerequisites are not satisfied; inspect the local governance plan before retrying.'}`;
  }
  return undefined;
}

export type UpdateCommandMode = 'normal' | 'force' | 'check';

export type UpdateGuidanceText = string | readonly (string | {
  readonly projectRoot: string;
  readonly mode?: UpdateCommandMode;
})[];

export interface ResolvedUpdateGuidanceContext {
  readonly state: 'resolved';
  readonly requestedProjectRoot: string;
  readonly projectRoot: string;
  readonly invocationDirectory: string;
  readonly implicitProjectRoot?: string;
}

export type UpdateGuidanceContext = ResolvedUpdateGuidanceContext | {
  readonly state: 'unresolved';
  readonly detail: string;
};

function targetsProject(
  projectRoot: string,
  context?: UpdateGuidanceContext
): context is ResolvedUpdateGuidanceContext {
  return context?.state === 'resolved' &&
    (projectRoot === context.projectRoot || projectRoot === context.requestedProjectRoot);
}

export function createUpdateContinuation(
  projectRoot: string,
  mode: UpdateCommandMode = 'normal',
  platform?: NodeJS.Platform,
  context?: UpdateGuidanceContext
): StructuredContinuationV1 {
  const root = targetsProject(projectRoot, context) ? context.projectRoot : projectRoot;
  return createStructuredContinuation({
    executable: 'liftoff',
    args: ['update', ...(mode === 'normal' ? [] : [`--${mode}`]),
      '--project', root],
    cwd: root, project: root, scope: 'project-update', targetScope: 'project',
    requiredAuthority: mode === 'check' ? [] : ['reviewed-plan'],
    compatibilityIdentity: 'update-output-v3', platform
  });
}

export function formatUpdateCommand(
  projectRoot: string,
  mode: UpdateCommandMode = 'normal',
  platform?: NodeJS.Platform,
  context?: UpdateGuidanceContext
): string {
  return createUpdateContinuation(projectRoot, mode, platform, context).displayCommand;
}

export function formatUpdateGuidanceText(
  text: UpdateGuidanceText,
  context?: UpdateGuidanceContext,
  platform: NodeJS.Platform = process.platform
): string {
  return typeof text === 'string' ? text : text.map((part) =>
    typeof part === 'string' ? part : formatUpdateCommand(part.projectRoot, part.mode, platform, context)
  ).join('');
}

export function formatUpdateValidationCommands(
  projectRoot: string,
  platform: NodeJS.Platform = process.platform,
  context?: UpdateGuidanceContext
): string {
  const root = targetsProject(projectRoot, context) ? context.projectRoot : projectRoot;
  const validation = createStructuredContinuation({
    args: ['validate'], cwd: root, project: root, scope: 'project-validation',
    requiredAuthority: [], platform
  });
  const diagnosis = createStructuredContinuation({
    args: ['doctor'], cwd: root, project: root, scope: 'project-diagnosis',
    requiredAuthority: [], platform
  });
  const commands: readonly [ExternalCommand, ...ExternalCommand[]] = [
    { executable: validation.executable, args: [...validation.args] },
    { executable: diagnosis.executable, args: [...diagnosis.args] }
  ];
  return formatShellDirectoryCommands(commands, root, commandShellForPlatform(platform));
}
