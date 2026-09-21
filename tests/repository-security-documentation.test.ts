import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

async function document(name: string): Promise<string> {
  return (await readFile(path.join(process.cwd(), ...name.split('/')), 'utf8')).replace(/\s+/g, ' ');
}

describe('accurate source-repository security guidance', () => {
  it('distinguishes actual foundations from scanner and hosted qualification', async () => {
    const guidance = await readFile(path.join(process.cwd(), 'docs', 'repository-security.md'), 'utf8');
    for (const contract of [
      'not a generated project', 'not a perpetual statement of live state',
      'does **not** mean', 'Missing evidence remains a blocker',
      'Dependency Graph recognition', 'Dependency Review assesses',
      'Complete-graph scans', 'Dependabot proposes updates',
      'all nine GenAI patterns', 'OSV-Scanner is assigned only',
      'Copilot Autofix', 'suggestions', 'not a container',
      'does not relax the stricter existing npm contract'
    ]) expect(guidance.replace(/\r?\n/g, ' '), contract).toContain(contract);
  });

  it('retains independent secret safety and honest detector boundaries', async () => {
    const guidance = (await readFile(path.join(process.cwd(), 'docs', 'repository-security.md'), 'utf8')).replace(/\r?\n/g, ' ');
    const security = (await readFile(path.join(process.cwd(), 'SECURITY.md'), 'utf8')).replace(/\r?\n/g, ' ');
    for (const contract of [
      'current committed tree', '**and introduced commits**', 'conditional',
      'stdout, stderr, reports and error paths', 'Untriaged', 'revocation/rotation',
      'vulnerability exception windows cannot waive', 'empty alert list do not prove',
      'Local Git commits are outside', 'other forks', 'No scanner proves',
      'never live credentials', 'branch-rule bypasses'
    ]) expect(guidance, contract).toContain(contract);
    expect(security).toContain('https://github.com/voyager163/liftoff/security/advisories/new');
    expect(security).toContain('do not include the credential');
    expect(security).toContain('Do not test the credential against its issuer');
  });

  it('defines the deferred native owner interface without replacing working npm', async () => {
    const guidance = (await readFile(path.join(process.cwd(), 'docs', 'repository-security.md'), 'utf8')).replace(/\r?\n/g, ' ');
    for (const contract of [
      'separately authorized native-modernization change owns', 'per-platform/architecture',
      'embedded runtimes', 'component-vulnerability assessment',
      'distinct signing/notarization', 'actual bundle bytes', 'npm publisher, install contract',
      'do not restore the former unmerged candidate', 'None alone proves secure bytes or SLSA L3'
    ]) expect(guidance, contract).toContain(contract);
    const pkg = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8'));
    expect(pkg.name).toBe('@msn-control/liftoff');
    expect(pkg.bin.liftoff).toBe('dist/cli.js');
    expect(pkg.publishConfig.provenance).toBe(true);
  });

  it('separates the implemented admission foundation from unqualified production wiring', async () => {
    const [guidance, developer] = await Promise.all([
      document('docs/repository-security.md'), document('DEVELOPER.md')
    ]);
    for (const text of [guidance, developer]) {
      for (const contract of [
        'scripts/repository-security/admission.ts',
        'scripts/repository-security/policy-data.ts',
        'real-Git fixture', 'synthetic observation reports',
        'production workflow integration', 'hosted enforcement'
      ]) expect(text, contract).toContain(contract);
    }
    expect(guidance).toContain('Trusted production workflow integration and hosted enforcement remain unqualified');
    expect(developer).toContain('It is not live scanner, PR-merge, or hosted-enforcement proof');
    for (const contract of [
      '`normal-admitted`', '`maintenance-admitted`', '`pull-request-admission`',
      '`policyAdopted: false`', '`publicationQualified: false`',
      'separate from generated-project activation'
    ]) expect(developer, contract).toContain(contract);
  });

  it('keeps normal finding success distinct from exact non-executable maintenance eligibility', async () => {
    const guidance = await document('docs/repository-security.md');
    const admission = guidance.split('## Pull-request admission and policy adoption')[1]
      .split('## Secrets coverage and detection limits')[0];
    for (const contract of [
      '**Finding assessment is not PR admission.**',
      'Complete successful candidate analysis, integrity, functional checks, and actual finding-policy success',
      'existing findings remain blocked before adoption',
      'data paths already registered by the base',
      'Source, dependency manifests/locks, workflows, scanners, detectors/rules/query packs, evaluators, inventories, thresholds, permissions, and publisher definitions must remain unchanged',
      'initial registrations, renames, symlinks, file-type/mode changes',
      'base/head SHAs need not be equal',
      'Actual commit, run/attempt, and freshness provenance remain separately verified',
      'no new raw findings or unassessed surfaces',
      'Unused future grants, cross-graph grants, and stale grants are rejected',
      'renewal needs fresh valid scoped evidence',
      'Confirmed unremediated exposures always block maintenance',
      'cannot downgrade a known confirmed exposure',
      'incomplete dependency snapshots, unknown severity',
      'Matching failures or empty results do not prove unchanged clean content'
    ]) expect(admission, contract).toContain(contract);
  });

  it('documents ordinary merge adoption, safe waiver retirement and fresh publication qualification', async () => {
    const [guidance, maintainer, contributing, security] = await Promise.all([
      document('docs/repository-security.md'), document('docs/maintainer-reference.md'),
      document('CONTRIBUTING.md'), document('SECURITY.md')
    ]);
    for (const text of [guidance, maintainer, contributing, security]) {
      expect(text).toMatch(/traceability(?:, not authority| only)/);
      expect(text).toMatch(/ordinary (?:maintainer )?merge/);
      expect(text).toMatch(/no (?:separate|extra) pre-merge/i);
      expect(text).toContain('reload');
      expect(text).toContain('publication');
    }
    for (const contract of [
      'active permission comes from independently loaded adopted base content',
      'Drift, new commits, or changed evidence invalidate the decision',
      'no blind auto-merge',
      'Incident/remediation history stays intact',
      'complete resolution evidence and an effective permission set no broader than the trusted base',
      'New or expanded candidate grants and remaining stale entries still fail',
      'Publication never accepts admission evidence, whether normal or maintenance',
      'fresh complete assessment of actual release source/artifacts',
      'permission to republish'
    ]) expect(guidance, contract).toContain(contract);
    expect(maintainer).toContain('Existing findings remain blocked before adoption');
    expect(maintainer).toContain('not a new approval command');
    expect(security).toContain('Reporting and separately authorized credential-owner remediation are unchanged');
  });

  it('preserves honest standalone npm outcomes and non-contradictory future required checks', async () => {
    const [guidance, maintainer, developer] = await Promise.all([
      document('docs/repository-security.md'), document('docs/maintainer-reference.md'),
      document('DEVELOPER.md')
    ]);
    for (const text of [guidance, maintainer]) {
      expect(text).toContain('selected-policy result');
      expect(text).toContain('adopted');
      expect(text).toContain('pending');
      expect(text).toContain('unconditional clean finding context');
    }
    for (const contract of [
      '**security admission plus successful analysis-completion, integrity, and existing functional checks**',
      'unchanged blocked finding reports',
      'Do not synthesize green statuses',
      '`continue-on-error`, neutral/skipped checks, or bypass native hosted rules',
      'Actual event/ref/check composition must be qualified before hosted activation'
    ]) expect(guidance, contract).toContain(contract);
    expect(maintainer).toContain("do not replace the CLI's real exit/result with maintenance eligibility");
    expect(developer).toContain('Standalone finding reports retain their actual verdicts');
  });

  it('keeps the fail-closed native Dependency Review API guidance unchanged', async () => {
    const guidance = await document('docs/repository-security.md');
    const paragraph = `The prepared PR job queries GitHub's native dependency-comparison API directly.
Snapshot warnings, absent vulnerability data, unknown severity, malformed
responses and unavailable service fail the job; they are not clean diffs.
All dependency scopes are evaluated. Public output contains counts and advisory
IDs, not dependency-controlled descriptions or credential-bearing strings.
This closes a concrete limitation in
[Dependency Review Action v5.0.0](https://github.com/actions/dependency-review-action/blob/a1d282b36b6f3519aa1f3fc636f609c47dddb294/src/main.ts),
which can proceed after snapshot-warning retries expire. It is still the same
native dependency data, not another scanning engine. Actual fork/Dependabot
execution and required-check enforcement remain to be qualified.`;
    expect(guidance).toContain(paragraph.replace(/\s+/g, ' '));
  });
});
