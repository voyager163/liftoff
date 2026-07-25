import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

async function repositoryFile(name: string): Promise<string> {
  return readFile(path.join(process.cwd(), name), 'utf8');
}

describe('installation and release documentation', () => {
  it('keeps canonical installation, version verification, and managed-mirror gating aligned', async () => {
    const readme = await repositoryFile('README.md');

    expect(readme).toContain('https://registry.npmjs.org');
    expect(readme).toContain('npm install -g @msn-control/liftoff@latest --registry=https://registry.npmjs.org');
    expect(readme).toContain('liftoff --version');
    expect(readme).toContain('Versions before 0.3.0 are unsupported');
    expect(readme).toContain('ask the mirror owner to synchronize or approve the release');
    expect(readme).toContain('does not modify `.npmrc`');
  });

  it('documents init targeting, independent consent, workstation setup, and the removed create command', async () => {
    const readme = await repositoryFile('README.md');

    expect(readme).toContain('liftoff init claims-copilot');
    expect(readme).toContain('exact current Git root');
    expect(readme).toContain('named child');
    expect(readme).toContain('Homebrew');
    expect(readme).toContain('WinGet');
    expect(readme).toContain('Linux system packages are never installed with automatic elevation');
    for (const flag of ['--yes', '--force', '--install-tools', '--install-dependencies']) {
      expect(readme).toContain(`\`${flag}\``);
    }
    expect(readme).toContain('OpenSpec and Spec Kit core/integration output is owned by their official initializers');
    expect(readme).toContain('The former `liftoff create` command is intentionally rejected');
    const bashExamples = [...readme.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1]).join('\n');
    expect(bashExamples).not.toContain('liftoff create');
  });

  it('documents the responsive terminal interface and machine-output exceptions', async () => {
    const [readme, contributing] = await Promise.all([
      repositoryFile('README.md'),
      repositoryFile('CONTRIBUTING.md')
    ]);

    expect(readme).toContain('## Terminal Interface');
    expect(readme).toContain('TTYs at least 96 columns');
    expect(readme).toContain('64 through 95 columns');
    expect(readme).toContain('NO_COLOR=1');
    expect(readme).toContain('deterministic plain text');
    expect(readme).toContain('liftoff doctor --json');
    expect(readme).toContain('liftoff update --json');
    expect(readme).toContain('forwards child stdout and stderr unchanged');
    expect(contributing).toContain('rich, compact, plain, `NO_COLOR`, JSON, version');
    expect(contributing).toContain('tests/__snapshots__');
  });

  it('documents canonical recovery, mirror readiness, and non-destructive deprecation', async () => {
    const [contributing, security] = await Promise.all([
      repositoryFile('CONTRIBUTING.md'),
      repositoryFile('SECURITY.md')
    ]);

    expect(contributing).toContain('Correct the dist-tag');
    expect(contributing).toContain('publish a corrected patch release');
    expect(contributing).toContain('Do not unpublish');
    expect(contributing).toContain("npm deprecate '@msn-control/liftoff@<0.3.0'");
    expect(contributing).toContain('withhold internal installation guidance');
    expect(security).toContain('Versions before 0.3.0 are unsupported');
    expect(security).toContain('A successful installation of an older mirrored version does not make that version supported');
  });
});