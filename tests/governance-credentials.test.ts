import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildFineGrainedPatCredentialPolicy,
  buildPatEnrollmentGuidance,
  canonicalCredentialRepository,
  credentialPolicyPathParts,
  detectCredentialLeaks,
  discoverCredentialPlan,
  enrollFineGrainedPatCredential,
  runnerPreflightDisplayName,
  runnerPreflightPermissions,
  SensitiveCredentialValue,
  validateCredentialPolicy,
  validateCredentialPolicyUsage,
  writeRepositorySecretWithGitHubCli,
  type CredentialPolicy,
  type CredentialRepositoryIdentity,
  type CredentialWorkflowAllowlistEntry,
  type DiscoveredGitHubAppInstallation,
  type GitHubCredentialAdapter,
  type RepositorySecretReadback,
  currentActivationIdentity
} from '../src/governance-activation/index.js';
import { parseArgs } from '../src/args.js';
import { runCommand } from '../src/commands.js';
import { renderCanonicalGovernancePolicy } from '../src/repository-governance.js';
import { liftoffVersion } from '../src/version.js';
import { CaptureStream } from './helpers.js';
import type { CommandRunner, CommandResult, RunCommandOptions } from '../src/process-runner.js';
import type { ExternalCommand } from '../src/types.js';

const scratchRoot = path.join(process.cwd(), '.cache', 'governance-credential-tests');
const now = new Date('2026-09-04T00:00:00.000Z');
const digest = 'b'.repeat(64);
const syntheticToken = ['github', '_pat_', 'SYNTHETIC_VALUE_FOR_TESTS_ONLY_1234567890'].join('');

function repository(): CredentialRepositoryIdentity {
  return canonicalCredentialRepository({ id: 'R_repo', owner: 'octo-org', name: 'liftoff' });
}

function allowlist(): CredentialWorkflowAllowlistEntry[] {
  return [
    { path: '.github/workflows/bootstrap-import-preflight.yml', jobs: ['bootstrap-import-preflight'] },
    { path: '.github/workflows/private-dast-preflight.yml', jobs: ['private-dast-preflight'] }
  ];
}

function app(overrides: Partial<DiscoveredGitHubAppInstallation> = {}): DiscoveredGitHubAppInstallation {
  return {
    installationId: 42,
    appSlug: 'approved-runner-reader',
    approved: true,
    verified: true,
    selection: 'selected-repository',
    repositories: [repository()],
    permissions: runnerPreflightPermissions(),
    permissionsVerifiedAt: now.toISOString(),
    readbackDigest: digest,
    token: { canGenerate: true, ttlSeconds: 3600 },
    ...overrides
  };
}

class FixtureCredentialAdapter implements GitHubCredentialAdapter {
  installations: DiscoveredGitHubAppInstallation[] = [];
  captured: string | null = null;
  secretArgs: unknown[] = [];

  async discoverAppInstallations(): Promise<readonly DiscoveredGitHubAppInstallation[]> {
    return this.installations;
  }

  async readRepositorySecret(
    repo: CredentialRepositoryIdentity,
    secretName: 'RUNNER_CONFIGURATION_READ_TOKEN'
  ): Promise<RepositorySecretReadback | null> {
    return { repository: repo, secretName, updatedAt: now.toISOString(), readbackDigest: digest };
  }

  async setRepositorySecret(request: Parameters<NonNullable<GitHubCredentialAdapter['setRepositorySecret']>>[0]): Promise<RepositorySecretReadback> {
    this.secretArgs.push({ repository: request.repository, secretName: request.secretName });
    request.value.use((value) => {
      this.captured = value;
    });
    return { repository: request.repository, secretName: request.secretName, updatedAt: now.toISOString(), readbackDigest: digest };
  }
}

class CapturingRunner implements CommandRunner {
  command: ExternalCommand | null = null;
  stdin: string | Uint8Array | undefined;
  redactValues: readonly string[] | undefined;

