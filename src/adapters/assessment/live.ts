import { devNull } from 'node:os';
import { inspectAssessmentGit, type AssessmentGitFacts } from '../git/governance-assessment.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import type { ProjectAssessmentProfile } from '../../domain/assessment/report.js';
import {
  assessmentLimits, type AssessmentDiagnostic, type LiveAssessmentResult, type LiveAssessmentScope
} from '../../domain/governance/assessment/types.js';
import { collectLiveAssessment } from '../../governance-assessment/live.js';
import { NodeCommandRunner, type CommandRunner } from '../../process-runner.js';

export interface ProjectLiveMetadata extends LiveAssessmentResult {
  gitMetadataDigest: string;
  inputsStable: boolean;
}

export function gitConfigNullFile(platform: NodeJS.Platform = process.platform): string {
  // Git for Windows does not accept Node's \\.\nul device pathname as a config file.
  return platform === 'win32' ? 'NUL' : devNull;
}

function metadataDigest(facts: AssessmentGitFacts): string {
  return canonicalSha256({
    isRepository: facts.isRepository,
    repository: facts.repository,
    pushUrls: facts.originState === 'verified' ? facts.pushUrls : [],
    head: facts.head,
    originState: facts.originState,
    issues: facts.issues
  });
}

function metadataRunner(runner: CommandRunner): CommandRunner {
  return {
    async run(command, options = {}) {
      if (command.executable !== 'git') throw new Error('Local metadata inspection accepts only Git reads.');
      const environment: NodeJS.ProcessEnv = { ...options.env };
      for (const key of Object.keys(process.env)) {
        if (key.toUpperCase().startsWith('GIT_')) environment[key] = undefined;
      }
      Object.assign(environment, {
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitConfigNullFile(), GIT_CONFIG_COUNT: '0',
        GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0'
      });
      const result = await runner.run(command, {
        ...options, env: environment,
        timeoutMs: Math.min(options.timeoutMs ?? 10_000, 10_000),
        maxOutputBytes: Math.min(options.maxOutputBytes ?? assessmentLimits.fileBytes, assessmentLimits.fileBytes)
      });
      return result.outputLimitExceeded || result.aborted || result.processTreeSettled === false || result.signal !== null
        ? { ...result, errorCode: result.errorCode ?? 'GIT_METADATA_INCOMPLETE' } : result;
    }
  };
}

export async function observeProjectGitMetadata(root: string, runner: CommandRunner) {
  const facts = await inspectAssessmentGit(root, metadataRunner(runner));
  return { facts, digest: metadataDigest(facts) };
}

export async function inspectProjectLiveMetadata(input: {
  root: string;
  profile: ProjectAssessmentProfile;
  environments: readonly string[];
  runner?: CommandRunner;
  now?: () => Date;
}): Promise<ProjectLiveMetadata> {
  const runner = input.runner ?? new NodeCommandRunner();
  const original = await observeProjectGitMetadata(input.root, runner);
  const before = original.facts;
  const scope: LiveAssessmentScope = {
    repository: before.originState === 'verified' ? before.repository : null,
    refs: input.profile === 'none' ? [] : ['main', 'develop'],
    refPrefixes: input.profile === 'none' ? [] : ['release/', 'hotfix/'],
    environments: [...input.environments],
    runner: null,
    azure: []
  };
  const collected = await collectLiveAssessment(scope, {
    runner,
    ...(input.now === undefined ? {} : { now: input.now })
  });
  const after = await observeProjectGitMetadata(input.root, runner);
  const gitMetadataDigest = original.digest;
  const stable = gitMetadataDigest === after.digest;
  const diagnostics: AssessmentDiagnostic[] = [
    ...collected.diagnostics,
    ...before.issues.map(message => ({
      code: 'live-project-git-unobserved', severity: 'warning' as const,
      source: 'git', message
    })),
    ...(!stable ? [{
      code: 'live-project-git-changed', severity: 'warning' as const, source: 'git',
      message: 'The selected Git metadata changed during collection; previously scoped facts are not current proof.'
    }] : [])
  ];
  return {
    ...collected,
    diagnostics,
    gitMetadataDigest,
    inputsStable: stable && collected.refsStable
  };
}
