import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
const requiredDocs = [
  'docs/getting-started.md',
  'docs/workloads.md',
  'docs/spec-workflows-and-agents.md',
  'docs/repository-governance.md',
  'docs/existing-repositories.md',
  'docs/prerequisites.md',
  'docs/supported-stack.md',
  'docs/safety-and-consent.md',
  'docs/telemetry.md',
  'docs/cli-reference.md',
  'docs/project-structure.md',
  'docs/configuration-and-manifests.md',
  'docs/azure-deployment.md',
  'docs/troubleshooting.md'
] as const;

async function repositoryFile(name: string): Promise<string> {
  return readFile(path.join(repositoryRoot, name), 'utf8');
}

function localMarkdownTargets(markdown: string): string[] {
  return [...markdown.matchAll(/!?\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)]
    .map((match) => match[1].replace(/^<|>$/g, ''))
    .filter((target) =>
      !target.startsWith('#') &&
      !/^[a-z][a-z0-9+.-]*:/i.test(target)
    );
}

async function expectLocalLinksToResolve(file: string): Promise<void> {
  const markdown = await repositoryFile(file);
  for (const target of localMarkdownTargets(markdown)) {
    const relativeTarget = decodeURIComponent(target.split('#')[0].split('?')[0]);
    const resolved = path.resolve(repositoryRoot, path.dirname(file), relativeTarget);
    try {
      await access(resolved);
    } catch {
      throw new Error(`${file} contains a broken local link: ${target}`);
    }
  }
}

function channel(hex: string): number {
  const value = Number.parseInt(hex, 16) / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(color: string): number {
  const match = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!match) throw new Error(`Invalid test color: ${color}`);
  return 0.2126 * channel(match[1]) + 0.7152 * channel(match[2]) + 0.0722 * channel(match[3]);
}

