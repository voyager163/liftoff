import * as fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseProjectConfigOptions } from '../src/adapters/filesystem/project-config.js';
import { projectCatalog } from '../src/application/project/catalog.js';
import {
  readConfiguredModernUpdateRoute,
  readRecordedModernUpdateSelection
} from '../src/application/update/modern-update-selection.js';
import { inspectModernSuccessorUpdate } from '../src/application/update/inspection.js';
import { applyModernSuccessorUpdate, previewModernSuccessorUpdate, recoverModernSuccessorUpdate } from '../src/application/update/use-case.js';
import {
  approval,
  fixture,
  freshManifestFixture,
  inventory,
  write
} from './fixtures/manifest-update.js';

const selected = { kind: 'recorded-project-intent' } as const;

describe('recorded project intent for current update', () => {
  it.each(['0.3.4', '0.4.1', '0.7.0', '0.8.0', '0.9.9', '0.10.0', '0.11.3', '0.12.3'])(
    'derives the %s core target without creating desired configuration', async version => {
      const project = await fixture(version), before = await inventory(project.root);
      const result = await readRecordedModernUpdateSelection(project.root);
      expect(result.selection).toEqual(project.selection);
      expect(result.snapshots.find(file => file.pathParts.join('/') === 'liftoff.config.json')).toEqual({
        pathParts: ['liftoff.config.json']
      });
      const preview = await previewModernSuccessorUpdate(project.root, selected, project.options);
      expect(preview.configurationReview).toEqual({ present: false, deferredFields: [] });
      expect(preview.plans[0].operations.at(-1)?.pathParts).toEqual(['liftoff.manifest.json']);
      expect(await inventory(project.root)).toEqual(before);
      expect(await applyModernSuccessorUpdate({
        projectRoot: project.root, selection: selected, force: false, approvePlan: preview.receipt.variants[0].fingerprint
      }, approval(), project.options)).toMatchObject({ status: 'committed-incomplete', committed: true });
      const current = await readRecordedModernUpdateSelection(project.root);
      expect(current.selection).toEqual(project.selection);
      const after = await inventory(project.root);
      expect(after['liftoff.config.json']).toBeUndefined();
      expect(after['application.txt']).toEqual(before['application.txt']);
    }
  );

  it.each([
    ['projectName', 'Other project'], ['projectType', 'genai'], ['apiStack', 'node-fastify'],
    ['pattern', 'agent'], ['cloud', 'aws'], ['region', 'southeastasia'], ['includeFrontend', true],
    ['specWorkflow', 'manual'], ['agents', ['codex']], ['defaultAgent', 'codex'],
    ['governanceProfile', 'none'], ['environments', ['prod']]
  ])('refuses changed configured %s without minting a receipt', async (field, value) => {
    const project = await fixture();
    await write(project.root, ['liftoff.config.json'], JSON.stringify({ [String(field)]: value }));
    const before = await inventory(project.root);
    await expect(previewModernSuccessorUpdate(project.root, selected, project.options)).rejects.toThrow();
    expect(await inventory(project.root)).toEqual(before);
    expect(await fs.readdir(project.home)).toEqual([]);
  });

  it.each(['before', 'during'] as const)('binds config bytes, even an equivalent formatting change %s consent', async timing => {
    const project = await fixture();
    await write(project.root, ['liftoff.config.json'], '{}\n');
    const preview = await previewModernSuccessorUpdate(project.root, selected, project.options);
    let before = await inventory(project.root), prompts = 0;
    const change = async () => {
      await write(project.root, ['liftoff.config.json'], '{ }\r\n');
      before = await inventory(project.root);
    };
    if (timing === 'before') await change();
    await expect(applyModernSuccessorUpdate({
      projectRoot: project.root, selection: selected, force: false
    }, approval(async () => { prompts++; await change(); return true; }), project.options)).rejects.toThrow(/changed|differs/iu);
    expect(prompts).toBe(timing === 'before' ? 0 : 1);
    expect(await inventory(project.root)).toEqual(before);
    expect(preview.plans.length).toBeGreaterThan(0);
  });

  it('binds config absence rather than ignoring its later appearance', async () => {
    const project = await fixture();
    const preview = await previewModernSuccessorUpdate(project.root, selected, project.options);
    await write(project.root, ['liftoff.config.json'], '{}');
    const before = await inventory(project.root);
    await expect(applyModernSuccessorUpdate({
      projectRoot: project.root, selection: selected, force: false, approvePlan: preview.receipt.variants[0].fingerprint
    }, approval(), project.options)).rejects.toThrow(/changed|differs/iu);
    expect(await inventory(project.root)).toEqual(before);
  });

  it('binds actual configuration mode as well as its content', async () => {
    const project = await fixture(), config = path.join(project.root, 'liftoff.config.json');
    await write(project.root, ['liftoff.config.json'], '{}\n');
    await fs.chmod(config, 0o600);
    const preview = await previewModernSuccessorUpdate(project.root, selected, project.options);
    await fs.chmod(config, 0o400);
    const before = await inventory(project.root);
    try {
      await expect(applyModernSuccessorUpdate({
        projectRoot: project.root, selection: selected, force: false, approvePlan: preview.receipt.variants[0].fingerprint
      }, approval(), project.options)).rejects.toThrow(/changed|differs/iu);
      expect(await inventory(project.root)).toEqual(before);
    } finally { await fs.chmod(config, 0o600); }
  });

  it('normalizes equivalent desired names and environment ordering without changing recorded intent', async () => {
    const project = await fixture(), { project: recorded } = project.selection.selection;
    await write(project.root, ['liftoff.config.json'], JSON.stringify({
      projectName: `  ${recorded.name}  `, environments: [...recorded.workload.environments].reverse(),
      region: recorded.workload.region, includeFrontend: recorded.workload.frontend
    }));
    expect((await readRecordedModernUpdateSelection(project.root)).selection).toEqual(project.selection);
  });

  it('does not interpret unspecified historical governance as a team transition', async () => {
    const project = await fixture('0.3.4');
    await write(project.root, ['liftoff.config.json'], '{"governanceProfile":"team-gitflow"}');
    await expect(readRecordedModernUpdateSelection(project.root)).rejects.toThrow(/cannot introduce team policy/u);
  });

  it('preserves uncertainty for legacy framework agents and explicitly reports unapplied intent', async () => {
    const project = await fixture('0.3.4');
    await write(project.root, ['liftoff.config.json'], JSON.stringify({ agents: ['github-copilot'], defaultAgent: 'github-copilot' }));
    const result = await readRecordedModernUpdateSelection(project.root);
    expect(result.selection.selection.project.agents).toEqual([]);
    expect(result.selection.selection.framework.state).toBe('legacy');
    expect(result.deferredConfiguration).toEqual(['agents', 'defaultAgent']);
  });

  it.each(['symlink', 'hardlink', 'directory', 'invalid-json', 'invalid-utf8'] as const)(
    'rejects %s configuration before preview issuance', async kind => {
      const project = await fixture(), config = path.join(project.root, 'liftoff.config.json');
      if (kind === 'symlink') await fs.symlink(path.join(project.root, 'application.txt'), config);
      else if (kind === 'hardlink') await fs.link(path.join(project.root, 'application.txt'), config);
      else if (kind === 'directory') await fs.mkdir(config);
      else await fs.writeFile(config, kind === 'invalid-json' ? '{' : Buffer.from([0xff]));
      await expect(previewModernSuccessorUpdate(project.root, selected, project.options)).rejects.toThrow();
      expect(await fs.readdir(project.home)).toEqual([]);
    }
  );

  it('keeps default legacy agent validation unchanged', () => {
    expect(() => parseProjectConfigOptions({ agents: [] }, projectCatalog)).toThrow(/non-empty string array/u);
    expect(parseProjectConfigOptions({ agents: [] }, projectCatalog, { allowEmptyAgents: true }).agents).toEqual([]);
    expect(() => parseProjectConfigOptions({ specWorkflow: 'manual' }, projectCatalog)).toThrow(/unsupported/u);
    expect(parseProjectConfigOptions({ governanceProfile: 'team-gitflow' }, projectCatalog).governanceProfile)
      .toBe('team-gitflow');
  });

  it('binds observed configuration without replacing original source-history identity', async () => {
    const project = await fixture();
    await write(project.root, ['liftoff.config.json'], '{}\n');
    const explicit = await inspectModernSuccessorUpdate(project.root, project.selection);
    const recorded = await inspectModernSuccessorUpdate(project.root, selected);
    expect(recorded.source.sourceBinding).toBe(explicit.source.sourceBinding);
    expect(recorded.successorPlan.semanticTransitionDigest).toBe(explicit.successorPlan.semanticTransitionDigest);
    expect(recorded.snapshots.length).toBe(explicit.snapshots.length + 1);
  });

  it('classifies workflow and same-workflow plugin changes before ordinary maintenance', async () => {
    const workflow = await freshManifestFixture(
      'single-maintainer-gitflow',
      'openspec'
    );
    await write(workflow.root, ['liftoff.config.json'], JSON.stringify({
      specWorkflow: 'manual',
      agents: []
    }));
    expect(await readConfiguredModernUpdateRoute(workflow.root)).toEqual({
      kind: 'workflow-transition',
      target: 'manual',
      agents: [],
      defaultAgent: undefined
    });

    const plugins = await freshManifestFixture(
      'single-maintainer-gitflow',
      'openspec'
    );
    await write(plugins.root, ['liftoff.config.json'], JSON.stringify({
      agents: ['codex']
    }));
    expect(await readConfiguredModernUpdateRoute(plugins.root)).toEqual({
      kind: 'plugin-transition',
      fields: ['agents']
    });
  });

  it('never interprets a malformed manifest to inspect selected recovery', async () => {
    const project = await fixture();
    await write(project.root, ['liftoff.manifest.json'], '{partial');
    await write(project.root, ['liftoff.config.json'], '{partial');
    const before = await inventory(project.root);
    expect(await recoverModernSuccessorUpdate({ projectRoot: project.root, planFingerprint: 'a'.repeat(64) }, project.options))
      .toMatchObject({ status: 'recovery-absent' });
    expect(await inventory(project.root)).toEqual(before);
  });
});
