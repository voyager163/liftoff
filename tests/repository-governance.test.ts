import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProjectPlan } from '../src/planner.js';
import {
  assertGovernanceContentSafe,
  buildRepositoryGovernanceArtifacts,
  governanceArtifactPaths,
  governanceContextSchemaVersion,
  governancePolicySchemaVersion,
  governancePolicyVersion,
  renderCanonicalGovernancePolicy,
  renderGovernanceContext,
  validateGovernanceContext,
  validateGovernancePolicy
} from '../src/repository-governance.js';
import { buildArtifacts } from '../src/templates.js';

function plan(values: Partial<Parameters<typeof buildProjectPlan>[0]> = {}) {
  return buildProjectPlan({
    projectName: 'Governed App',
    pattern: 'rag',
    cloud: 'azure',
    agents: ['copilot', 'claude'],
    ...values
  }, { requireProjectName: true });
}

describe('canonical repository governance policy', () => {
  it('packages the complete versioned single-maintainer policy', () => {
    const policy = renderCanonicalGovernancePolicy();
    expect(policy).toContain(`schemaVersion: ${governancePolicySchemaVersion}`);
    expect(policy).toContain(`policyVersion: "${governancePolicyVersion}"`);
    expect(policy).toContain('Vincent Driessen');
    expect(policy).toContain('required_approving_review_count: 0');
    expect(policy).toContain('Do not create a `CODEOWNERS` file');
    expect(policy).toContain('GITHUB_TOKEN');
    expect(policy).toContain('GitHub Secret Protection');
    expect(policy).toContain('Dependabot + Dependency Review');
    expect(policy).toContain('CodeQL + Copilot Autofix');
    expect(policy).toContain('Checkov');
    expect(policy).toContain('Trivy');
    expect(policy).toContain('Grype');
    expect(policy).toContain('OWASP ZAP');
    expect(policy).toContain('trusted_root.jsonl');
    expect(policy).toContain('Route everything to Slack');
    expect(policy).toContain('DORA four keys');
    expect(policy).toContain('STOP FOR EXPLICIT USER APPROVAL');
    expect(policy).toContain('governance/activation-baseline.json');
    expect(policy).toContain('rulesets idempotently last');
    expect(policy.length).toBeGreaterThan(40_000);
    expect(createHash('sha256').update(policy).digest('hex'))
      .toMatchInlineSnapshot(`"2126efb1d1669034d8c4b9c8d23c51a30bc62df0f739b85931d0da5f13ce2a52"`);
    expect(policy).toBe(readFileSync(
      new URL(
        '../assets/governance/single-maintainer-gitflow/policy.md',
        import.meta.url
      ),
      'utf8'
    ));
    expect(() => validateGovernancePolicy(policy)).not.toThrow();
  });

  it.each([
    'required_approving_review_count: 0',
    'GITHUB_TOKEN',
    'One provisioning exception only:',
    'private Staging DAST genuinely applies',
    'If DAST is inapplicable, provision no runner networking',
    'consume it without creating a duplicate',
    'Any unresolved input is a blocker',
    'Every Azure runner-network resource, remote state',
    'Staging subscription.',
    "Do not share or depend on another repository's or subscription's firewall",
    'selected access for only this repository',
    'Azure Firewall Basic',
    'Azure NAT Gateway',
    'takes precedence for new outbound connections',
    'NAT Gateway and an NSG do not filter HTTPS',
    'current GitHub meta endpoint',
    'deny all unsolicited inbound connections',
    'private DNS',
    'A standard hosted preflight checks assignment',
    'Do not mark the prerequisite satisfied until readback proves',
    'live Staging reachability',
    'Pre-answered platform defaults',
    'Provision nothing that no code uses',
    'The SLSA L3 generator is the one approved exception to SHA-pinning',
    'qualified release or hotfix candidate SHA',
    'production `main` merge SHA',
    'explicitly dispatch',
    'Trivy',
    'STOP FOR EXPLICIT USER APPROVAL',
    'governance/activation-baseline.json',
    'Prove each check fails'
  ])('fails closed when %s is omitted', (fragment) => {
    const policy = renderCanonicalGovernancePolicy().replaceAll(fragment, '');
    expect(() => validateGovernancePolicy(policy)).toThrow(
      /missing required contract fragment|fail-closed/
    );
  });

  it('rejects credential-shaped values without rejecting policy terminology', () => {
    expect(() => assertGovernanceContentSafe(
      'https://hooks.slack.com/services/ABC/DEF/SECRET'
    )).toThrow(/credential-shaped/);
    expect(() => assertGovernanceContentSafe(
      'github_pat_abcdefghijklmnopqrstuvwxyz123456789'
    )).toThrow(/credential-shaped/);
    expect(() => assertGovernanceContentSafe(
      'Discover whether a Slack webhook and GITHUB_TOKEN policy exist.'
    )).not.toThrow();
  });

  it('requires truthful blockers and adaptations instead of governance theatre', () => {
    const policy = renderCanonicalGovernancePolicy();
    expect(policy).toMatch(
      /GitHub-hosted larger runner group with Azure\s+VNet injection into Staging/
    );
    expect(policy).toContain('keep release qualification blocked');
    expect(policy).toContain('Never silently skip DAST');
    expect(policy).not.toContain('DAST must run on a self-hosted runner');
    expect(policy).not.toContain('self-hosted runner group with Staging access exists');
    expect(policy).toMatch(
      /GitHub Advanced Security is licensed[\s\S]*Secret Protection, CodeQL and Copilot Autofix/
    );
    expect(policy).toMatch(
      /Make the routing target \*\*required\*\*, and fail the deployment if it is\s+absent\./
    );
    expect(policy).toMatch(
      /target platform cannot support parallel versions[\s\S]*say so plainly/
    );
    expect(policy).toMatch(
      /too quiet for a canary slice to be meaningful[\s\S]*single atomic switch/
    );
    expect(policy).toContain('**Never gates.**');
    expect(policy).toContain('Keep `trivy config` disabled');
  });

  it('keeps settled platform defaults applicable and cost-aware', () => {
    const policy = renderCanonicalGovernancePolicy();
    expect(policy).toContain('**Dev LRS · Staging ZRS · Production ZRS**');
    expect(policy).toContain('**ZRS in every environment**, including bootstrap');
    expect(policy).toContain('**Dev and Staging: no HA. Production: zone-redundant HA.**');
    expect(policy).toContain('**User-assigned managed identity with OIDC federation**');
    expect(policy).toContain('**Small — fewer than 1,000 users**');
    expect(policy).toContain('**Cost-optimised with production safeguards**');
    expect(policy).toContain('**GitHub Actions secret at the environment level.**');
    expect(policy).toContain('**Active LTS only.**');
    expect(policy).toContain('Apply a default only when the classified');
    expect(policy).toContain('**known service limits**');
    expect(policy).toContain('refactor the IaC to match the live resources and import');
  });

  it('binds candidates to production merges and coordinates token follow-on work', () => {
    const policy = renderCanonicalGovernancePolicy();
    expect(policy).toContain('qualified release or hotfix candidate SHA');
    expect(policy).toContain('production `main` merge SHA');
    expect(policy).toContain('true merge that incorporates the exact qualified candidate SHA');
    expect(policy).toContain('conflicting metadata blocks');
    expect(policy).toContain('dispatch validation for the sync branch\'s exact head SHA');
    expect(policy).toContain('never rely on a tag-push trigger');
  });

  it('keeps the SLSA exception narrow and rejects the legacy runner contract', () => {
    const policy = renderCanonicalGovernancePolicy();
    expect(policy).toContain('**The SLSA L3 generator is the one approved exception to SHA-pinning.**');
    expect(policy).toContain('explicit, narrow, expiring action-reference exception');
    expect(policy).toContain('wildcard, blanket exemption');
    expect(policy).toMatch(/Trivy\s+remains the sole owner of vulnerability allowlisting/);
    expect(policy).toContain('Grype remains non-gating');
    expect(() => validateGovernancePolicy(
      `${policy}\nDAST must run on a self-hosted runner`
    )).toThrow(/forbidden legacy contract fragment/);
  });

  it('provisions private Staging runners only when applicable and authorized', () => {
    const policy = renderCanonicalGovernancePolicy();
    expect(policy).toContain('Provision this stack only when private Staging DAST applies');
    expect(policy).toContain('If DAST is inapplicable, provision no runner networking');
    expect(policy).toContain('consume it without creating a duplicate');
    expect(policy).toContain('Any unresolved input is a blocker');
    expect(policy).toContain('One provisioning exception only:');
    expect(policy).toContain('selected access for only this repository');
  });

  it('keeps repository subscriptions independent and selects one outbound mode', () => {
    const policy = renderCanonicalGovernancePolicy();
    expect(policy).toMatch(/target repository's\s+Staging subscription/);
    expect(policy).toContain(
      "Do not share or depend on another repository's or subscription's firewall"
    );
    expect(policy).toContain('Azure Firewall Basic');
    expect(policy).toContain('Azure NAT Gateway');
    expect(policy).toContain('select exactly one of these modes');
    expect(policy).toMatch(/NAT Gateway\s+takes precedence/);
    expect(policy).toContain('do not filter HTTPS\n   traffic by domain');
    expect(policy).toContain('Disable implicit default outbound access');
  });

  it('requires runner isolation, private connectivity, readback, and ordered teardown', () => {
    const policy = renderCanonicalGovernancePolicy();
    expect(policy).toContain('deny all unsolicited inbound connections');
    expect(policy).toContain('non-overlapping address space');
    expect(policy).toContain('private DNS');
    expect(policy).toContain('perform no TLS interception');
    expect(policy).toContain('live Staging reachability');
    expect(policy).toContain('maximum concurrency of one');
    expect(policy).toContain('Remove in dependency order');
    expect(policy).toContain('A standalone runner\nVNet');
    expect(policy).toContain('Do not mark the prerequisite satisfied until readback proves');
  });

  it.each([
    'Consume it; never attempt to create it',
    'Treat it as an **external prerequisite**',
    'share a firewall across repository subscriptions',
    'NAT Gateway may coexist with Azure Firewall',
    'resource creation is sufficient proof of Staging connectivity'
  ])('rejects unsafe runner policy wording: %s', (fragment) => {
    expect(() => validateGovernancePolicy(
      `${renderCanonicalGovernancePolicy()}\n${fragment}`
    )).toThrow(/forbidden legacy contract fragment/);
  });

  it('keeps zero-approval repository scope and fail-closed sequencing fixed', () => {
    const policy = renderCanonicalGovernancePolicy();
    expect(policy).toContain('required_approving_review_count: 0');
    expect(policy).toContain('require_code_owner_review: false');
    expect(policy).toContain('require_last_push_approval: false');
    expect(policy).toContain('no required reviewers');
    expect(policy).toContain('Do not add a manual approval step');
    expect(policy).toContain('Repository-scoped only');
    expect(policy).toContain('Never propose org-level rulesets');
    expect(policy).toMatch(/Observe every proposed required context green/i);
    expect(policy).toMatch(/prove that exact context deliberately red/i);
    expect(policy).toContain('Apply repository-scoped\nrulesets idempotently last');
  });
});

describe('repository governance artifacts', () => {
  it('renders canonical files and only selected-agent launchers', () => {
    const all = buildRepositoryGovernanceArtifacts(plan());
    expect(all.map((artifact) => artifact.logicalName)).toEqual([
      'repository-governance-policy',
      'repository-governance-context',
      'repository-governance-guide',
      'repository-governance-copilot-launcher',
      'repository-governance-claude-launcher'
    ]);
    expect(all.map((artifact) => artifact.pathParts)).toEqual([
      [...governanceArtifactPaths.policy],
      [...governanceArtifactPaths.context],
      [...governanceArtifactPaths.guide],
      [...governanceArtifactPaths['github-copilot']],
      [...governanceArtifactPaths.claude]
    ]);
    for (const artifact of all) {
      expect(artifact.category).toBe('governance');
      expect(artifact.pathParts.every((part) =>
        !part.includes('/') && !part.includes('\\')
      )).toBe(true);
    }

    const copilotOnly = buildRepositoryGovernanceArtifacts(
      plan({ agents: ['copilot'] })
    );
    expect(copilotOnly.map((artifact) => artifact.logicalName))
      .not.toContain('repository-governance-claude-launcher');
    expect(copilotOnly.map((artifact) => artifact.logicalName))
      .toContain('repository-governance-copilot-launcher');
  });

  it('keeps launchers thin and requires pushed Phase 0 plus approval', () => {
    const artifacts = buildRepositoryGovernanceArtifacts(plan());
    const policy = artifacts.find((artifact) =>
      artifact.logicalName === 'repository-governance-policy'
    )!.content;
    for (const launcher of artifacts.filter((artifact) =>
      artifact.logicalName.endsWith('launcher')
    )) {
      expect(launcher.content.length).toBeLessThan(2_000);
      expect(launcher.content).toContain('.liftoff/governance/policy.md');
      expect(launcher.content).toContain('.liftoff/governance/context.json');
      expect(launcher.content).toContain('committed and pushed');
      expect(launcher.content).toContain('read-only Phase 0');
      expect(launcher.content).toContain('stop for explicit user approval');
      expect(launcher.content).not.toContain('Phase 4 — Security pipeline');
      expect(launcher.content).not.toBe(policy);
    }
  });

  it('omits every handoff artifact for the none profile', () => {
    const disabled = plan({ governanceProfile: 'none' });
    expect(buildRepositoryGovernanceArtifacts(disabled)).toEqual([]);
    const artifacts = buildArtifacts(disabled);
    expect(artifacts.some((artifact) => artifact.category === 'governance'))
      .toBe(false);
    const manifest = JSON.parse(
      artifacts.find((artifact) => artifact.logicalName === 'manifest')!.content
    );
    expect(manifest.governance).toEqual({
      profile: 'none',
      state: 'disabled'
    });
  });

  it('renders identical bytes and path identities repeatedly', () => {
    const selectedPlan = plan();
    expect(buildRepositoryGovernanceArtifacts(selectedPlan)).toEqual(
      buildRepositoryGovernanceArtifacts(selectedPlan)
    );
    for (const parts of Object.values(governanceArtifactPaths)) {
      expect(path.posix.join('/repo', ...parts)).toContain('/repo/');
      expect(path.win32.join('C:\\repo', ...parts)).toContain('C:\\repo\\');
    }
  });

  it('keeps consent flags outside governance activation authority', () => {
    const base = buildRepositoryGovernanceArtifacts(plan());
    for (const consent of [
      { yes: true },
      { force: true },
      { installTools: true },
      { installDependencies: true }
    ]) {
      expect(buildRepositoryGovernanceArtifacts(plan(consent))).toEqual(base);
    }
  });

  it('writes schema-v5 handoff identity and exact durable hashes', () => {
    const artifacts = buildArtifacts(plan());
    const manifest = JSON.parse(
      artifacts.find((artifact) => artifact.logicalName === 'manifest')!.content
    );
    expect(manifest.artifactVersion).toBe(6);
    expect(manifest.governance).toEqual({
      profile: 'single-maintainer-gitflow',
      policyVersion: '3',
      state: 'handoff-generated'
    });
    expect(manifest.managedArtifacts.filter((artifact: { category: string }) =>
      artifact.category === 'governance'
    )).toHaveLength(5);
    expect(manifest.managedArtifacts.some((artifact: { pathParts: string[] }) =>
      artifact.pathParts.join('/') === 'governance/activation-baseline.json'
    )).toBe(false);
    expect(artifacts.some((artifact) =>
      artifact.pathParts.join('/').includes('/changes/') &&
      artifact.category === 'governance'
    )).toBe(false);
  });
});

describe('workload-aware governance context', () => {
  it.each([
    ['genai-rag', { pattern: 'rag' }],
    ['genai-chatbot', { pattern: 'chatbot' }],
    ['standard-python', { projectType: 'standard', apiStack: 'python', pattern: undefined }],
    ['standard-node', { projectType: 'standard', apiStack: 'node', pattern: undefined }],
    ['standard-go', { projectType: 'standard', apiStack: 'go', pattern: undefined }]
  ] as const)('renders real generated facts for %s', (_name, values) => {
    const selectedPlan = plan(values);
    const first = renderGovernanceContext(selectedPlan);
    const second = renderGovernanceContext(selectedPlan);
    expect(first).toBe(second);
    const context = JSON.parse(first);
    expect(context.schemaVersion).toBe(governanceContextSchemaVersion);
    expect(context.policy).toMatchObject({
      profile: 'single-maintainer-gitflow',
      state: 'handoff-generated',
      liveEnforcement: 'not-active'
    });
    expect(context.generatedBoundaries.backend.state).toBe('generated');
    expect(context.generatedBoundaries.docker.state).toBe('generated');
    expect(context.generatedBoundaries.opentofu.state)
      .toBe('generated-not-deployed');
    expect(context.health).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/health', depth: 'shallow' }),
      expect.objectContaining({
        path: '/ready',
        gap: expect.stringContaining('does not prove dependency')
      })
    ]));
    expect(Object.values(context.discovery).every((value) =>
      value === 'undiscovered'
    )).toBe(true);
    expect(context.commands.every((command: { cwdPathParts: string[] }) =>
      command.cwdPathParts.every((part) =>
        !part.includes('/') && !part.includes('\\')
      )
    )).toBe(true);
  });

  it('marks optional frontend and worker boundaries explicitly', () => {
    const withOptions = JSON.parse(renderGovernanceContext(
      plan({ pattern: 'rag', includeFrontend: true })
    ));
    expect(withOptions.generatedBoundaries.frontend.state).toBe('generated');
    expect(withOptions.generatedBoundaries.worker.state).toBe('generated');

    const withoutOptions = JSON.parse(renderGovernanceContext(
      plan({ pattern: 'chatbot', includeFrontend: false })
    ));
    expect(withoutOptions.generatedBoundaries.frontend.state).toBe('inapplicable');
    expect(withoutOptions.generatedBoundaries.worker.state).toBe('inapplicable');
  });

  it('rejects fabricated live state and vacuous command context', () => {
    const context = JSON.parse(renderGovernanceContext(plan()));
    context.policy.liveEnforcement = 'active';
    expect(() => validateGovernanceContext(context)).toThrow(
      /cannot claim live enforcement/
    );
    context.policy.liveEnforcement = 'not-active';
    context.discovery.rulesets = 'enforced';
    expect(() => validateGovernanceContext(context)).toThrow(
      /fabricated live discovery fact/
    );
    context.discovery.rulesets = 'undiscovered';
    context.commands = [];
    expect(() => validateGovernanceContext(context)).toThrow(
      /real generated commands/
    );
  });

  it('models Power Apps without invented API or deployment boundaries', () => {
    const context = JSON.parse(renderGovernanceContext(plan({
      projectType: 'power-apps-code-app',
      pattern: undefined,
      cloud: undefined,
      agents: ['copilot']
    })));
    expect(context.project.artifactForm).toBe(
      'browser-hosted-power-apps-code-app'
    );
    expect(context.commands.map((command: { id: string }) => command.id))
      .toEqual(['root-install', 'root-lint', 'root-build']);
    expect(context.source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(context.generatedBoundaries).toMatchObject({
      rootApplication: 'generated',
      backend: 'inapplicable',
      database: 'inapplicable',
      docker: 'inapplicable',
      opentofu: 'inapplicable',
      apiEnvironments: 'inapplicable',
      customContainerPromotion: 'inapplicable',
      apiDast: 'inapplicable',
      backendHealth: 'inapplicable',
      powerPlatformDeployment: 'live-discovery-required'
    });
    expect(JSON.stringify(context)).not.toContain('DATABASE_URL');
  });
});
