import { describe, expect, it } from 'vitest';
import { observeOrPollWorkflowRun as publicRunReader } from '../src/adapters/github/production-checks.js';
import { validateWorkflowRunBinding as publicBindingValidator } from '../src/adapters/github/workflow-dispatch.js';
import {
  readbackWorkflowContent as publicSourceReader,
  readbackControlledNodeFixture as publicFixtureReader,
  readbackValidationSource as publicValidationReader
} from '../src/adapters/github/production-workflows.js';
import {
  observeOrPollWorkflowRun, validateWorkflowRunBinding, type WorkflowRunBinding
} from '../src/adapters/github/workflow-run-readback.js';
import {
  readbackWorkflowContent, readbackControlledNodeFixture, readbackValidationSource
} from '../src/adapters/github/workflow-source-readback.js';

describe('acyclic workflow reader exports', () => {
  it('preserves existing public entrypoints as the same shared reader implementations', () => {
    expect(publicRunReader).toBe(observeOrPollWorkflowRun);
    expect(publicBindingValidator).toBe(validateWorkflowRunBinding);
    expect(publicSourceReader).toBe(readbackWorkflowContent);
    expect(publicFixtureReader).toBe(readbackControlledNodeFixture);
    expect(publicValidationReader).toBe(readbackValidationSource);
  });

  it('preserves strict immutable run binding admission in the shared module', () => {
    const binding: WorkflowRunBinding = {
      repository: 'owner/repo', repositoryId: 42, workflowPath: '.github/workflows/verify.yml',
      workflowId: 4, workflowDigest: 'a'.repeat(64), sourceSha: 'b'.repeat(40),
      ref: 'develop', actorId: 7, event: 'workflow_dispatch', expectedJobs: ['verify'], runAttempt: 1
    };
    expect(() => validateWorkflowRunBinding(binding)).not.toThrow();
    expect(() => validateWorkflowRunBinding({ ...binding, workflowDigest: 'unbound' })).toThrow(/exact immutable source/);
    expect(() => validateWorkflowRunBinding({ ...binding, runAttempt: 2 })).toThrow(/first attempt/);
    expect(() => validateWorkflowRunBinding({ ...binding, ref: '../main' })).toThrow(/safe branch/);
    expect(() => validateWorkflowRunBinding({ ...binding, expectedJobs: ['verify', 'verify'] })).toThrow(/real jobs/);
  });
});
