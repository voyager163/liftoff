import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import {
  communityReportingRoutes,
  documentationRequiredFiles,
  markdownAnchors,
  markdownTargets,
  normalizedContentLineCount,
  readmeContentLineLimit,
  resolveDocumentationTarget,
  validateDocumentationNavigation
} from '../scripts/documentation-navigation.mjs';
import {
  canonicalPhaseGraphHash,
  canonicalPhaseGraphJson,
  currentActivationIdentity
} from '../src/domain/governance/activation/graph.js';
import { compatibilityMetadataSchemaVersion } from '../src/domain/governance/policy/identity.js';
import { phaseCapabilities } from '../src/domain/governance/activation/capabilities.js';
import { retiredFlatRootInfrastructureIdentities } from '../src/domain/project/infrastructure-layout.js';
import { patterns } from '../src/application/project/catalog.js';
import { packagedSupportedStack } from '../src/adapters/packaged-assets/supported-stack.js';
import { liftoffVersion } from '../src/version.js';
import { isTelemetryEnabled } from '../src/telemetry/index.js';

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
  return (await readFile(path.join(repositoryRoot, name), 'utf8')).replace(/\r\n/g, '\n');
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
    const workloadSection = readme.indexOf('## One flow, two workloads');

    expect(normalizedContentLineCount(readme)).toBeLessThan(readmeContentLineLimit);
    expect(readme).not.toContain('Status: implemented');
    expect(readme.indexOf(install)).toBeGreaterThan(-1);
    expect(readme.indexOf(init)).toBeGreaterThan(readme.indexOf(install));
    expect(readme.indexOf(init)).toBeLessThan(workloadSection);
    expect(readme.indexOf('cd my-project')).toBeGreaterThan(readme.indexOf(init));
    expect(readme.indexOf(setup)).toBeGreaterThan(readme.indexOf('cd my-project'));
    const gettingStarted = (await repositoryFile('docs/getting-started.md')).replace(/\s+/g, ' ');
    expect(readme).toContain('docs/getting-started.md#2-start-the-primary-path');
    expect(gettingStarted).toMatch(/For OpenSpec, .*completes, syncs, and archives the generated bootstrap seed/);
    expect(gettingStarted).toMatch(/Spec Kit finalizes .*locally, without an OpenSpec archive or new Git branch/);
    expect(readme).toContain('No model selection is required for setup');
    expect(readme).toContain('GenAI application');
    expect(readme).toContain('API application');
    expect(readme).toMatch(/Power Apps[\s\S]{0,200}retired/i);
    expect(readme).toContain('OpenSpec');
    expect(readme).toContain('Spec Kit');
    expect(readme).toContain('GitHub Copilot');
    expect(readme).toContain('Claude Code');
    expect(readme).toContain('exact current Git root');
    expect(readme).toContain('docs/safety-and-consent.md');
    expect(readme).toContain('liftoff update --check');
    expect(readme).toContain('docs/getting-started.md#maintain-or-repair-an-existing-project');
    expect(gettingStarted).toContain('--approve-plan <fingerprint>');
    expect(readme).toContain('liftoff upgrade --check');
    expect(gettingStarted).toContain(
      'replaces the CLI only; generated projects use `liftoff update` separately for reviewed project maintenance'
    );
    expect(readme.indexOf('Telemetry is enabled by default')).toBeLessThan(readme.indexOf(init));
    expect(readme.indexOf('LIFTOFF_TELEMETRY=0')).toBeLessThan(readme.indexOf(init));
    expect(readme.indexOf('DO_NOT_TRACK=1')).toBeLessThan(readme.indexOf(init));
    expect(readme.indexOf('docs/telemetry.md')).toBeLessThan(readme.indexOf(init));
    expect(readme.indexOf('24.20.0')).toBeLessThan(readme.indexOf(install));
    expect(readme).toContain('liftoff --version');
    expect(readme).toContain('liftoff help');
    expect(readme).toContain('liftoff plan');

    const bashExamples = [...readme.matchAll(/```bash\n([\s\S]*?)```/g)]
      .map((match) => match[1])
      .join('\n');
    expect(bashExamples).not.toMatch(/liftoff init .+--/);
    expect(bashExamples).not.toContain('liftoff init\n');
    expect(bashExamples).not.toContain('liftoff create');
    expect(bashExamples).not.toMatch(/\/liftoff-setup|\$liftoff-setup/);
    expect(readme).toContain('**In your terminal**');
    expect(readme).toContain('**In your selected coding agent**');
  });

  it('documents the executable local repair lane without claiming agent installation or public stateful execution', async () => {
    const docs = await Promise.all([
      repositoryFile('docs/getting-started.md'), repositoryFile('docs/cli-reference.md'),
      repositoryFile('docs/repository-governance.md')
    ]);
    for (const content of docs) {
      const text = content.replace(/\s+/g, ' ');
      expect(text).toContain('Local baseline');
      expect(text).toContain('not an OpenSpec feature change');
      expect(text).toContain('existing authentication');
      expect(text).toContain('--subscription <UUID>');
      expect(text).toContain('state/backend metadata');
      expect(text).toContain('plan-only');
      expect(text).toMatch(/Agent installation[\s\S]*public stateful migration coordinator[\s\S]*not implemented|public stateful migration coordinator[\s\S]*\*\*not implemented\*\*/);
      expect(text).toContain('liftoff setup');
      expect(content).not.toMatch(/liftoff repair[^`\n]*--(?:force|yes|add-agents|project)/);
    }
    expect(docs[1]).toContain('liftoff repair [project-path] --approve-plan <fingerprint>');
    expect(docs[1]).toContain('liftoff repair [project-path] --recover');
    expect(docs[1]).toContain('revalidation.nextPhaseLabel');
    expect(docs[1]).toContain('infrastructureRepair');
    expect(docs[1]).toContain('120-second overall deadline');
    expect(docs[1]).toContain('30-second per-command');
    expect(docs[1]).toContain('maximum of 24 resource groups');
    expect(docs[1]).toContain('compatible stable release line');
    expect(docs[1]).toContain('Whole Azure root | `tofu fmt -check -recursive`');
    expect(docs[1]).toContain('tofu init -backend=false -input=false -lockfile=readonly -no-color');
    expect(docs[1]).toContain('tofu validate -json');
    const maintenance = docs[0].replace(/\s+/g, ' ');
    for (const preserved of [
      'Check leaves project bytes unchanged', 'receipt saved outside the repository',
      'Missing or stale previews block apply', 'creates a linked v3 activation',
      'Failed revalidation leaves v3 blocked and resumable',
      'outside template replacement, including `--force`',
      'Missing state files alone never establish safety',
      'no fingerprint copying is needed',
      'liftoff repair [project-path] --recover', 'not update recovery',
      'retired `/liftoff-repository-governance` alias',
      'removes only exact recorded aliases'
    ]) expect(maintenance).toContain(preserved);
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
    expect(visual).not.toMatch(/Power Apps|Code Apps/);
    expect(visual).toContain('/liftoff-setup');
    expect(visual).toContain('<rect width="1000" height="560" rx="18" fill="#0d1117"/>');
    expect(contrast('#f0f6fc', '#0d1117')).toBeGreaterThan(7);
    expect(contrast('#b1bac4', '#0d1117')).toBeGreaterThan(4.5);
  });

  it('ships every progressive guide and resolves all local Markdown links', async () => {
    const navigation = await validateDocumentationNavigation(repositoryRoot);
    expect(navigation.files).toEqual(expect.arrayContaining(documentationRequiredFiles));
    expect(navigation.linksChecked).toBeGreaterThan(80);

    const packageJson = JSON.parse(await repositoryFile('package.json'));
    expect(packageJson.files).toContain('docs');
    for (const file of ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', 'DEVELOPER.md']) {
      expect(packageJson.files).toContain(file);
    }
  });

  it('documents distinct workload questions, outputs, prerequisites, and deferred actions', async () => {
    const workloads = await repositoryFile('docs/workloads.md');

    for (const heading of [
      '## GenAI application',
      '## API application',
      '## Retired Power Apps workload'
    ]) {
      expect(workloads).toContain(heading);
    }
    expect(workloads).toContain('### Questions');
    expect(workloads).toContain('### Generated output');
    expect(workloads).toContain('### Deferred actions');
    expect(workloads).toContain('Node.js 24.20');
    expect(workloads).toMatch(/Power Apps[\s\S]{0,200}no longer\s+supported/i);
    expect(workloads).toContain('power-apps-code-app');
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
    expect(cli).toContain('`liftoff update --check` is the human-first compatibility and migration preview');
    expect(cli).toContain('A receipt is not approval');
    expect(cli).toContain('Human follow-ups omit `--project`');
    expect(cli).toContain('JSON remedies remain explicitly targeted');
    expect(cli).toContain('do not join check and apply with `&&`');
    expect(cli).toContain('`preview-missing` means no saved preview was found');
    expect(cli).toContain('`--approve-plan`');
    expect(cli).toContain('liftoff update --check --json');
    expect(cli).toContain('schema version 3 and `scope: "project-update"`');
    expect(cli).not.toMatch(/schema version 2 and includes `scope: "managed-core"`/);
    expect(cli).not.toContain('Compatibility metadata is version 2');
    expect(cli).toContain('`migrationSummary`');
    expect(cli).toContain('`nextRecordedPhase`');
    expect(cli).toContain('`currentProofRequired`');
    expect(cli).toMatch(/update committed a migration but local\s+revalidation is incomplete/);
    expect(existing).toContain('Always run `--check` before a write-capable update');
    expect(existing).not.toMatch(/Use `--check` first when the invocation must be read-only/);
    expect(existing).not.toMatch(/safe managed-core changes immediately/);
    expect(cli).toContain('$XDG_STATE_HOME/liftoff/update-previews');
    expect(cli).toContain('$HOME/.local/state/liftoff/update-previews');
    expect(cli).toContain('~/Library/Application Support/liftoff/update-previews');
    expect(cli).toContain('%LOCALAPPDATA%\\liftoff\\update-previews');
    expect(cli).toContain('%USERPROFILE%\\AppData\\Local\\liftoff\\update-previews');
    expect(cli).toContain('An empty or relative override is an error');
    expect(cli).toMatch(/history snapshot travels inside the project\. Preview receipts and\s+approval records do not/);
    expect(cli).toContain('Migration from 0.6.x');
    expect(cli).toMatch(/activation migration additionally retains durable original history/);
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
    expect(troubleshooting).toMatch(/Transaction rollback protects a\s+failed ordinary update/);
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
      maintainer
    ] = await Promise.all([
      repositoryFile('README.md'),
      repositoryFile('docs/getting-started.md'),
      repositoryFile('docs/cli-reference.md'),
      repositoryFile('docs/prerequisites.md'),
      repositoryFile('docs/supported-stack.md'),
      repositoryFile('docs/troubleshooting.md'),
      repositoryFile('docs/telemetry.md'),
      repositoryFile('docs/safety-and-consent.md'),
      repositoryFile('docs/maintainer-reference.md')
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
    expect(maintainer).toContain('first release containing `liftoff upgrade`');
    expect(maintainer).toContain(
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
    expect(gettingStarted).toMatch(/Absent (?:optional )?components are inapplicable/);
    expect(governance).toContain('capability chapters, not');
    expect(governance).toContain('seed-valid');
    expect(governance).toContain('bootstrap-state-disposed');
    expect(governance).toContain('Workflow/job allowlist');
    expect(cli).toContain('liftoff governance apply-next [project] [--json] [--execute]');
    expect(cli).toMatch(/It never\s+emits a setup-skill version/);
    expect(manifests).toContain('Readers support artifact versions v2, v3, v4, v5, v6, and v7');
    expect(safety).toContain('liftoff governance apply-next --execute');
    expect(troubleshooting).toContain('`identity-incompatible`');
    const identitySection = developer.split('## Activation version vector')[1].split('## Bump rules')[0];
    const example = identitySection.match(/```json\n([\s\S]*?)\n```/);
    expect(example, 'developer guide must show the current complete activation vector').not.toBeNull();
    expect(JSON.parse(example![1])).toEqual(currentActivationIdentity);
    expect(createHash('sha256').update(canonicalPhaseGraphJson).digest('hex')).toBe(canonicalPhaseGraphHash);
    expect(developer).toContain(`## ${liftoffVersion} release checklist`);
    expect(manifests).toContain(`| CLI package version | ${liftoffVersion} |`);
    expect(manifests).toContain(`| Activation package identity | ${currentActivationIdentity.liftoffVersion} |`);
    expect(identitySection).toContain(`schema version ${compatibilityMetadataSchemaVersion} in its own document`);
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

  it('preserves moved maintainer validation, packaging, release, and recovery procedures', async () => {
    const [maintainer, security] = await Promise.all([
      repositoryFile('docs/maintainer-reference.md'),
      repositoryFile('SECURITY.md')
    ]);

    expect(maintainer).toContain('npm run check');
    expect(maintainer).toContain('npm run smoke:package');
    expect(maintainer).toContain('package-smoke-test.mjs --tarball "/absolute/path with spaces/candidate.tgz"');
    expect(maintainer).toContain('Exact mode never invokes `npm pack`');
    expect(maintainer).toContain('The supplied archive is never written');
    expect(maintainer).toContain('npm run smoke:container --prefix services/telemetry-ingest');
    expect(maintainer).not.toContain('npm run verify:power-apps-starter');
    expect(maintainer).toContain('npm run verify:generated-containers');
    expect(maintainer).not.toContain('npm run refresh:power-apps-starter');
    expect(maintainer).toContain('rich, compact, plain,');
    expect(maintainer).toContain('tests/__snapshots__');
    expect(maintainer).toContain('Correct the dist-tag');
    expect(maintainer).toContain('publish a corrected patch release');
    expect(maintainer).toContain('Do not unpublish');
    expect(maintainer).toContain("npm deprecate '@msn-control/liftoff@<0.3.0'");
    expect(maintainer).toContain('withhold internal installation guidance');
    expect(maintainer).toContain('Liftoff must not silently downgrade');
    expect(maintainer).toContain('../DEVELOPER.md#activation-version-vector');
    const developer = await repositoryFile('DEVELOPER.md');
    const vector = developer.split('## Activation version vector')[1].match(/```json\n([\s\S]*?)\n```/);
    expect(JSON.parse(vector![1])).toEqual(currentActivationIdentity);
    expect(maintainer).not.toContain('compatibility metadata v2');
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
    const catalog = JSON.parse(await repositoryFile('assets/governance/single-maintainer-gitflow/assessment-controls.json'));
    expect(governance).toContain(`${catalog.controls.length} controls across ${catalog.families.length} families`);
    expect(governance).toContain(`${catalog.controls.filter((control: { supported: boolean }) => !control.supported).length} unsupported`);
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

  it('describes the implemented eight responsibility groups and current canonical ports', async () => {
    const developer = await repositoryFile('DEVELOPER.md');
    const architecture = developer.split('## Functional engines and implementation boundaries')[1]
      .split('## Activation completeness')[0];
    const systems = architecture.split('| Subsystem | Current implementation |')[1]
      .split('Telemetry, terminal presentation')[0];
    expect([...systems.matchAll(/^\| (?!-)([^|]+)\|/gm)]).toHaveLength(8);
    for (const file of [
      'src/cli/args/parser.ts',
      'src/cli/commands/dispatch.ts',
      'src/application/context.ts',
      'src/application/initialize/use-case.ts',
      'src/application/update/use-case.ts',
      'src/application/migrate/use-case.ts',
      'src/application/upgrade/use-case.ts',
      'src/domain/project/contracts.ts',
      'src/domain/project/catalog.ts',
      'src/domain/project/planning.ts',
      'src/domain/project/manifest/reader.ts',
      'src/application/project/manifest.ts',
      'src/generators/context.ts',
      'src/adapters/packaged-assets/package-root.ts',
      'src/adapters/packaged-assets/template-assets.ts',
      'src/adapters/filesystem/project-lock.ts',
      'src/domain/project/infrastructure-layout.ts',
      'src/governance-activation/read-only.ts',
      'src/governance-activation/transition-planning.ts',
      'src/governance-activation/transition-ports.ts',
      'src/governance-activation/phase-publication.ts',
      'src/governance-activation/phase-discovery.ts',
      'src/governance-activation/phase-governance.ts',
      'src/governance-activation/phase-bootstrap-state.ts',
      'src/governance-activation/transition-records.ts'
    ]) {
      expect(architecture).toContain(file);
      await access(path.join(repositoryRoot, file));
    }
    for (const phrase of [
      'typed', 'MigrationRequest', 'UpdateRequest', 'UpgradeRequest',
      'ExecutionContext', 'narrow', 'do not import adapters',
      'rather than routing back through facades', 'assertHeld()'
    ]) expect(architecture).toContain(phrase);
    for (const phase of Object.entries(phaseCapabilities).filter(([, value]) => value.executor !== 'built-in').map(([id]) => id)) {
      expect(developer).toContain(`\`${phase}\``);
    }
    expect(Object.values(phaseCapabilities).filter(({ executor }) => executor === 'unavailable')).toHaveLength(16);
    expect(Object.values(phaseCapabilities).filter(({ executor }) => executor === 'injected-only')).toHaveLength(2);
    expect(developer).not.toContain('activation inspection still uses');
    expect(developer).not.toContain('finish RAG publisher configuration');
    expect(developer).not.toContain('strengthen shared mutation locking');
    expect(developer).toContain('savedPlanDigest');
    expect(developer).toContain('validated selected payloads');
  });

  it('keeps all nine foundations honest and documents the actual configuration contract', async () => {
    const [workloads, configuration, structure, troubleshooting, baseline] = await Promise.all([
      repositoryFile('docs/workloads.md'),
      repositoryFile('docs/configuration-and-manifests.md'),
      repositoryFile('docs/project-structure.md'),
      repositoryFile('docs/troubleshooting.md'),
      repositoryFile('docs/supported-stack.md')
    ]);
    expect(patterns).toHaveLength(9);
    expect(patterns.every(({ scaffoldStatus }) => scaffoldStatus === 'foundation')).toBe(true);
    expect(patterns.filter(({ requiresVectorStore }) => requiresVectorStore).map(({ id }) => id)).toEqual(['rag']);
    for (const pattern of patterns) expect(workloads).toContain(`| \`${pattern.id}\` |`);
    expect(workloads).toContain('have `foundation` maturity');
    expect(workloads).not.toContain('integration-shell label');
    expect(workloads).toContain('One completed model response wrapped as buffered SSE');
    expect(workloads).toMatch(/Python `pyproject\.toml` and `uv\.lock` have no `pgvector`\s+dependency/);
    for (const deferred of ['Retrieval', 'citations', 'history', 'Tool execution', 'prompt files', 'coordination', 'Fine-tuning', 'Workflow stages']) {
      expect(workloads).toContain(deferred);
    }
    expect(configuration).toContain('process environment > selected local configuration file > nonsecret defaults');
    expect(configuration).toContain('LIFTOFF_ENV_FILE');
    expect(configuration).toContain('../runtime.config.json');
    expect(configuration).toContain('uv run uvicorn --app-dir .. backend.apis.main:app --port 8000');
    expect(configuration).toMatch(/explicitly selected missing, unreadable, or malformed file fails/);
    expect(configuration).toContain('escaped quote delimiters');
    expect(configuration).toContain('null or');
    expect(configuration).toContain('no model/provider request');
    for (const field of ['OPENAI_API_KEY', 'SERVICE_BUS_AUTH_MODE', 'SERVICE_BUS_QUEUE_NAME', 'AZURE_CLIENT_ID', 'REDIS_STREAM_NAME']) {
      expect(configuration).toContain(field);
    }
    expect(configuration).toMatch(/Both Langfuse keys blank means tracing is disabled/);
    expect(configuration).toContain('exactly one');
    expect(structure).toContain('Root and\nfrontend `.dockerignore`');
    expect(troubleshooting.toLowerCase()).toContain('malformed');
    for (const entry of [
      ...Object.values(packagedSupportedStack.runtimes),
      ...Object.values(packagedSupportedStack.packageManagers)
    ]) expect(baseline).toContain(entry.version);
  });

  it('documents exact new-output-only infrastructure retirement without granting migration authority', async () => {
    const [azure, configuration, safety, existing] = await Promise.all([
      repositoryFile('docs/azure-deployment.md'),
      repositoryFile('docs/configuration-and-manifests.md'),
      repositoryFile('docs/safety-and-consent.md'),
      repositoryFile('docs/existing-repositories.md')
    ]);
    const retirement = azure.split('## Explicit flat-root identity retirement')[1].split('\n## ')[0];
    expect(retiredFlatRootInfrastructureIdentities).toHaveLength(8);
    for (const identity of retiredFlatRootInfrastructureIdentities) {
      expect(retirement).toContain(`\`${identity.logicalName}\``);
      expect(retirement).toContain(`\`${identity.pathParts.at(-1)}\``);
    }
    expect(retirement).toContain('New 0.11.0 scaffolds retire exactly these eight');
    expect(retirement).toContain('opentofu-application-{versions,variables,main,outputs}');
    expect(retirement).toContain('environment:<env>');
    expect(retirement).toContain('not wildcard ownership');
    expect(retirement).toContain('environments/<env>/<env>.tfvars');
    expect(retirement).toMatch(/Existing manifests retain their old records,\s+paths, and generation hashes/);
    expect(retirement).toMatch(/do not\s+delete or retarget that provenance, move state, or convert old files/);
    expect(configuration).toContain('new scaffold output only');
    expect(safety).toContain('not aliases to new\nroots or managed-core deletion targets');
    expect(existing).toContain('Core context\nupdates cannot claim that this migration happened');
    expect(azure).toContain('state/<env>.tfstate');
    expect(azure).toContain('backend.remote.example.tf');
    expect(azure).toContain('SERVICE_BUS_AUTH_MODE=managed-identity');
    expect(azure).toMatch(/Azure Service Bus Data Sender on the generated queue/);
    expect(azure).toMatch(/receiver\s+identity remains separate/);
  });

  it('distinguishes one-time Spec Kit seeds, evidence projection, and historical execution blockers', async () => {
    const [workflow, governance, developer, configuration] = await Promise.all([
      repositoryFile('docs/spec-workflows-and-agents.md'),
      repositoryFile('docs/repository-governance.md'),
      repositoryFile('DEVELOPER.md'),
      repositoryFile('docs/configuration-and-manifests.md')
    ]);
    expect(workflow).toContain('B001–B006');
    expect(workflow).toMatch(/already-installed locked dependencies or install with explicit consent/);
    expect(workflow).toContain('body/full-plan-bound baseline evidence');
    expect(workflow).toMatch(/Failed checks\s+leave tasks untouched/);
    expect(workflow).toMatch(/status, verify, and resume do not edit checkboxes/);
    expect(workflow).toContain('not an active governance change');
    expect(workflow).toContain('no\n`liftoff-governance.json`');
    expect(governance).toMatch(/`tofu fmt -check -recursive` at `infrastructure\/opentofu\/azure`/);
    expect(governance).toContain('Before retrying blocked verification,');
    expect(governance).toContain('native setup runs `liftoff repair --check --json`');
    for (const source of [developer, configuration]) {
      expect(source).toContain('diagnostic-only');
      expect(source).toMatch(/historical (?:identity, )?state|historical identity\/state\/evidence/);
    }
    expect(developer).toContain('validateReadableActivationIdentity');
    expect(developer).toContain('scope use strict current validation');
    expect(configuration).toMatch(/readable historical record never authorizes current provider scope/);
  });

  it('uses one README budget with LF/CRLF parity and only a terminal newline ignored', async () => {
    expect(readmeContentLineLimit).toBe(135);
    expect(normalizedContentLineCount('')).toBe(0);
    expect(normalizedContentLineCount('\n')).toBe(1);
    expect(normalizedContentLineCount('\r\n')).toBe(1);
    expect(normalizedContentLineCount('\n\n')).toBe(2);
    for (const count of [134, 135, 136]) {
      const lf = Array.from({ length: count }, () => 'content').join('\n');
      for (const text of [lf, `${lf}\n`, lf.replace(/\n/g, '\r\n'), `${lf.replace(/\n/g, '\r\n')}\r\n`]) {
        expect(normalizedContentLineCount(text)).toBe(count);
        expect(normalizedContentLineCount(text) < readmeContentLineLimit).toBe(count < 135);
      }
      expect(normalizedContentLineCount(`${lf}\n\n`)).toBe(count + 1);
    }
    const readme = await repositoryFile('README.md');
    expect(normalizedContentLineCount(readme)).toBe(normalizedContentLineCount(readme.replace(/\n/g, '\r\n')));
    for (const guide of ['CONTRIBUTING.md', 'docs/maintainer-reference.md']) {
      expect((await repositoryFile(guide)).replace(/\s+/g, ' ')).toMatch(/135 normalized content lines/);
    }
  });

  it('resolves portable targets with spaces, encoded fragments, and real Markdown anchors', () => {
    for (const [paths, root] of [
      [path.posix, '/artifact with spaces/package'],
      [path.win32, 'C:\\artifact with spaces\\package']
    ] as const) {
      const target = resolveDocumentationTarget(root, 'docs/guide.md', '../CONTRIBUTING.md#development%2Dsetup', paths);
      expect(target).toEqual({
        absolute: paths.join(root, 'CONTRIBUTING.md'),
        logicalPath: 'CONTRIBUTING.md',
        fragment: 'development-setup'
      });
      expect(resolveDocumentationTarget(root, 'docs/guide.md', 'guide%20two.md#local', paths)?.absolute)
        .toBe(paths.join(root, 'docs', 'guide two.md'));
      expect(() => resolveDocumentationTarget(root, 'docs/guide.md', '../../README.md', paths)).toThrow('outside its root');
      expect(() => resolveDocumentationTarget(root, 'README.md', '..%5Cprivate.md', paths)).toThrow('non-portable');
    }
    expect(markdownTargets('[text](doc.md#a)\n![alt](asset.svg)\n[ref]: <two words.md>\n```\n[not prose](missing.md)\n```\n`[code](missing.md)`'))
      .toEqual(['doc.md#a', 'asset.svg', 'two words.md']);
    const anchors = markdownAnchors('# `CLI` upgrade modes\n## Repeated\n## Repeated\n## Repeated-1\n<a id="legacy"></a>\n```md\n# ignored\n```');
    expect([...anchors]).toEqual(['cli-upgrade-modes', 'repeated', 'repeated-1', 'repeated-1-1', 'legacy']);
  });

  it('fails missing artifact files and moved anchors without falling back to the complete checkout', async () => {
    const fixture = await mkdtemp(path.join(repositoryRoot, '.liftoff-documentation-fixture-'));
    const artifact = path.join(fixture, 'extracted package with spaces');
    try {
      for (const file of documentationRequiredFiles) {
        const destination = path.join(artifact, ...file.split('/'));
        await mkdir(path.dirname(destination), { recursive: true });
        await cp(path.join(repositoryRoot, ...file.split('/')), destination);
      }
      await expect(validateDocumentationNavigation(artifact)).resolves.toMatchObject({
        files: expect.arrayContaining(documentationRequiredFiles)
      });
      for (const missing of [
        'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md',
        'docs/maintainer-reference.md', 'docs/assets/liftoff-terminal.svg'
      ]) {
        const original = await readFile(path.join(artifact, ...missing.split('/')));
        await rm(path.join(artifact, ...missing.split('/')));
        await access(path.join(repositoryRoot, ...missing.split('/')));
        await expect(validateDocumentationNavigation(artifact)).rejects.toThrow(missing);
        await writeFile(path.join(artifact, ...missing.split('/')), original);
      }
      const moved = path.join(artifact, 'docs', 'maintainer-reference.md');
      await writeFile(moved, (await readFile(moved, 'utf8')).replace('## Release recovery', '## Renamed recovery'));
      await expect(validateDocumentationNavigation(artifact)).rejects.toThrow('broken documentation anchor');
      await cp(path.join(repositoryRoot, 'docs', 'maintainer-reference.md'), moved);
      for (const [file, before, after] of [
        ['CODE_OF_CONDUCT.md', communityReportingRoutes.conduct, 'mailto:unapproved@example.invalid'],
        ['CODE_OF_CONDUCT.md', communityReportingRoutes.conduct, 'mailto:askliftoff@gmail.com'],
        ['SECURITY.md', communityReportingRoutes.vulnerability, communityReportingRoutes.support],
        ['CONTRIBUTING.md', communityReportingRoutes.conductDocument, communityReportingRoutes.securityDocument]
      ]) {
        const target = path.join(artifact, file);
        const original = await readFile(target, 'utf8');
        await writeFile(target, original.replaceAll(before, after));
        await expect(validateDocumentationNavigation(artifact)).rejects.toThrow(/mismatched.*route/);
        await writeFile(target, original);
      }
      const readme = path.join(artifact, 'README.md');
      await writeFile(readme, (await readFile(readme, 'utf8')).replace('(LICENSE)', '(license)'));
      await expect(validateDocumentationNavigation(artifact)).rejects.toThrow('exact case required');
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('keeps the newcomer path proportionate and preserves useful contributor anchors as pointers', async () => {
    const contributing = await repositoryFile('CONTRIBUTING.md');
    const normalized = contributing.replace(/\s+/g, ' ');
    for (const phrase of [
      'single-maintainer', 'best effort', 'Node.js 24 LTS at 24.20.0',
      'npm 12.x at 12.0.2', 'git switch -c fix/my-change upstream/develop',
      'npm ci', 'npm run build', 'node dist/cli.js help',
      'targeting **`develop`**', '**`main`** follow the',
      'Canonical public registries', 'device ownership alone does not',
      'No new forum or private project access', 'first',
      'AI-assisted work', 'GPL-3.0-only', 'confidentiality'
    ]) expect(normalized).toContain(phrase);
    expect(contributing).not.toContain('On a Microsoft-managed device');
    expect(normalized).toContain('Routine typo fixes, clearer wording, and tests of unchanged behavior do not need');
    expect(normalized).toContain('no second reviewer, CLA, DCO/sign-off, or tool-specific AI disclosure is required');
    expect(normalized).toContain('Do not change global registry settings');
    const anchors = markdownAnchors(contributing);
    for (const anchor of [
      'development-setup', 'validate-a-change', 'documentation', 'propose-behavior-changes',
      'pull-requests', 'license-and-security'
    ]) expect(anchors.has(anchor)).toBe(true);
    for (const anchor of [
      'audit-packaged-template-dependencies', 'refresh-the-supported-stack',
      'reconcile-dependabot-updates', 'maintain-the-repository-governance-profile',
      'release-verification', 'release-recovery'
    ]) {
      expect(anchors.has(anchor)).toBe(true);
      expect(contributing).toContain(`docs/maintainer-reference.md#${anchor}`);
    }
    const maintainer = (await repositoryFile('docs/maintainer-reference.md')).replace(/\s+/g, ' ');
    for (const preserved of [
      'two concurrent file workers', '90-second limit', 'complete dependency-chain set',
      'high and critical findings expire within 30 days',
      'moderate and lower findings expire within 90 days',
      'Do not renew an exception automatically',
      'Node\'s newest supported LTS rather than Current',
      'Do not hand-edit generated lockfiles',
      'Never add a broad `.github` or `.claude` ownership pattern',
      'Never run self-upgrade apply against a developer',
      'Do not persist either override globally'
    ]) expect(maintainer).toContain(preserved);
  });

  it('provides safe GitHub-compatible intake without assumed labels or hosted services', async () => {
    const security = await repositoryFile('SECURITY.md');
    const privateRoute = 'https://github.com/voyager163/liftoff/security/advisories/new';
    const supportRoute = 'https://github.com/voyager163/liftoff/blob/develop/CONTRIBUTING.md#support-and-reporting';
    const conductRoute = 'https://github.com/voyager163/liftoff/blob/develop/CODE_OF_CONDUCT.md#report-a-conduct-concern';
    expect(security).toContain(privateRoute);
    for (const file of ['bug_report.yml', 'feature_request.yml']) {
      const text = await repositoryFile(`.github/ISSUE_TEMPLATE/${file}`);
      const yaml = parseDocument(text, { uniqueKeys: true });
      expect(yaml.errors).toEqual([]);
      const form = yaml.toJS();
      expect(Object.keys(form).sort()).toEqual(['body', 'description', 'name', 'title']);
      expect(form.name).toBeTruthy();
      expect(form.description).toBeTruthy();
      const ids: string[] = [];
      for (const field of form.body) {
        expect(['markdown', 'input', 'textarea']).toContain(field.type);
        if (field.type === 'markdown') {
          expect(field.attributes.value).toBeTruthy();
          continue;
        }
        expect(field.id).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(field.attributes.label).toBeTruthy();
        expect(Object.keys(field.attributes).every((key) => ['label', 'description', 'placeholder', 'value'].includes(key))).toBe(true);
        if (field.validations) expect(typeof field.validations.required).toBe('boolean');
        ids.push(field.id);
      }
      expect(new Set(ids).size).toBe(ids.length);
      expect(text).toContain(privateRoute);
      expect(text).toContain(supportRoute);
      expect(text).toContain(conductRoute);
      for (const warning of ['credentials', 'private source or data', '`.env` files', 'unredacted diagnostics', 'broad environment/configuration dumps']) {
        expect(text).toContain(warning);
      }
      expect(text).not.toMatch(/printenv|npm config list|(?:^|\n)\s*(?:env|set|Get-ChildItem Env:)\s*$/m);
      expect(text).not.toMatch(/labels:|assignees:|discussions|discord|slack/i);
      if (file === 'bug_report.yml') {
        expect(ids).toEqual(['version', 'environment', 'reproduction', 'expected', 'actual', 'context']);
        expect(text).toContain('no development build is required');
      } else {
        expect(ids).toEqual(['problem', 'outcome', 'alternatives', 'scope']);
      }
    }
    const chooserDocument = parseDocument(await repositoryFile('.github/ISSUE_TEMPLATE/config.yml'));
    expect(chooserDocument.errors).toEqual([]);
    const chooser = chooserDocument.toJS();
    expect(Object.keys(chooser).sort()).toEqual(['blank_issues_enabled', 'contact_links']);
    expect(chooser.blank_issues_enabled).toBe(true);
    expect(chooser.contact_links.map((entry: { url: string }) => entry.url)).toEqual([supportRoute, privateRoute, conductRoute]);
    for (const link of chooser.contact_links) expect(Object.keys(link).sort()).toEqual(['about', 'name', 'url']);
    const pr = (await repositoryFile('.github/PULL_REQUEST_TEMPLATE.md')).replace(/\s+/g, ' ');
    for (const phrase of [
      'targets `develop`', 'not applicable', 'focused checks', 'compatibility',
      'GPL-3.0-only', 'AI-assisted', 'credentials', 'private source or data',
      '`.env` files', 'unredacted diagnostics', privateRoute, supportRoute, conductRoute
    ]) expect(pr).toContain(phrase);
  });

  it('publishes only the owner-approved conduct contact with distinct support and security routes', async () => {
    const [decisionText, conductText, contributing, security] = await Promise.all([
      repositoryFile('security/community-contact.json'),
      repositoryFile('CODE_OF_CONDUCT.md'),
      repositoryFile('CONTRIBUTING.md'),
      repositoryFile('SECURITY.md')
    ]);
    const decision = JSON.parse(decisionText);
    expect(decision).toMatchObject({
      purpose: 'private-conduct-reporting',
      ownerConfirmedWorking: true,
      ownerConfirmedMonitored: true,
      publicationConsent: true,
      testMessageSent: false,
      mailboxProvisioned: false,
      grantsOtherHostedAuthority: false
    });
    expect(communityReportingRoutes.conduct).toBe(`mailto:${decision.address}`);
    expect(decision.address).toBe('ask.msncontrol@gmail.com');
    expect(decision.historicalDecisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ address: 'askliftoff@gmail.com', active: false, supersededBy: decision.address })
    ]));
    expect(decision.vulnerabilityRoute).toBe(communityReportingRoutes.vulnerability);
    expect(decision.supportRoute).toBe(communityReportingRoutes.support);
    const conduct = conductText.replace(/\s+/g, ' ');
    for (const boundary of [
      '**private conduct reports only**', 'not a support or security-reporting channel',
      'sole maintainer', 'best-effort', 'no independent response team',
      'guaranteed response time or outcome', 'confidentiality cannot be guaranteed',
      'cannot offer independent adjudication', 'Do not post sensitive reports'
    ]) expect(conduct).toContain(boundary);
    expect(markdownTargets(conductText).filter((target: string) => target.startsWith('mailto:')))
      .toEqual([communityReportingRoutes.conduct]);
    expect(conductText).not.toContain("privately through the repository's vulnerability reporting form");
    expect(conductText).toContain(communityReportingRoutes.securityDocument);
    expect(contributing).toContain(communityReportingRoutes.conductDocument);
    expect(contributing).toContain(communityReportingRoutes.securityDocument);
    expect(contributing).toContain(communityReportingRoutes.support);
    expect(security).toContain(communityReportingRoutes.vulnerability);
    expect(security).not.toContain(decision.address);
    expect(markdownAnchors(conductText).has('report-a-conduct-concern')).toBe(true);
    for (const file of [
      'README.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'docs/repository-security.md',
      '.github/ISSUE_TEMPLATE/config.yml', '.github/ISSUE_TEMPLATE/bug_report.yml',
      '.github/ISSUE_TEMPLATE/feature_request.yml', '.github/PULL_REQUEST_TEMPLATE.md'
    ]) {
      expect(await repositoryFile(file)).not.toMatch(/conduct.*(?:pending|deferred|not yet qualified)|That route has not been fixed/i);
    }
  });

  it('states current support and observable facts without qualifying unproven security controls', async () => {
    const [readme, contributing, packageText, telemetry] = await Promise.all([
      repositoryFile('README.md'), repositoryFile('CONTRIBUTING.md'),
      repositoryFile('package.json'), repositoryFile('docs/telemetry.md')
    ]);
    expect(JSON.parse(packageText).license).toBe('GPL-3.0-only');
    expect(JSON.parse(packageText).engines.node).toBe('>=24.20');
    expect(readme).toContain('https://github.com/voyager163/liftoff/releases');
    expect(readme).toContain('SECURITY.md#supported-versions');
    expect(readme.replace(/\s+/g, ' ')).toContain('`develop` is the integration branch, not a release');
    expect(readme).toContain('without a response guarantee');
    expect(readme).toContain('not evidence of active repository protection');
    expect(contributing).toContain(communityReportingRoutes.conductDocument);
    expect(telemetry).toContain('LIFTOFF_TELEMETRY=0');
    expect(telemetry).toContain('DO_NOT_TRACK=1');
    expect(isTelemetryEnabled({})).toBe(true);
    for (const env of [{ LIFTOFF_TELEMETRY: '0' }, { DO_NOT_TRACK: '1' }, { CI: 'true' }]) {
      expect(isTelemetryEnabled(env)).toBe(false);
    }
    expect(readme).toContain('disabled when `CI=true`');
    expect(readme).not.toMatch(/certified|SLSA L3|native installation|official Microsoft product/i);
  });

  it('keeps the docs directory limited to Markdown and static assets', async () => {
    const entries = await readdir(path.join(repositoryRoot, 'docs'), { recursive: true });
    expect(entries.every((entry) => /\.(?:md|svg)$/.test(String(entry)) || !String(entry).includes('.'))).toBe(true);
  });
});