function contrast(left: string, right: string): number {
  const [light, dark] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

describe('public documentation', () => {
  it('keeps the root README concise and puts the interactive first-use path first', async () => {
    const readme = await repositoryFile('README.md');
    const install = 'npm install -g @msn-control/liftoff@latest';
    const init = 'liftoff init my-project';
    const setup = '/liftoff-setup';
    const workloadSection = readme.indexOf('## One flow, three workloads');

    expect(readme.split('\n').length).toBeLessThan(130);
    expect(readme).not.toContain('Status: implemented');
    expect(readme.indexOf(install)).toBeGreaterThan(-1);
    expect(readme.indexOf(init)).toBeGreaterThan(readme.indexOf(install));
    expect(readme.indexOf(init)).toBeLessThan(workloadSection);
    expect(readme.indexOf('cd my-project')).toBeGreaterThan(readme.indexOf(init));
    expect(readme.indexOf(setup)).toBeGreaterThan(readme.indexOf('cd my-project'));
    expect(readme).toMatch(/completes,\s+syncs, and archives the generated bootstrap seed/);
    expect(readme).toContain('No model selection is required for setup');
    expect(readme).toContain('GenAI application');
    expect(readme).toContain('API application');
    expect(readme).toContain('Power Apps code app');
    expect(readme).toContain('OpenSpec');
    expect(readme).toContain('Spec Kit');
    expect(readme).toContain('GitHub Copilot');
    expect(readme).toContain('Claude Code');
    expect(readme).toContain('exact current Git root');
    expect(readme).toContain('docs/safety-and-consent.md');
    expect(readme).toContain('liftoff update --check --json');
    expect(readme).toContain('liftoff upgrade --check');
    expect(readme).toMatch(
      /replaces the CLI only; generated projects use `liftoff update` separately\s+for Liftoff-managed core files/
    );

    const bashExamples = [...readme.matchAll(/```bash\n([\s\S]*?)```/g)]
      .map((match) => match[1])
      .join('\n');
    expect(bashExamples).not.toMatch(/liftoff init .+--/);
    expect(bashExamples).not.toContain('liftoff init\n');
    expect(bashExamples).not.toContain('liftoff create');
  });

  it('uses factual badges and an accessible theme-independent terminal visual', async () => {
    const [readme, visual] = await Promise.all([
      repositoryFile('README.md'),
      repositoryFile('docs/assets/liftoff-terminal.svg')
    ]);

    expect(readme).toContain('img.shields.io/npm/v/');
    expect(readme).toContain('actions/workflows/ci.yml/badge.svg');
    expect(readme).toContain('img.shields.io/github/license/');
    expect(readme).toContain('img.shields.io/node/v/');
    expect(readme).toMatch(/!\[[^\]]{20,}]\(docs\/assets\/liftoff-terminal\.svg\)/);
    expect(visual).toContain('<title id="title">');
    expect(visual).toContain('<desc id="description">');
    expect(visual).toContain('<rect width="1000" height="560" rx="18" fill="#0d1117"/>');
    expect(contrast('#f0f6fc', '#0d1117')).toBeGreaterThan(7);
    expect(contrast('#b1bac4', '#0d1117')).toBeGreaterThan(4.5);
  });

  it('ships every progressive guide and resolves all local Markdown links', async () => {
    for (const file of ['README.md', 'CONTRIBUTING.md', 'DEVELOPER.md', ...requiredDocs]) {
      await access(path.join(repositoryRoot, file));
      await expectLocalLinksToResolve(file);
    }

    const packageJson = JSON.parse(await repositoryFile('package.json'));
    expect(packageJson.files).toContain('docs');
    expect(packageJson.files).toContain('DEVELOPER.md');
  });

  it('documents distinct workload questions, outputs, prerequisites, and deferred actions', async () => {
    const workloads = await repositoryFile('docs/workloads.md');

    for (const heading of [
      '## GenAI application',
      '## API application',
      '## Power Apps code app'
    ]) {
      expect(workloads).toContain(heading);
    }
    expect(workloads).toContain('### Questions');
    expect(workloads).toContain('### Generated output');
    expect(workloads).toContain('### Deferred actions');
    expect(workloads).toContain('Node.js 24.20');
    expect(workloads).toContain('does not create an API backend');
    expect(workloads).toContain('Do not run `/create-code-app`');
  });

  it('documents the uncertainty-safe generic GenAI pattern and migration boundary', async () => {
    const [readme, gettingStarted, workloads, cli, manifests, structure, existing, troubleshooting] =
      await Promise.all([
        repositoryFile('README.md'),
        repositoryFile('docs/getting-started.md'),
        repositoryFile('docs/workloads.md'),
        repositoryFile('docs/cli-reference.md'),
        repositoryFile('docs/configuration-and-manifests.md'),
        repositoryFile('docs/project-structure.md'),
        repositoryFile('docs/existing-repositories.md'),
        repositoryFile('docs/troubleshooting.md')
      ]);

    for (const source of [readme, gettingStarted, workloads, cli]) {
      expect(source).toMatch(/Generic GenAI\s+starter/i);
      expect(source).toContain('--pattern generic');
    }
    expect(workloads).toContain('/api/ai/run');
    expect(workloads).toMatch(/does\s+not generate retrieval or pgvector/);
    expect(manifests).toContain('"pattern": "generic"');
    expect(manifests).toContain('reviewed project');
    expect(structure).toContain('generic_agent.py');
    expect(existing).toContain('Changing the configuration to RAG');
    expect(troubleshooting).toContain('Generic GenAI project now needs a specialization');
    const genericTroubleshooting = troubleshooting
      .split('## Generic GenAI project now needs a specialization')[1]
      .split('\n## ')[0];
    expect(genericTroubleshooting).not.toContain('liftoff update --force');
  });

  it('moves detailed installation, target, consent, readiness, and terminal contracts into guides', async () => {
    const [
      gettingStarted,
      existing,
      prerequisites,
      safety,
      telemetry,
      cli,
      integrations,
      troubleshooting,
      manifests
    ] = await Promise.all([
      repositoryFile('docs/getting-started.md'),
      repositoryFile('docs/existing-repositories.md'),
      repositoryFile('docs/prerequisites.md'),
      repositoryFile('docs/safety-and-consent.md'),
      repositoryFile('docs/telemetry.md'),
      repositoryFile('docs/cli-reference.md'),
      repositoryFile('docs/spec-workflows-and-agents.md'),
      repositoryFile('docs/troubleshooting.md'),
      repositoryFile('docs/configuration-and-manifests.md')
    ]);

    expect(gettingStarted).toContain('Versions before 0.3.0 are unsupported');
    expect(gettingStarted).toContain('ask the mirror owner to synchronize or approve the release');
    expect(gettingStarted).toContain('does not modify `.npmrc`');
    expect(existing).toContain('exactly the root reported by');
    expect(existing).toContain('named child');
    expect(prerequisites).toContain('Homebrew');
    expect(prerequisites).toContain('WinGet');
    expect(prerequisites).toContain('OpenSpec 1.11.0');
    expect(prerequisites).toContain('Spec Kit 1.0.1');
    expect(prerequisites).toContain('npm 12.0.2');
    expect(prerequisites).toContain('Linux system packages are never installed with automatic elevation');
    for (const flag of ['--yes', '--force', '--install-tools', '--install-dependencies']) {
      expect(safety).toContain(`\`${flag}\``);
    }
    expect(integrations).toContain('official initializer');
    expect(cli).toContain('TTYs at least 96 columns');
    expect(cli).toContain('64 through 95 columns');
    expect(cli).toContain('deterministic plain text');
    expect(cli).toMatch(/child stdout and stderr are forwarded\s+unchanged/);
    expect(cli).toMatch(/former `liftoff create` command is intentionally rejected/);
    expect(cli).toContain('Plain `liftoff update` is imperative and prompt-free');
    expect(cli).toContain('liftoff update --check --json');
    expect(cli).toContain('Migration from 0.6.x');
    expect(cli).toMatch(/Liftoff retains no backup after a successful core overwrite/);
    expect(cli).toContain('Next recommended command');
    expect(cli).toContain('Liftoff has not executed it automatically');
    expect(safety).toContain('Default update skips core conflicts');
    expect(safety).toMatch(/update neither changes\s+nor installs them/);
    expect(telemetry).toContain('LIFTOFF_TELEMETRY=0');
    expect(telemetry).toContain('DO_NOT_TRACK=1');
    expect(telemetry).toContain('no persistent installation or session identifier');
    expect(telemetry).toContain('source network address while routing');
    expect(telemetry).toContain('180 days');
    expect(telemetry).toContain('rg-liftoff-prod');
    expect(telemetry).toContain('Azure Monitor adds standard workspace system columns');
    expect(telemetry).toMatch(/same\s+reviewed production variable file/);
    expect(telemetry).toMatch(/Azure Network Security\s+Perimeter/);
    expect(telemetry).toContain('explicit operator IPv4 `/32` CIDRs');
    expect(telemetry).toMatch(/Azure Container\s+Apps/);
    expect(telemetry).toMatch(/Administrator\s+credentials and anonymous pull are disabled/);
    expect(telemetry).toContain('one minimum replica');
    expect(telemetry).toMatch(/persistent platform logs\s+disabled/);
    expect(telemetry).toMatch(/full public Git commit\s+SHA/);
    expect(telemetry).toContain('final production architecture contains no Function App');
    expect(telemetry).toContain('Standard GitHub-hosted runners run static validation only');
    expect(telemetry).toContain('tofu -chdir=infrastructure/opentofu/telemetry');
    expect(telemetry).not.toMatch(/\bterraform (?:apply|plan|destroy)\b/i);
    expect(existing).toMatch(
      /For CI\s+core-maintenance gates, use `liftoff update --check --json`/
    );
    expect(troubleshooting).toMatch(/Transaction rollback protects a\s+failed update/);
    expect(troubleshooting).toContain('Do not regenerate the lock as a connectivity workaround');
    expect(troubleshooting).toContain('UV_DEFAULT_INDEX');
    expect(manifests).toContain('`liftoff update --check`');
  });

  it('keeps removed update apply syntax only in labeled migration history', async () => {
    for (const file of ['README.md', ...requiredDocs.filter((file) => file !== 'docs/cli-reference.md')]) {
      expect(await repositoryFile(file)).not.toContain('liftoff update --apply');
    }

    const cli = await repositoryFile('docs/cli-reference.md');
    expect(cli).toContain('These are historical 0.6.x commands');
    expect(cli.match(/liftoff update --apply/g)).toHaveLength(2);
  });

  it('documents CLI self-upgrade separately from generated-project update', async () => {
    const [
      readme,
      gettingStarted,
      cli,
      prerequisites,
      supportedStack,
      troubleshooting,
      telemetry,
      safety,
      contributing
    ] = await Promise.all([
      repositoryFile('README.md'),
      repositoryFile('docs/getting-started.md'),
      repositoryFile('docs/cli-reference.md'),
      repositoryFile('docs/prerequisites.md'),
      repositoryFile('docs/supported-stack.md'),
      repositoryFile('docs/troubleshooting.md'),
      repositoryFile('docs/telemetry.md'),
      repositoryFile('docs/safety-and-consent.md'),
      repositoryFile('CONTRIBUTING.md')
    ]);
    for (const source of [readme, gettingStarted, cli, supportedStack]) {
      expect(source).toContain('liftoff upgrade --check');
      expect(source).toContain('liftoff update');
    }
    expect(cli).toContain('Canonical npm');
    expect(cli).toContain('configured npm registry');
    expect(cli).toContain('`npx` execution-cache');
    expect(cli).toContain('does not prompt');
    expect(cli).toContain('not automatically rolled back');
    expect(cli).toContain('registryKind');
    expect(cli).toContain('reasonCode');
    expect(cli).toContain('update-available');
    expect(prerequisites).toContain('npm root --global');
    expect(troubleshooting).toContain('stale managed registry');
    expect(troubleshooting).toContain('does not run `sudo`');
    expect(troubleshooting).toContain('exact-version global npm');
    expect(telemetry).toContain('aggregate command value');
    expect(telemetry).toMatch(
      /verification\s+process runs with telemetry and disclosure disabled/
    );
    expect(safety).toContain('CLI self-upgrade boundary');
    expect(safety).toMatch(/does not\s+claim automatic rollback/);
    expect(contributing).toContain('first release containing `liftoff upgrade`');
    expect(contributing).toContain(
      'npm install -g @msn-control/liftoff@latest --registry=https://registry.npmjs.org'
    );
  });

  it('documents local repository-governance handoff and deferred activation', async () => {
    const [
      readme,
      governance,
      policy,
      gettingStarted,
      workloads,
      cli,
      existing,
      prerequisites,
      safety,
      structure,
      manifests,
      troubleshooting,
      contributing
    ] = await Promise.all([
      repositoryFile('README.md'),
      repositoryFile('docs/repository-governance.md'),
      repositoryFile('assets/governance/single-maintainer-gitflow/policy.md'),
      repositoryFile('docs/getting-started.md'),
      repositoryFile('docs/workloads.md'),
      repositoryFile('docs/cli-reference.md'),
      repositoryFile('docs/existing-repositories.md'),
      repositoryFile('docs/prerequisites.md'),
      repositoryFile('docs/safety-and-consent.md'),
      repositoryFile('docs/project-structure.md'),
      repositoryFile('docs/configuration-and-manifests.md'),
      repositoryFile('docs/troubleshooting.md'),
      repositoryFile('CONTRIBUTING.md')
    ]);
    expect(readme).toContain('Repository governance');
    expect(gettingStarted).toContain('local files only');
    expect(workloads).toContain('repository-governance');
    expect(cli).toContain('--governance single-maintainer-gitflow|none');
    expect(existing).toContain('manifest artifact version 7');
    expect(prerequisites).toMatch(/no additional initialization\s+prerequisite/);
    expect(safety).toMatch(/never authorizes agent execution/);
    expect(structure).toContain('.liftoff/');
    expect(manifests).toContain('manifest artifact version 7');
    expect(manifests).toContain('handoff-partial');
    expect(troubleshooting).toContain('handoff-generated');
    expect(troubleshooting).toContain('no ownership entry');
    expect(existing).toContain('handoff-partial');
    expect(existing).toContain('Intentionally removed infrastructure stays absent');
    expect(manifests).toContain('`managedArtifacts`');
    expect(manifests).toContain('`projectArtifacts`');
    expect(manifests).toContain('grant update authority');
    expect(manifests).toContain('the complete compatibility tuple is supported');
    expect(safety).toContain('cannot be restored or overwritten by any');
    expect(safety).toContain('outside manifest ownership');
    expect(cli).toMatch(/outside\s+managed ownership/);
    expect(contributing).toContain('Maintain the repository-governance profile');
    for (const phrase of [
      'single-maintainer-gitflow',
      'manifest v7',
      'managed-core files',
      'user-owned activation state',
      'read-only Phase 0',
      'approval envelope',
      'evidence-ready, approved phase',
      'green-red-proof',
      'rulesets-applied',
      'bootstrap-state-disposed'
    ]) {
      expect(governance).toContain(phrase);
    }
    expect(policy).toContain('GitHub Secret Protection');
    expect(policy).toContain('Trivy');
    expect(policy).toContain('DORA');
    expect(policy).toContain('policyVersion: "6"');
    expect(governance).toContain('GitHub-hosted larger runner');
    expect(governance).toMatch(/Azure\s+VNet injection/);
    expect(governance).toContain('selected-repository GitHub App');
    expect(governance).toMatch(/read-only\s+evidence for exactly 30 days/);
    expect(governance).toMatch(/never\s+provisions\s+Azure or GitHub resources/i);
    expect(safety).toContain('Azure or other cloud resources');
    expect(governance).toContain('become reported orphans and remain on disk');
  });

  it('documents deterministic setup identity, credentials, and baseline gates', async () => {
    const [readme, gettingStarted, governance, cli, manifests, safety, troubleshooting, developer] =
      await Promise.all([
        repositoryFile('README.md'),
        repositoryFile('docs/getting-started.md'),
        repositoryFile('docs/repository-governance.md'),
        repositoryFile('docs/cli-reference.md'),
        repositoryFile('docs/configuration-and-manifests.md'),
        repositoryFile('docs/safety-and-consent.md'),
        repositoryFile('docs/troubleshooting.md'),
        repositoryFile('DEVELOPER.md')
      ]);
    const all = [readme, gettingStarted, governance, cli, manifests, safety, troubleshooting, developer].join('\n');

    expect(readme).toContain('liftoff init my-project');
    expect(readme).toContain('/liftoff-setup');
    expect(gettingStarted).toContain('tofu init -backend=false');
    expect(gettingStarted).toContain('The baseline does not run `tofu plan`, `tofu apply`');
    expect(gettingStarted).toContain('Absent components are inapplicable');
    expect(governance).toContain('capability chapters, not');
    expect(governance).toContain('seed-valid');
    expect(governance).toContain('bootstrap-state-disposed');
    expect(governance).toContain('Workflow/job allowlist');
    expect(cli).toContain('liftoff governance apply-next [project] [--json] [--execute]');
    expect(cli).toMatch(/It never\s+emits a setup-skill version/);
    expect(manifests).toContain('Readers support artifact versions v2, v3, v4, v5, v6, and v7');
    expect(safety).toContain('liftoff governance apply-next --execute');
    expect(troubleshooting).toContain('`identity-incompatible`');
    expect(developer).toContain('"liftoffVersion": "0.10.0"');
    expect(developer).toContain('"policyVersion": "6"');
    expect(developer).toContain('"activationContractVersion": 1');
    expect(developer).toContain('"manifestArtifactVersion": 7');
    expect(developer).toContain('b84bcde6cd614637f2486b0f3a202860e6e9a6142ac60c773daa11786dbeb7f7');
    expect(developer).toContain('There is no separate `/liftoff-setup` skill version');
    expect(developer).toContain('CLI SemVer');
    expect(developer).toContain('Compatibility maintenance');
    expect(all).toContain('RUNNER_CONFIGURATION_READ_TOKEN');
    expect(all).toContain('<repo>-runner-preflight-read');
    expect(all).toContain('selected-repository GitHub App');
    expect(all).toMatch(/Never paste or show the\s+value in chat, argv, command arguments,\s+logs, evidence/);
    expect(all).not.toMatch(/gh secret set[^\n]*(?:github_pat_|ghp_|gho_|ghu_|ghs_|ghr_)/);
    expect(all).not.toMatch(/setupSkillVersion|skillVersion/);
  });

  it('keeps contributor validation, packaging, release, and recovery procedures together', async () => {
    const [contributing, security] = await Promise.all([
      repositoryFile('CONTRIBUTING.md'),
      repositoryFile('SECURITY.md')
    ]);

    expect(contributing).toContain('npm run check');
    expect(contributing).toContain('npm run smoke:package');
    expect(contributing).toContain('npm run smoke:container --prefix services/telemetry-ingest');
    expect(contributing).toContain('npm run verify:power-apps-starter');
    expect(contributing).toContain('npm run verify:generated-containers');
    expect(contributing).toContain('npm run refresh:power-apps-starter');
    expect(contributing).toContain('Node.js 24 on Linux x64');
    expect(contributing).toContain('rich, compact, plain,');
    expect(contributing).toContain('tests/__snapshots__');
    expect(contributing).toContain('Correct the dist-tag');
    expect(contributing).toContain('publish a corrected patch release');
    expect(contributing).toContain('Do not unpublish');
    expect(contributing).toContain("npm deprecate '@msn-control/liftoff@<0.3.0'");
    expect(contributing).toContain('withhold internal installation guidance');
    expect(contributing).toContain('Liftoff must not silently downgrade');
    expect(security).toContain('Versions before 0.3.0 are unsupported');
    expect(security).toContain('A successful installation of an older mirrored version does not make that version supported');
  });

  it('documents pinned, read-only assessment, honest coverage, and exact integration ownership', async () => {
    const [cli, governance, developer, manifests, structure] = await Promise.all([
      repositoryFile('docs/cli-reference.md'),
      repositoryFile('docs/repository-governance.md'),
      repositoryFile('DEVELOPER.md'),
      repositoryFile('docs/configuration-and-manifests.md'),
      repositoryFile('docs/project-structure.md')
    ]);
    for (const source of [cli, governance, developer]) {
      const content = source.replace(/\s+/g, ' ');
      for (const phrase of [
        'installed CLI', 'registry latest', 'local-only', 'read-only',
        'existing permissions', 'recorded', 'declared', 'observed',
        'provenance', 'coverage', 'approved-exception', 'not-observed',
        '/liftoff-governance-assess', '/liftoff-setup'
      ]) {
        expect(content.toLowerCase()).toContain(phrase.toLowerCase());
      }
      for (const classification of [
        'aligned', 'outdated', 'missing', 'conflicting', 'approved-exception',
        'inapplicable', 'not-observed'
      ]) {
        expect(source).toContain(`\`${classification}\``);
      }
      expect(content).toMatch(/future governance upgrade.*(?:fresh|plan|approval)/i);
      expect(content).not.toContain('liftoff governance upgrade');
    }
    expect(cli).toContain('`--execute=false`');
    expect(cli).toMatch(/Only `assess` accepts `--live`/);
    expect(cli).toContain('| `not-applicable` | 0 |');
    expect(cli).toContain('| `partial` | 2 |');
    expect(cli).toContain('| `differences` | 2 |');
    expect(cli).toContain('| `error` | 1 |');
    expect(governance).toMatch(/Neither installing the integration nor running it activates,\s+updates, upgrades, or migrates/);
    expect(governance).toMatch(/Unowned conflicting destinations remain unowned even with\s+`--force`/);
    expect(governance).toContain('Initialization never\nruns assessment');
    expect(developer).toContain('no independent\nassessment-skill version');
    expect(developer).toContain('explicit unsupported coverage');
    expect(developer).toContain('filesystem fingerprints and injected operation');
    expect(developer).toContain('Windows/macOS/Linux');
    for (const logicalName of ['liftoff-governance-assess-copilot', 'liftoff-governance-assess-claude']) {
      expect(manifests).toContain(logicalName);
      expect(developer).toContain(logicalName);
    }
    for (const location of [
      '.github/prompts/liftoff-governance-assess.prompt.md',
      '.claude/commands/liftoff-governance-assess.md'
    ]) {
      expect(governance).toContain(location);
      expect(manifests).toContain(location);
      expect(structure).toContain(location);
    }
  });

  it('documents non-executing Git reads, telemetry exclusion, and validated assessment bindings', async () => {
    const [cli, governance, developer, telemetry] = await Promise.all([
      repositoryFile('docs/cli-reference.md'),
      repositoryFile('docs/repository-governance.md'),
      repositoryFile('DEVELOPER.md'),
      repositoryFile('docs/telemetry.md')
    ]);
    for (const source of [cli, governance, developer]) {
      const content = source.replace(/\s+/g, ' ');
      for (const phrase of [
        'telemetry and disclosure entirely', 'HEAD', 'origin metadata',
        '`git status`', 'clean filters', 'project policy version', '`facts`',
        'predicate values', 'current active-baseline', 'saved-plan/evidence receipts',
        'future-dated approvals', 'inferred bindings', 'Missing bindings remain'
      ]) {
        expect(content).toContain(phrase);
      }
      expect(content).toMatch(/(?:Do not fabricate|never suggest manually fabricating)/);
    }
    expect(telemetry).toContain('`liftoff governance assess` skips telemetry and disclosure entirely');
    expect(telemetry).toContain('`--live` and `--help`');
    expect(telemetry).toContain('writes no disclosure state');
  });

  it('keeps the docs directory limited to Markdown and static assets', async () => {
    const entries = await readdir(path.join(repositoryRoot, 'docs'), { recursive: true });
    expect(entries.every((entry) => /\.(?:md|svg)$/.test(String(entry)) || !String(entry).includes('.'))).toBe(true);
  });
});
