import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { buildPublicCapabilitiesEnvelope } from '../src/application/engine-composition.js';
import { negotiateSkillCapability, buildContextPreservingContinuation } from '../src/application/skills/capability-negotiation.js';
import { loadCanonicalSkillCatalog } from '../src/adapters/packaged-assets/skill-assets.js';
import { parseArgs } from '../src/cli/args/parser.js';

describe('Canonical negotiation against the real public capability contract', () => {
  it('matches exact installed capability IDs, owners, authorization, and human/JSON contracts', () => {
    const envelope = buildPublicCapabilitiesEnvelope();
    for (const skill of loadCanonicalSkillCatalog().skills) {
      const capability = envelope.capabilities.find((entry) => entry.id === skill.requiredCapability)!;
      expect(capability.owner).toBe(skill.owningEngine);
      expect(capability.authorization.mechanism).toBe(skill.authorizationMechanism);
      expect(capability.commandSchema.resultSchemaVersion).toBe(skill.commandResultSchema);
      const result = negotiateSkillCapability(skill, envelope);
      expect(result.status, result.details).not.toBe('unsupported');
      expect(result.authority).toBe('none');
      expect(result).not.toHaveProperty('supportedContinuations');
    }
    expect(negotiateSkillCapability('init', envelope).commandResultSchema).toBeNull();
    expect(negotiateSkillCapability('migrate', envelope).commandOutput).toBe('human');
    expect(negotiateSkillCapability('repair', envelope)).toMatchObject({ commandResultSchema: 2, contractVersion: 1 });
  });

  it.each([undefined, null, {}, { schemaVersion: 1, capabilities: { 'project-repair': {} } }, { schemaVersion: 99, capabilities: [] }])(
    'rejects incomplete or obsolete capability documents instead of defaulting to executable: %j', (input) => {
      expect(negotiateSkillCapability('repair', input)).toMatchObject({ status: 'unsupported', authority: 'none' });
    }
  );

  it('rejects missing schemas/contracts and unknown selected capability data', () => {
    const source = buildPublicCapabilitiesEnvelope();
    for (const patch of [
      { commandSchema: {} },
      { commandSchema: { resultSchemaVersion: 2 } },
      { commandSchema: { resultSchemaVersion: 1, contractVersion: 1 } },
      { commandSchema: { resultSchemaVersion: 2, contractVersion: 1, extra: true } },
      { owner: 'Project Generation' },
      { authorization: { mechanism: 'command-invocation' } },
      { authorization: { mechanism: 'reviewed-plan' } },
      { authorization: { mechanism: 'reviewed-plan', defaultDecision: 'yes' } },
      { authorization: { mechanism: 'reviewed-plan', defaultDecision: 'no', automationFlags: ['--yes'] } },
      { requiredInputs: [1] },
      { qualificationState: 'available' }
    ]) {
      const envelope = {
        ...source,
        capabilities: source.capabilities.map((capability) =>
          capability.id === 'project-repair' ? { ...capability, ...patch } : capability)
      };
      expect(negotiateSkillCapability('repair', envelope).status, JSON.stringify(patch)).toBe('unsupported');
    }
  });

  it.each([
    ['unqualified', 'built-in', 'unqualified'],
    ['prerequisite-blocked', 'built-in', 'prerequisite-blocked'],
    ['implementation-missing', 'unavailable', 'plan-only'],
    ['planner-only', 'unavailable', 'plan-only'],
    ['unqualified', 'injected-only', 'unqualified']
  ] as const)('preserves %s capability state without inventing execution', (qualificationState, executor, expected) => {
    const source = buildPublicCapabilitiesEnvelope();
    const envelope = {
      ...source,
      capabilities: source.capabilities.map((capability) =>
        capability.id === 'project-repair' ? { ...capability, qualificationState, executor } : capability)
    };
    expect(negotiateSkillCapability('repair', envelope).status).toBe(expected);
  });

  it('does not qualify a host from supportedHosts or a fixture claiming a qualified CLI', () => {
    const envelope = buildPublicCapabilitiesEnvelope();
    expect(negotiateSkillCapability('repair', envelope, 'claude')).toMatchObject({
      status: 'unqualified', hostQualification: 'unqualified', authority: 'none'
    });
    expect(negotiateSkillCapability('repair', envelope, 'unknown' as never).status).toBe('unsupported');
  });
});