  constructor(private readonly echoStdin = false) {}

  async run(command: ExternalCommand, options: RunCommandOptions = {}): Promise<CommandResult> {
    this.command = command;
    this.stdin = options.stdin;
    this.redactValues = options.redactValues;
    const echoed = this.echoStdin && typeof options.stdin === 'string' ? options.stdin : '';
    return {
      command,
      displayCommand: echoed ? `gh secret set ${echoed}` : [command.executable, ...command.args].join(' '),
      status: 0,
      signal: null,
      stdout: echoed ? `stored ${echoed}` : 'secret stored',
      stderr: echoed ? `warning ${echoed}` : '',
      timedOut: false
    };
  }
}

function patPolicy(overrides: Partial<CredentialPolicy> = {}): CredentialPolicy {
  return {
    ...buildFineGrainedPatCredentialPolicy({
      repository: repository(),
      allowedWorkflows: allowlist(),
      createdAt: now,
      proof: {
        verifiedAt: now.toISOString(),
        readbackDigest: digest,
        readbackProvider: 'adapter-fixture',
        payloadFree: true
      }
    }),
    ...overrides
  };
}

async function writeProject(name = 'credential-project'): Promise<string> {
  const root = path.join(scratchRoot, `${name}-${process.pid}`);
  await mkdir(path.join(root, '.liftoff', 'governance'), { recursive: true });
  await writeFile(path.join(root, '.liftoff', 'governance', 'policy.md'), renderCanonicalGovernancePolicy(), 'utf8');
  await writeFile(path.join(root, 'liftoff.manifest.json'), `${JSON.stringify({
    artifactVersion: 7,
    generatedBy: 'Mission Control Liftoff',
    liftoffVersion,
    project: {
      name,
      workload: { kind: 'standard', apiStack: 'node-fastify', cloud: 'azure', region: 'eastus', frontend: false, environments: ['dev'] },
      specWorkflow: 'openspec',
      agents: ['github-copilot']
    },
    framework: { state: 'initialized', adapter: 'openspec', contractVersion: '1.11.0' },
    governance: {
      profile: 'single-maintainer-gitflow',
      policyVersion: '6',
      activationIdentity: currentActivationIdentity,
      state: 'handoff-partial'
    },
    managedArtifacts: [],
    projectArtifacts: []
  }, null, 2)}\n`, 'utf8');
  return root;
}

async function run(args: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const code = await runCommand(parseArgs(args), {
    cwd,
    stdout,
    stderr,
    terminal: { snapshot: true, columns: 100 }
  });
  return { code, out: stdout.text(), err: stderr.text() };
}

beforeEach(async () => {
  await rm(scratchRoot, { recursive: true, force: true });
  await mkdir(scratchRoot, { recursive: true });
});

