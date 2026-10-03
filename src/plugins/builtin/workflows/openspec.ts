import { bootstrapChangeToken } from '../../../domain/project/artifact-path-tokens.js';
import {
  builtinDescriptor,
  builtinPatternIds,
  builtinStackIds,
  lifecycleArtifact
} from '../core.js';

/*
 * OpenSpec seeds. The bootstrap change directory is project-specific, so it is declared with the
 * reserved token and materialized per plan before rendering; the seed capability follows the stack
 * for standard APIs and the pattern for GenAI.
 */

const change = ['openspec', 'changes', bootstrapChangeToken] as const;

export const openSpecPlugin = builtinDescriptor({
  category: 'workflow',
  id: 'openspec',
  contentVersion: 1,
  supports: [{}],
  artifacts: [
    lifecycleArtifact('openspec-config', 'seed', ['openspec', 'config.yaml'], 'seed'),
    lifecycleArtifact('openspec-seed-change-metadata', 'seed', [...change, '.openspec.yaml'], 'seed'),
    lifecycleArtifact('openspec-seed-proposal', 'seed', [...change, 'proposal.md'], 'seed'),
    lifecycleArtifact('openspec-seed-design', 'seed', [...change, 'design.md'], 'seed'),
    lifecycleArtifact('openspec-seed-tasks', 'seed', [...change, 'tasks.md'], 'seed'),
    ...builtinStackIds.map((stack) => lifecycleArtifact(
      'openspec-seed-spec',
      'seed',
      [...change, 'specs', `${stack}-application-baseline`, 'spec.md'],
      'seed',
      { workload: ['standard'], stack: [stack] }
    )),
    ...builtinPatternIds.map((pattern) => lifecycleArtifact(
      'openspec-seed-spec',
      'seed',
      [...change, 'specs', `${pattern}-application-baseline`, 'spec.md'],
      'seed',
      { variant: [pattern] }
    )),
    lifecycleArtifact('openspec-spec-placeholder', 'seed', ['openspec', 'specs', '.gitkeep'], 'seed')
  ]
});