describe('Strict context preservation with production command admission', () => {
  const admission = { parseCommand: parseArgs };
  const project = path.resolve('tests/project with spaces');
  const base = {
    executable: 'liftoff', args: ['update', '--check', '--project', project, '--json'],
    cwd: project, scope: 'project', project, requiredAuthority: [], compatibilityIdentity: 'update-output-v3'
  };

  it('retains literal executable/arguments/cwd/project/configuration instead of reconstructing a command from a capability ID', () => {
    const config = path.join(project, 'liftoff.config.json');
    const result = buildContextPreservingContinuation({
      ...base, configRef: { path: config, digest: 'a'.repeat(64) }
    }, admission);
    expect(result).toMatchObject({ ...base, configRef: { path: config, digest: 'a'.repeat(64) } });
    expect(result.args).not.toBe(base.args);
    expect(() => buildContextPreservingContinuation({ ...base, args: ['project-update'] }, admission)).toThrow();
  });

  it('retains explicit personal targets without inventing a project', () => {
    const home = path.resolve('tests/isolated personal home');
    const result = buildContextPreservingContinuation({
      executable: 'liftoff', args: ['skills', 'update', '--scope', 'user', '--host', 'codex', '--check', '--json'],
      cwd: path.resolve('tests/unrelated repository'), scope: 'user', userTarget: home,
      requiredAuthority: [], compatibilityIdentity: 'skills-delivery-v1'
    }, { ...admission, userTarget: home });
    expect(result.userTarget).toBe(home);
    expect(result).not.toHaveProperty('project');
  });

  it('requires an independently observed personal target and rejects scope substitution', () => {
    const home = path.resolve('tests/isolated personal home');
    const personal = {
      executable: 'liftoff', args: ['skills', 'update', '--host', 'codex', '--check', '--json'],
      cwd: project, scope: 'user', userTarget: home,
      requiredAuthority: [], compatibilityIdentity: 'skills-delivery-v1'
    };
    expect(() => buildContextPreservingContinuation(personal, admission)).toThrow(/independently observed/);
    expect(() => buildContextPreservingContinuation(personal, {
      ...admission, userTarget: path.resolve('tests/another home')
    })).toThrow(/independently observed/);
    expect(() => buildContextPreservingContinuation({
      ...personal, scope: 'global', userTarget: undefined
    }, admission)).toThrow(/scope/);
    expect(() => buildContextPreservingContinuation({
      ...base, scope: 'global', project: undefined
    }, admission)).toThrow(/scope/);
    expect(() => buildContextPreservingContinuation({
      ...personal, args: base.args
    }, { ...admission, userTarget: home })).toThrow(/scope/);
    expect(() => buildContextPreservingContinuation({
      ...base, userTarget: home
    }, { ...admission, userTarget: home })).toThrow(/target|scope/);
  });

  it('keeps project-free inspection separate from actual installation targets', () => {
    const common = {
      executable: 'liftoff', cwd: project, requiredAuthority: [], compatibilityIdentity: 'public-inspection-v1'
    };
    for (const args of [['capabilities', '--json'], ['skills', 'list', '--json'], ['repair', '--capabilities', '--json']]) {
      expect(buildContextPreservingContinuation({ ...common, args, scope: 'global' }, admission).scope).toBe('global');
    }
    const userTarget = path.resolve('tests/isolated installation');
    const action = { ...common, args: ['upgrade', '--check', '--json'], scope: 'installation', userTarget };
    expect(buildContextPreservingContinuation(action, { ...admission, userTarget }).userTarget).toBe(userTarget);
    expect(() => buildContextPreservingContinuation({
      ...action, scope: 'project', project, userTarget: undefined
    }, admission)).toThrow(/scope/);
  });

  it.each([
    { args: ['update', '--yes'] },
    { args: ['update', '--project', 'other-project'] },
    { args: ['update', '--project', project, '--check', 1] },
    { cwd: '../relative' },
    { scope: 'user' },
    { requiredAuthority: ['files', 'files'] },
    { compatibilityIdentity: '' },
    { executable: '/bin/sh' },
    { configRef: { path: path.join(project, 'liftoff.config.json'), digest: 'bad' } },
    { extra: true }
  ])('rejects malformed or context-changing actions: %j', (patch) => {
    expect(() => buildContextPreservingContinuation({ ...base, ...patch }, admission)).toThrow();
  });

  it('preserves activation as the omitted governance scope and refuses silent narrowing', () => {
    const request = {
      ...base, args: ['governance', 'status', '--project', project, '--json'], scope: 'activation',
      compatibilityIdentity: 'governance-output-v3'
    };
    expect(buildContextPreservingContinuation(request, admission).scope).toBe('activation');
    expect(() => buildContextPreservingContinuation({ ...request, scope: 'repository' }, admission)).toThrow();
  });

  it('retains original configuration binding when cwd changes', () => {
    const originalCwd = path.resolve('tests/original workspace');
    const config = path.join(originalCwd, 'activation.json');
    const request = {
      ...base, cwd: originalCwd, scope: 'activation',
      args: ['governance', 'plan', '--project', project, '--inputs', 'activation.json', '--json'],
      configRef: { path: config, digest: 'a'.repeat(64) }
    };
    expect(buildContextPreservingContinuation(request, admission).configRef?.path).toBe(config);
    expect(() => buildContextPreservingContinuation({ ...request, cwd: project }, admission)).toThrow();
    expect(buildContextPreservingContinuation({
      ...request, cwd: project,
      args: ['governance', 'plan', '--project', project, '--inputs', config, '--json']
    }, admission).configRef?.path).toBe(config);
  });

  it('retains Windows drive/UNC arguments literally and rejects device or traversal aliases', () => {
    const windows = {
      ...base, cwd: 'C:\\work trees\\project', project: 'C:\\work trees\\project',
      args: ['update', '--check', '--project', 'C:\\work trees\\project', '--json']
    };
    expect(buildContextPreservingContinuation(windows, admission).project).toBe(windows.project);
    const unc = { ...windows, cwd: '\\\\server\\share\\project', project: '\\\\server\\share\\project' };
    expect(buildContextPreservingContinuation({ ...unc, args: ['update', '--check', '--project', unc.project] }, admission).project).toBe(unc.project);
    expect(() => buildContextPreservingContinuation({ ...windows, cwd: '\\\\?\\C:\\project' }, admission)).toThrow();
    expect(() => buildContextPreservingContinuation({ ...windows, cwd: 'C:\\one\\..\\project' }, admission)).toThrow();
    for (const cwd of ['C:\\work\\NUL', 'C:\\work\\project.', 'C:\\work\\file:stream', 'C:\\work\\e\u0301']) {
      expect(() => buildContextPreservingContinuation({
        ...windows, cwd, project: cwd, args: ['update', '--check', '--project', cwd]
      }, admission), cwd).toThrow();
    }
  });

  it('binds human-only generation targets and fresh migration sources without pretending they emit JSON', () => {
    const cwd = path.resolve('tests/generation parent');
    const target = path.join(cwd, 'new-app');
    const source = path.resolve('tests/existing app');
    const init = {
      ...base, cwd, project: target, target, args: ['init', 'new-app', '--api', 'go'],
      requiredAuthority: ['user initialization consent'], compatibilityIdentity: 'project-generation-human'
    };
    expect(buildContextPreservingContinuation(init, admission).target).toBe(target);
    expect(buildContextPreservingContinuation({
      ...init, args: ['plan', '--project', 'new-app', '--api', 'go'], requiredAuthority: []
    }, admission).target).toBe(target);
    expect(() => buildContextPreservingContinuation({ ...init, target: path.join(cwd, 'other') }, admission)).toThrow();
    const migration = {
      ...init, source, args: ['migrate', source, '--project', 'new-app', '--api', 'go'],
      compatibilityIdentity: 'project-migration-human'
    };
    expect(buildContextPreservingContinuation(migration, admission).source).toBe(source);
    expect(() => buildContextPreservingContinuation({ ...migration, source: target }, admission)).toThrow();
    expect(() => buildContextPreservingContinuation({ ...migration, args: [...migration.args, '--json'] }, admission)).toThrow();
  });
});
