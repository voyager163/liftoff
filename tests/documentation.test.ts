import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
const requiredDocs = [
  'docs/getting-started.md',
  'docs/workloads.md',
  'docs/spec-workflows-and-agents.md',
  'docs/existing-repositories.md',
  'docs/prerequisites.md',
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
    const install = 'npm install -g @msn-control/liftoff@latest --registry=https://registry.npmjs.org';
    const init = 'liftoff init';
    const workloadSection = readme.indexOf('## One flow, three workloads');

    expect(readme.split('\n').length).toBeLessThan(130);
    expect(readme).not.toContain('Status: implemented');
    expect(readme.indexOf(install)).toBeGreaterThan(-1);
    expect(readme.indexOf(init)).toBeGreaterThan(readme.indexOf(install));
    expect(readme.indexOf(init)).toBeLessThan(workloadSection);
    expect(readme).toContain('GenAI application');
    expect(readme).toContain('API application');
    expect(readme).toContain('Power Apps code app');
    expect(readme).toContain('OpenSpec');
    expect(readme).toContain('Spec Kit');
    expect(readme).toContain('GitHub Copilot');
    expect(readme).toContain('Claude Code');
    expect(readme).toContain('exact current Git root');
    expect(readme).toContain('docs/safety-and-consent.md');

    const bashExamples = [...readme.matchAll(/```bash\n([\s\S]*?)```/g)]
      .map((match) => match[1])
      .join('\n');
    expect(bashExamples).not.toMatch(/liftoff init .+--/);
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
    for (const file of ['README.md', 'CONTRIBUTING.md', ...requiredDocs]) {
      await access(path.join(repositoryRoot, file));
      await expectLocalLinksToResolve(file);
    }

    const packageJson = JSON.parse(await repositoryFile('package.json'));
    expect(packageJson.files).toContain('docs');
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
    expect(workloads).toContain('Node.js 22.12');
    expect(workloads).toContain('does not create an API backend');
    expect(workloads).toContain('Do not run `/create-code-app`');
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
    expect(cli).toContain('Safe managed changes use a default-No confirmation');
    expect(cli).toMatch(/Liftoff retains no backup after a\s+successful overwrite/);
    expect(cli).toContain('Next recommended command');
    expect(cli).toContain('Liftoff has not executed it automatically');
    expect(safety).toContain('Safe-update consent does not authorize conflicts');
    expect(safety).toMatch(/update never installs\s+dependencies/);
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
    expect(existing).toMatch(/Redirected and\s+JSON checks remain read-only/);
    expect(troubleshooting).toMatch(/Transaction rollback protects a\s+failed update/);
    expect(manifests).toContain('declined interactive update');
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
    expect(contributing).toContain('npm run refresh:power-apps-starter');
    expect(contributing).toContain('Node.js 22 on Linux x64');
    expect(contributing).toContain('rich, compact, plain,');
    expect(contributing).toContain('tests/__snapshots__');
    expect(contributing).toContain('Correct the dist-tag');
    expect(contributing).toContain('publish a corrected patch release');
    expect(contributing).toContain('Do not unpublish');
    expect(contributing).toContain("npm deprecate '@msn-control/liftoff@<0.3.0'");
    expect(contributing).toContain('withhold internal installation guidance');
    expect(security).toContain('Versions before 0.3.0 are unsupported');
    expect(security).toContain('A successful installation of an older mirrored version does not make that version supported');
  });

  it('keeps the docs directory limited to Markdown and static assets', async () => {
    const entries = await readdir(path.join(repositoryRoot, 'docs'), { recursive: true });
    expect(entries.every((entry) => /\.(?:md|svg)$/.test(String(entry)) || !String(entry).includes('.'))).toBe(true);
  });
});
