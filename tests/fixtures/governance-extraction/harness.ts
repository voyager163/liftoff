import { createHash } from 'node:crypto';
import { globSync, readFileSync, statSync } from 'node:fs';
import { realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { vi } from 'vitest';
import * as governance from '../../../src/repository-governance.js';
import { buildProjectPlan } from '../../../src/application/project/planning.js';
import { createFixtureProject } from '../../../src/application/initialize/fixture.js';
import { runCommand } from '../../../src/commands.js';
import { parseArgs } from '../../../src/cli/args/parser.js';
import type { ProjectOptions, ProjectPlan } from '../../../src/domain/project/contracts.js';
import { CaptureStream, ReadyInitRunner } from '../../helpers.js';

// Task 2.1 parity harness. Its bytes are recorded in the pre-extraction capture and the
// comparison refuses a different harness, so no normalization can be added after the move.
export type Snapshot = Record<string, unknown>;

export const harnessFile = 'tests/fixtures/governance-extraction/harness.ts';
export const acceptedSourceInventory = {
  fileCount: 318,
  digest: 'sha256:0efdacfad22b708511c6f599847403cbb3cc7fef1df4f40f4457c80569d40d6f'
} as const;
export const acceptedPreExtractionSources: Readonly<Record<string, string>> = {
  'src/repository-governance.ts': '51faf485e58482b098a9a0117a74fcc4ad4e186fba0b6c9cf66b2174e2b90138',
  'src/governance-activation/commands.ts': 'c19b97619e838e5b60fd87cfff17992c91cdb253a745776f74cae98bdc1cb298'
};
const fixedNow = new Date('2026-09-04T00:00:00.000Z');
const inlineTextLimit = 8192;
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

// The coverage gate's runtime inventory: tsconfig include src/**/*.ts without declarations,
// digested as sorted `path\0sha256\n` entries.
export function sourceTreeInventory(root = process.cwd()): { fileCount: number; digest: string } {
  const files = globSync('src/**/*.ts', { cwd: root }).map((file) => file.split(path.sep).join('/'))
    .filter((file) => !file.endsWith('.d.ts') && statSync(path.join(root, file)).isFile())
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file}\0${sha256(readFileSync(path.join(root, file)))}\n`);
  return { fileCount: files.length, digest: `sha256:${hash.digest('hex')}` };
}

const stacks: Readonly<Record<string, ProjectOptions>> = {
  'standard-python': { projectType: 'standard', apiStack: 'python' },
  'standard-node-frontend': { projectType: 'standard', apiStack: 'node', includeFrontend: true },
  'standard-go': { projectType: 'standard', apiStack: 'go' },
  'genai-rag': { pattern: 'rag' },
  'genai-streaming': { pattern: 'streaming' }
};

const selections: Readonly<Record<string, ProjectOptions>> = {
  'openspec-copilot': { specWorkflow: 'openspec', agents: ['github-copilot'] },
  'spec-kit-claude-dev': { specWorkflow: 'spec-kit', agents: ['claude'], defaultAgent: 'claude', environments: ['dev'] },
  'openspec-all-agents': { specWorkflow: 'openspec', agents: ['github-copilot', 'claude', 'codex'] },
  'spec-kit-copilot-codex': { specWorkflow: 'spec-kit', agents: ['github-copilot', 'codex'], defaultAgent: 'codex' },
  'governance-none-codex': { specWorkflow: 'openspec', agents: ['codex'], governanceProfile: 'none' }
};

function plan(options: ProjectOptions): ProjectPlan {
  return buildProjectPlan({
    projectName: 'Governance Extraction', cloud: 'azure', region: 'eastus', environments: ['dev', 'staging', 'prod'], ...options
  }, { requireProjectName: true });
}

function outcome(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return error instanceof Error ? `${error.constructor.name}: ${error.message}` : `thrown: ${String(error)}`;
  }
  return 'accepted';
}

export function renderingSnapshot(): Snapshot {
  const artifacts: Record<string, unknown> = {};
  for (const [stack, stackOptions] of Object.entries(stacks)) {
    for (const [selection, selectionOptions] of Object.entries(selections)) {
      artifacts[`${stack}/${selection}`] = governance.buildRepositoryGovernanceArtifacts(plan({ ...stackOptions, ...selectionOptions }))
        .map((artifact) => ({
          logicalName: artifact.logicalName, category: artifact.category, lifecycle: artifact.lifecycle,
          path: artifact.pathParts.join('/'), bytes: Buffer.byteLength(artifact.content), sha256: sha256(artifact.content)
        }));
    }
  }
  const contexts: Record<string, string> = {};
  for (const stack of ['standard-python', 'standard-node-frontend', 'genai-rag']) {
    const target = plan({ ...stacks[stack], ...selections['openspec-copilot'] });
    for (const layout of ['default', 'independent', 'legacy-shared', 'unknown'] as const) {
      contexts[`${stack}/${layout}`] = sha256(governance.renderGovernanceContext(target,
        layout === 'default' ? {} : { infrastructureLayout: layout }));
    }
  }
  const single = plan({ ...stacks['standard-python'], ...selections['openspec-copilot'] });
  const all = plan({ ...stacks['standard-python'], ...selections['openspec-all-agents'] });
  contexts.unsupportedLayout = outcome(() => governance.renderGovernanceContext(single,
    { infrastructureLayout: 'shared' as never }));
  const invocations: Record<string, string> = {};
  for (const [label, target] of [['none', { agents: [] }], ['single', single], ['all', all]] as const) {
    for (const operation of ['setup', 'assessment', 'repair'] as const) {
      invocations[`${label}/${operation}`] = governance.governanceInvocationGuide(target as Pick<ProjectPlan, 'agents'>, operation);
    }
  }
  invocations['single/default'] = governance.governanceInvocationGuide(single);
  const policy = governance.renderCanonicalGovernancePolicy();
  const context = JSON.parse(governance.renderGovernanceContext(single)) as Record<string, unknown>;
  const policyBlock = context.policy as Record<string, unknown>;
  return {
    constants: {
      governancePolicySchemaVersion: governance.governancePolicySchemaVersion,
      governancePolicyVersion: governance.governancePolicyVersion,
      governanceContextSchemaVersion: governance.governanceContextSchemaVersion,
      governanceArtifactPaths: sha256(JSON.stringify(governance.governanceArtifactPaths)),
      governanceAgentIntegrations: sha256(JSON.stringify(governance.governanceAgentIntegrations))
    },
    artifacts,
    contexts,
    invocations,
    assessmentGuides: {
      default: sha256(governance.renderGovernanceAssessmentGuide()),
      single: sha256(governance.renderGovernanceAssessmentGuide(single)),
      all: sha256(governance.renderGovernanceAssessmentGuide(all))
    },
    policy: sha256(policy),
    credentialPolicySchema: sha256(governance.renderCredentialPolicySchema()),
    validation: {
      policyValid: outcome(() => governance.validateGovernancePolicy(policy)),
      policyEmpty: outcome(() => governance.validateGovernancePolicy('')),
      policyForbidden: outcome(() => governance.validateGovernancePolicy(`${policy}\nregister all Azure providers\n`)),
      policyInvariant: outcome(() => governance.validateGovernancePolicy(
        policy.replace(/No change in this repository\s+requires another person's approval/u, 'Changes require review'))),
      contentSafe: outcome(() => governance.assertGovernanceContentSafe(policy)),
      contentUnsafe: outcome(() => governance.assertGovernanceContentSafe(`value ${['ghp', 'A'.repeat(36)].join('_')}`)),
      contextValid: outcome(() => governance.validateGovernanceContext(context)),
      contextNull: outcome(() => governance.validateGovernanceContext(null)),
      contextSchema: outcome(() => governance.validateGovernanceContext({ ...context, schemaVersion: 2 })),
      contextPolicyMissing: outcome(() => governance.validateGovernanceContext({ ...context, policy: undefined })),
      contextLiveClaim: outcome(() => governance.validateGovernanceContext({ ...context, policy: { ...policyBlock, liveEnforcement: 'active' } })),
      contextDiscoveryMissing: outcome(() => governance.validateGovernanceContext({ ...context, discovery: undefined })),
      contextFabricatedDiscovery: outcome(() => governance.validateGovernanceContext({
        ...context, discovery: { ...(context.discovery as object), rulesets: 'observed' }
      })),
      contextCommandsEmpty: outcome(() => governance.validateGovernanceContext({ ...context, commands: [] })),
      contextBoundariesMissing: outcome(() => governance.validateGovernanceContext({ ...context, generatedBoundaries: undefined }))
    }
  };
}

function streamRecord(text: string): Snapshot {
  const bytes = Buffer.byteLength(text);
  return bytes <= inlineTextLimit ? { bytes, sha256: sha256(text), text } : { bytes, sha256: sha256(text) };
}

export async function cliSnapshot(): Promise<Snapshot> {
  vi.useFakeTimers({ toFake: ['Date'], now: fixedNow });
  const root = await createFixtureProject({
    projectName: 'Governance CLI Parity', projectType: 'standard', apiStack: 'node', cloud: 'azure', region: 'eastus',
    environments: ['dev'], specWorkflow: 'openspec', agents: ['github-copilot']
  });
  const temporaryRoot = path.dirname(root);
  const userStateRoot = process.env.LIFTOFF_TEST_USER_STATE_ROOT ?? process.env.HOME ?? '';
  const replacements: Array<[string, string]> = [];
  const addReplacement = async (value: string, placeholder: string) => {
    if (!value) return;
    for (const candidate of new Set([value, await realpath(value).catch(() => value)])) replacements.push([candidate, placeholder]);
  };
  await addReplacement(root, '<project>');
  await addReplacement(temporaryRoot, '<temporary>');
  await addReplacement(userStateRoot, '<user-state>');
  const normalize = (text: string) => [...replacements].sort((left, right) => right[0].length - left[0].length)
    .reduce((current, [value, placeholder]) => current.split(value).join(placeholder), text);
  const results: Record<string, unknown> = {};
  const run = async (label: string, args: readonly string[], options: {
    cwd?: string; human?: boolean; learn?: (rawStdout: string) => void;
  } = {}) => {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    let exitCode: number | string;
    try {
      // As in the lifecycle snapshots, the renderer applies the same replacements before panel
      // layout, so wrapping never depends on the host's temporary-path length.
      exitCode = await runCommand(parseArgs([...args]), {
        cwd: options.cwd ?? root, stdout, stderr, runner: new ReadyInitRunner(),
        terminal: { snapshot: true, columns: options.human ? 400 : 100, normalize }
      });
    } catch (error) {
      exitCode = `thrown: ${error instanceof Error ? error.message : String(error)}`;
    }
    options.learn?.(stdout.text());
    results[label] = { exitCode, stdout: streamRecord(normalize(stdout.text())), stderr: streamRecord(normalize(stderr.text())) };
  };
  // Preview identities hash the absolute project path, so they are masked like the contract baseline's volatile pointers.
  let fingerprint: string | undefined;
  const learnPreview = (rawStdout: string) => {
    const planned = JSON.parse(rawStdout) as { preview?: { fingerprint?: string; path?: string } | null; plan?: { planDigest?: string } | null };
    fingerprint = planned.preview?.fingerprint;
    const base = planned.preview?.path ? path.basename(planned.preview.path) : '';
    const prefix = 'governance-preview-';
    const suffix = fingerprint ? `-${fingerprint}.json` : '';
    const projectKey = fingerprint && base.startsWith(prefix) && base.endsWith(suffix) ? base.slice(prefix.length, base.length - suffix.length) : undefined;
    for (const [value, placeholder] of [[fingerprint, '<fingerprint>'], [planned.plan?.planDigest, '<plan-digest>'], [projectKey, '<project-key>']] as const) {
      if (value) replacements.push([value, placeholder]);
    }
  };
  try {
    await run('missing-subcommand', ['governance']);
    await run('status-json', ['governance', 'status', '--json']);
    await run('status-human', ['governance', 'status'], { human: true });
    await run('status-local-json', ['governance', 'status', '--scope', 'local', '--json']);
    await run('status-invalid-scope', ['governance', 'status', '--scope', 'bogus', '--json']);
    await run('status-duplicate-project', ['governance', 'status', root, '--project', root, '--json']);
    await run('status-outside-project', ['governance', 'status', '--json'], { cwd: temporaryRoot });
    await run('verify-json', ['governance', 'verify', '--json']);
    await run('verify-human', ['governance', 'verify'], { human: true });
    await run('resume-json', ['governance', 'resume', '--json']);
    await run('apply-next-preview-json', ['governance', 'apply-next', '--json']);
    await run('apply-next-local-preview-human', ['governance', 'apply-next', '--scope', 'local'], { human: true });
    await run('plan-json', ['governance', 'plan', '--json'], { learn: learnPreview });
    const reviewed = fingerprint ?? 'f'.repeat(64);
    await run('plan-human', ['governance', 'plan'], { human: true });
    await run('credential-enroll-wrong-preview', ['governance', 'credential-enroll', '--plan', reviewed, '--json']);
    await run('recover-non-recovery-preview', ['governance', 'recover', '--plan', reviewed, '--json']);
    await run('approve-missing-preview', ['governance', 'approve', '--plan', '0'.repeat(64), '--json']);
    await run('credential-enroll-missing-preview', ['governance', 'credential-enroll', '--plan', 'e'.repeat(64)]);
    return { previewCreated: fingerprint !== undefined, results };
  } finally {
    vi.useRealTimers();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
