import { builtinDescriptor, lifecycleArtifact } from '../core.js';

/** Spec Kit seeds and its two framework-owned templates. */
export const specKitPlugin = builtinDescriptor({
  category: 'workflow',
  id: 'spec-kit',
  contentVersion: 1,
  supports: [{}],
  artifacts: [
    lifecycleArtifact('spec-kit-constitution', 'seed', ['.specify', 'memory', 'constitution.md'], 'seed'),
    lifecycleArtifact('spec-kit-spec-template', 'framework', ['.specify', 'templates', 'spec-template.md'], 'framework'),
    lifecycleArtifact('spec-kit-plan-template', 'framework', ['.specify', 'templates', 'plan-template.md'], 'framework'),
    lifecycleArtifact('specs-placeholder', 'seed', ['specs', '.gitkeep'], 'seed'),
    lifecycleArtifact('spec-kit-bootstrap-spec', 'seed', ['specs', '000-liftoff-bootstrap', 'spec.md'], 'seed'),
    lifecycleArtifact('spec-kit-bootstrap-plan', 'seed', ['specs', '000-liftoff-bootstrap', 'plan.md'], 'seed'),
    lifecycleArtifact('spec-kit-bootstrap-tasks', 'seed', ['specs', '000-liftoff-bootstrap', 'tasks.md'], 'seed')
  ]
});
