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