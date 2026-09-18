import { getApplicationEngines } from '../../application/engine-composition.js';
import {
  projectPlanEntries
} from '../../domain/project/planning.js';
import type {
  ExecutionContext
} from '../../application/context.js';
import type {
  ParsedArgs
} from '../../domain/project/contracts.js';
import {
  optionsFromParsedArgs
} from '../project-options.js';
import { formatRequirementVersion } from '../../domain/workstation/constraints.js';

export async function planCommand(parsed: ParsedArgs, context: ExecutionContext): Promise<number> {
  const { presentation } = context;
  presentation.identity('Preview project decisions, artifacts, and workstation requirements');
  const options = await optionsFromParsedArgs(parsed, context.cwd, false);
  const { plan, artifacts, requirements } = (await getApplicationEngines(context))['project-generation'].previewProject(options);
  presentation.definitions('Project decisions', projectPlanEntries(plan));
  presentation.table(
    `Artifacts (${artifacts.length})`,
    ['Artifact', 'Lifecycle', 'Path'],
    artifacts.map((artifact) => [
      artifact.logicalName,
      artifact.lifecycle === 'project'
        ? `${artifact.lifecycle} (${artifact.provisioningGroup})`
        : artifact.lifecycle,
      artifact.pathParts.join('/')
    ])
  );
  const workstationRows = requirements.map((requirement) => [
    requirement.definition.label,
    formatRequirementVersion(requirement),
    requirement.severity
  ]);
  if (presentation.stdout.layout === 'plain') {
    presentation.section(
      'Workstation requirements',
      workstationRows.map(([label, version, severity]) => `${label}: ${version} [${severity}]`)
    );
  } else {
    presentation.table(
      'Workstation requirements',
      ['Requirement', 'Version', 'Level'],
      workstationRows
    );
  }
  return 0;
}
