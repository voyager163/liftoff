import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { expect } from 'vitest';
import { createSkillsTransactionApprovalStore } from '../../src/adapters/filesystem/update-previews.js';
import { executeSkillsUseCase, type SkillsUseCaseDependencies } from '../../src/application/skills/use-case.js';
import type { SkillsCommandOptions } from '../../src/application/skills/request.js';
import type { SkillCatalog, SkillDeliveryPlan } from '../../src/domain/skills/contracts.js';

export async function skillsFixture(): Promise<{
  root: string;
  home: string;
  cwd: string;
  project: string;
  dependencies: SkillsUseCaseDependencies;
  preview(options?: SkillsCommandOptions): Promise<SkillDeliveryPlan>;
  apply(options?: SkillsCommandOptions): ReturnType<typeof executeSkillsUseCase>;
  cleanup(): Promise<void>;
}> {
  const root = path.resolve(`tests/.skills-transaction-${process.pid}-${randomUUID()}`);
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'cwd');
  const project = path.join(root, 'project');
  await Promise.all([home, cwd, project].map((directory) => mkdir(directory, { recursive: true })));
  const now = () => new Date('2026-09-14T12:01:00.000Z');
  const storage = { env: {}, homedir: home, repositoryRoot: project, clock: now };
  const dependencies: SkillsUseCaseDependencies = {
    homeDirectory: home, now, approvalStorage: storage, workspaceStorage: storage
  };
  const defaultRequest: SkillsCommandOptions = { subcommand: 'install', hosts: ['claude'], skillId: 'assess' };
  const preview = async (options: SkillsCommandOptions = {}): Promise<SkillDeliveryPlan> => {
    const outcome = await executeSkillsUseCase({ ...defaultRequest, ...options, check: true }, { cwd }, dependencies);
    expect(outcome.outcome).toBe('planned');
    if (outcome.outcome !== 'planned') throw new Error(`Unexpected skills preview: ${JSON.stringify(outcome)}`);
    return outcome.result;
  };
  return {
    root, home, cwd, project, dependencies, preview,
    apply: async (options = {}) => {
      const plan = await preview(options);
      return executeSkillsUseCase({
        ...defaultRequest, ...options, approvePlan: plan.fingerprint
      }, { cwd }, dependencies);
    },
    cleanup: () => rm(root, { recursive: true, force: true })
  };
}

export function terminalStreams() {
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  const stdout = new PassThrough();
  const stderr = Object.assign(new PassThrough(), { isTTY: true });
  return { stdin, stdout, stderr };
}

export function fixtureApprovalStore(home: string) {
  return createSkillsTransactionApprovalStore(home, 'user', {
    env: {}, homedir: home, clock: () => new Date('2026-09-14T12:01:00.000Z')
  });
}

export async function stageSkillCatalog(root: string, catalog: SkillCatalog): Promise<string> {
  const catalogRoot = path.join(root, 'catalog-inputs');
  const skillsRoot = path.join(catalogRoot, 'assets', 'skills');
  await mkdir(skillsRoot, { recursive: true });
  const metadata = {
    schemaVersion: catalog.schemaVersion, catalogVersion: catalog.catalogVersion,
    skills: catalog.skills.map((skill) => {
      const { content: _content, contentHash: _hash, ...definition } = skill;
      return definition;
    })
  };
  await writeFile(path.join(skillsRoot, 'catalog.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  for (const skill of catalog.skills) {
    await mkdir(path.join(skillsRoot, skill.id), { recursive: true });
    await writeFile(path.join(skillsRoot, skill.id, 'SKILL.md'), skill.content!);
  }
  return catalogRoot;
}