describe('governance credential discovery and policy validation', () => {
  it('prefers a verified selected-repository GitHub App and never installs or broadens one', async () => {
    const adapter = new FixtureCredentialAdapter();
    adapter.installations = [
      app({ selection: 'all-repositories' }),
      app()
    ];
    const plan = await discoverCredentialPlan({
      adapter,
      repository: repository(),
      allowedWorkflows: allowlist(),
      now
    });
    expect(plan.authKind).toBe('github-app');
    expect(plan.policy?.app?.installationId).toBe(42);
    expect(plan.policy?.app?.selection).toBe('selected-repository');
    expect(plan.policy?.app?.token).toMatchObject({ strategy: 'installation-token', ttlSeconds: 3600 });
    expect(adapter.secretArgs).toEqual([]);
    expect(plan.rejectionReasons.join('\n')).toContain('not selected-repository');
  });

  it('falls back to deterministic fine-grained PAT enrollment fields', async () => {
    const adapter = new FixtureCredentialAdapter();
    const plan = await discoverCredentialPlan({
      adapter,
      repository: repository(),
      allowedWorkflows: allowlist(),
      now
    });
    expect(plan.authKind).toBe('fine-grained-pat');
    expect(plan.fallbackGuidance).toMatchObject({
      displayNameTemplate: '<repo>-runner-preflight-read',
      displayName: 'liftoff-runner-preflight-read',
      secretName: 'RUNNER_CONFIGURATION_READ_TOKEN',
      lifetimeDays: 30,
      selectedRepositoryOnly: true,
      permissions: {
        repository: ['metadata:read'],
        organization: ['hosted-runners:read', 'network-configurations:read']
      },
      writes: []
    });
    expect(plan.fallbackGuidance?.expiresAt).toBe('2026-10-04T00:00:00.000Z');
    expect(plan.fallbackGuidance?.rotationDueAt).toBe('2026-09-27T00:00:00.000Z');
  });

  it('validates strict payload-free policy metadata and exact PAT expiry', () => {
    const policy = patPolicy();
    expect(() => validateCredentialPolicy(policy)).not.toThrow();
    expect(JSON.stringify(policy)).not.toContain(syntheticToken);
    expect(policy.expiresAt).toBe('2026-10-04T00:00:00.000Z');
    expect(policy.proof.readbackDigest).toBe(digest);

    expect(() => validateCredentialPolicy({ ...policy, extra: true })).toThrow(/not allowed/);
    expect(() => validateCredentialPolicy({
      ...policy,
      expiresAt: '2026-10-05T00:00:00.000Z',
      rotationDueAt: '2026-09-28T00:00:00.000Z'
    })).toThrow(/exactly 30 days/);
    expect(() => validateCredentialPolicy({
      ...policy,
      permissions: { ...policy.permissions, repository: ['metadata:read', 'contents:write'] }
    })).toThrow(/exactly equal/);
  });

  it('accepts PAT value only through masked prompt and hands it to secret adapter in memory', async () => {
    const adapter = new FixtureCredentialAdapter();
    const root = path.join(scratchRoot, 'masked-handoff');
    await mkdir(root, { recursive: true });
    const stdout = '';
    const policy = await enrollFineGrainedPatCredential({
      adapter,
      repository: repository(),
      allowedWorkflows: allowlist(),
      now,
      prompt: async () => SensitiveCredentialValue.fromMaskedInput(syntheticToken)
    });
    expect(adapter.captured).toBe(syntheticToken);
    expect(JSON.stringify(adapter.secretArgs)).not.toContain(syntheticToken);
    expect(JSON.stringify(policy)).not.toContain(syntheticToken);
    const policyFile = path.join(root, 'policy.json');
    await writeFile(policyFile, `${JSON.stringify(policy, null, 2)}\n`, 'utf8');
    expect(await readFile(policyFile, 'utf8')).not.toContain(syntheticToken);
    expect(stdout).not.toContain(syntheticToken);
    expect(() => policy.pat).not.toThrow();
  });

  it('builds a gh secret-set handoff that keeps PAT bytes out of argv and output', async () => {
    const runner = new CapturingRunner();
    const secret = SensitiveCredentialValue.fromMaskedInput(syntheticToken);
    try {
      const result = await writeRepositorySecretWithGitHubCli({
        runner,
        repository: repository(),
        secretName: 'RUNNER_CONFIGURATION_READ_TOKEN',
        value: secret
      });
      expect(runner.stdin).toBe(syntheticToken);
      expect(runner.redactValues).toEqual([syntheticToken]);
      expect(JSON.stringify(result.command.args)).not.toContain(syntheticToken);
      expect(result.result.stdout).not.toContain(syntheticToken);
      expect(result.result.stderr).not.toContain(syntheticToken);
    } finally {
      secret.release();
    }
  });

  it('redacts exact PAT bytes if a secret adapter echoes stdin into command output', async () => {
    const runner = new CapturingRunner(true);
    const secret = SensitiveCredentialValue.fromMaskedInput(syntheticToken);
    try {
      const result = await writeRepositorySecretWithGitHubCli({
        runner,
        repository: repository(),
        secretName: 'RUNNER_CONFIGURATION_READ_TOKEN',
        value: secret
      });

      expect(runner.stdin).toBe(syntheticToken);
      expect(result.result.displayCommand).not.toContain(syntheticToken);
      expect(result.result.stdout).toContain('<redacted-sensitive-value>');
      expect(result.result.stderr).toContain('<redacted-sensitive-value>');
      expect(JSON.stringify(result)).not.toContain(syntheticToken);
    } finally {
      secret.release();
    }
  });

  it('blocks out-of-policy workflow references, permission changes, forwarding, expiry, rotation, and missing readback', () => {
    const policy = patPolicy();
    const valid = {
      repository: repository(),
      permissions: runnerPreflightPermissions(),
      references: [{ workflowPath: '.github/workflows/bootstrap-import-preflight.yml', job: 'bootstrap-import-preflight' }],
      forwardsCredential: false,
      verifiedReadbackDigest: digest,
      now: new Date('2026-09-10T00:00:00.000Z')
    };
    expect(validateCredentialPolicyUsage(policy, valid).ready).toBe(true);
    expect(validateCredentialPolicyUsage(policy, {
      ...valid,
      references: [{ workflowPath: '.github/workflows/extra.yml', job: 'runner-preflight' }]
    }).issues.join('\n')).toContain('outside the exact workflow/job allowlist');
    expect(validateCredentialPolicyUsage(policy, {
      ...valid,
      permissions: { repository: ['metadata:read'], organization: ['hosted-runners:read', 'network-configurations:read', 'members:write'] }
    }).issues.join('\n')).toContain('exactly match');
    expect(validateCredentialPolicyUsage(policy, { ...valid, forwardsCredential: true }).issues.join('\n')).toContain('forwarding');
    expect(validateCredentialPolicyUsage(policy, { ...valid, now: new Date('2026-10-05T00:00:00.000Z') }).issues.join('\n')).toContain('expired');
    expect(validateCredentialPolicyUsage(policy, { ...valid, now: new Date('2026-09-28T00:00:00.000Z') }).issues.join('\n')).toContain('rotation lead');
    expect(validateCredentialPolicyUsage(policy, { ...valid, verifiedReadbackDigest: undefined }).issues.join('\n')).toContain('verified payload-free readback');
  });
});

