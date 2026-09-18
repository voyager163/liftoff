import { describe, expect, it } from 'vitest';
import { getCanonicalSkill } from '../src/adapters/packaged-assets/skill-assets.js';
import { projectSkillForHost } from '../src/adapters/skills/host-projections.js';
import { buildContextPreservingContinuation } from '../src/application/skills/capability-negotiation.js';
import { buildProjectPlan } from '../src/application/project/planning.js';
import { renderGovernanceGuide } from '../src/application/repository-governance/agent-rendering.js';
import { parseArgs } from '../src/cli/args/parser.js';

describe('Canonical consent and scope guidance (not native/provider qualification)', () => {
  it('keeps generated setup guidance capability-first without dropping graph and contract safeguards', () => {
    const plan = buildProjectPlan({
      projectName: 'Canonical guide', projectType: 'standard', apiStack: 'go',
      cloud: 'azure', agents: ['github-copilot']
    }, { requireProjectName: true });
    const guide = renderGovernanceGuide(plan);
    const negotiation = guide.indexOf('liftoff capabilities --json');
    expect(negotiation).toBeGreaterThanOrEqual(0);
    expect(negotiation).toBeLessThan(guide.indexOf('liftoff governance status --scope local --json'));
    expect(guide).toContain('loads `phase-graph.json`');
    expect(guide).toContain('uses activation contract');
    expect(guide).toContain('not an independent version');
    expect(guide).toContain('not an OS or network sandbox');
  });

  it('preserves actual governance scope syntax and the activation default', () => {
    const content = projectSkillForHost(getCanonicalSkill('governance'), 'github-copilot', 'project').renderedContent;
    expect(content).toContain('An unscoped governance execution call defaults to **activation**');
    expect(content).toContain('Never silently');
    expect(content).not.toContain('--scope repository-only');
    const base = {
      executable: 'liftoff', args: ['governance', 'status', '--project', '/project', '--json'],
      cwd: '/project', project: '/project', scope: 'activation',
      requiredAuthority: [], compatibilityIdentity: 'governance-output-v3'
    };
    expect(buildContextPreservingContinuation(base, { parseCommand: parseArgs }).scope).toBe('activation');
    expect(() => buildContextPreservingContinuation({ ...base, scope: 'repository' }, { parseCommand: parseArgs })).toThrow();
  });

  it('rejects generic approval for reviewed mutators without pretending all commands use the same flags', () => {
    for (const id of ['adopt', 'update', 'repair', 'governance', 'azure'] as const) {
      const skill = getCanonicalSkill(id);
      expect(skill.authorizationMechanism).toBe('reviewed-plan');
      expect(skill.content).toMatch(/Autopilot[\s\S]{0,200}(?:not consent|grant no|authorize no)/i);
      expect(skill.content).not.toContain('--yes');
    }
    expect(getCanonicalSkill('governance').content).toContain('`approve` action and its exact `--plan` binding');
    expect(getCanonicalSkill('repair').content).toContain('`--verify-plan` selects verification');
    expect(getCanonicalSkill('repair').content).toContain('`--approve-plan` selects the later');
  });

  it('retains only the actual initialization/migration consent and human-output contracts', () => {
    for (const id of ['init', 'migrate'] as const) {
      const skill = getCanonicalSkill(id);
      expect(skill).toMatchObject({ commandOutput: 'human', commandResultSchema: null, authorizationMechanism: 'flag-consent' });
      expect(skill.content).toContain('`--yes`');
      expect(skill.content).toMatch(/confirmation only|confirms choices\/plan only/);
      expect(skill.content).toMatch(/not source changes|does NOT authorize file/);
      expect(() => parseArgs([id, '--json'])).toThrow();
      expect(() => parseArgs([id, '--approve-plan', 'a'.repeat(64)])).toThrow();
    }
  });

  it('keeps routine verified-owner upgrade invocation free of an extra fingerprint gate', () => {
    const upgrade = getCanonicalSkill('cli-upgrade');
    expect(upgrade).toMatchObject({ authorizationRequired: false, authorizationMechanism: 'command-invocation' });
    expect(upgrade.content).toContain('does **not** require an extra confirmation');
    expect(upgrade.content).toContain('npm is not a current native release channel');
    expect(upgrade.content).toContain('Existing projects, manifests, Node/npm dependencies');
    expect(upgrade.content).not.toContain('--approve-plan');
  });

  it('preserves provider-proof, changed-input, and partial-outcome boundaries', () => {
    const azure = getCanonicalSkill('azure').content;
    expect(azure).toContain('No metadata Boolean, fixture, model assertion');
    expect(azure).toContain('cannot be replaced by synthetic proof');
    expect(azure).toContain('cross-provider atomic rollback');
    const repair = getCanonicalSkill('repair').content;
    expect(repair).toContain('Never require human hash entry');
    expect(repair).toContain('uncertain process settlement blocks success');
    expect(repair).toContain('Cancellation cannot undo host/network effects');
    const update = getCanonicalSkill('update').content;
    expect(update).toContain('default No. No manual hash entry');
    expect(update).toContain('Pending transactions/private workspaces block');
  });
});