describe('credential leak detection and fixtures', () => {
  it('detects generated artifact, log, evidence, and screenshot text leaks without revocation', () => {
    const result = detectCredentialLeaks([
      { source: 'generated-artifact', label: 'artifact', text: syntheticToken },
      { source: 'process-log', label: 'runner', text: 'ghp_SYNTHETICVALUEFORTESTSONLY1234' },
      { source: 'imported-evidence', label: 'evidence', text: 'AccountKey=synthetic-key' },
      { source: 'screenshot-text', label: 'ocr', text: 'https://hooks.slack.com/services/ABC/DEF/SYNTHETIC' }
    ]);
    expect(result.status).toBe('compromised');
    expect(result.guidance.join('\n')).toContain('Revoke');
    expect(result.guidance.join('\n')).toContain('Liftoff did not attempt automatic revocation');
    expect(result.unauthorizedRevocationAttempted).toBe(false);
  });

  it('keeps observed workflow fixtures deterministic while preserving distinct allowlists', async () => {
    const fixtureRoot = path.join(process.cwd(), 'tests', 'fixtures', 'governance-credentials');
    const bootstrap = await readFile(path.join(fixtureRoot, 'bootstrap-import-preflight.yml'), 'utf8');
    const dast = await readFile(path.join(fixtureRoot, 'private-dast-preflight.yml'), 'utf8');
    expect(bootstrap).toContain('bootstrap-import-preflight');
    expect(dast).toContain('private-dast-preflight');
    expect(detectCredentialLeaks([
      { source: 'generated-artifact', label: 'bootstrap', text: bootstrap },
      { source: 'generated-artifact', label: 'dast', text: dast }
    ]).status).toBe('clear');
    const policies = allowlist().map((entry) => buildFineGrainedPatCredentialPolicy({
      repository: repository(),
      allowedWorkflows: [entry],
      createdAt: now,
      proof: {
        verifiedAt: now.toISOString(),
        readbackDigest: digest,
        readbackProvider: 'adapter-fixture',
        payloadFree: true
      }
    }));
    expect(new Set(policies.map((policy) => policy.displayNameTemplate))).toEqual(new Set(['<repo>-runner-preflight-read']));
    expect(new Set(policies.map((policy) => policy.displayName))).toEqual(new Set([runnerPreflightDisplayName('liftoff')]));
    expect(new Set(policies.map((policy) => policy.secretName))).toEqual(new Set(['RUNNER_CONFIGURATION_READ_TOKEN']));
    expect(new Set(policies.map((policy) => JSON.stringify(policy.permissions)))).toHaveLength(1);
    expect(new Set(policies.map((policy) => policy.expiresAt))).toEqual(new Set(['2026-10-04T00:00:00.000Z']));
    expect(policies[0].allowedWorkflows).not.toEqual(policies[1].allowedWorkflows);
  });

  it('exposes read-only credential plan and status when credential-ready applies', async () => {
    const root = await writeProject();
    const credentialDirectory = path.join(root, ...credentialPolicyPathParts.slice(0, -1));
    await mkdir(credentialDirectory, { recursive: true });
    await writeFile(
      path.join(root, ...credentialPolicyPathParts),
      `${JSON.stringify(patPolicy(), null, 2)}\n`,
      'utf8'
    );
    await mkdir(path.join(root, 'governance'), { recursive: true });
    const phases = Object.fromEntries([
      'seed-valid',
      'seed-verified',
      'seed-archived',
      'committed',
      'pushed',
      'phase-0-complete',
      'activation-approved',
      'credential-ready',
      'provider-ready',
      'state-path-selected',
      'existing-private-path',
      'bootstrap-local',
      'runner-ready',
      'private-backend-proof',
      'remote-import-verified',
      'remote-ready',
      'application-foundation',
      'workflow-source-ready',
      'dev-proof',
      'staging-qualified',
      'production-rehearsed',
      'green-red-proof',
      'enforcement-approved',
      'rulesets-applied',
      'live-readback',
      'bootstrap-state-disposed'
    ].map((id) => [id, { state: 'pending', updatedAt: now.toISOString(), evidence: [], approvals: [], blockers: [] }]));
    await writeFile(path.join(root, 'governance', 'activation-state.json'), `${JSON.stringify({
      schemaVersion: currentActivationIdentity.activationStateSchemaVersion,
      identity: currentActivationIdentity,
      repository: { id: 'R_repo', name: 'octo-org/liftoff', defaultBranch: 'main' },
      activeChange: null,
      applicability: { statePath: 'none', privateStagingDast: false, credentialRequired: true },
      phases,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    }, null, 2)}\n`, 'utf8');

    const status = await run(['governance', 'status', '--json'], root);
    expect(status.code).toBe(0);
    const body = JSON.parse(status.out);
    expect(body.credential).toMatchObject({ applicable: true, readOnly: true, status: 'valid', ready: true });
    expect(status.out).not.toContain(syntheticToken);

    const plan = await run(['governance', 'plan', '--json'], root);
    expect(plan.code).toBe(0);
    expect(JSON.parse(plan.out).credential.readOnly).toBe(true);

    const verify = await run(['governance', 'verify', '--json'], root);
    expect(JSON.parse(verify.out).checks.some((check: { id: string; status: string }) =>
      check.id === 'credential-policy' && check.status === 'passed'
    )).toBe(true);
  });
});
