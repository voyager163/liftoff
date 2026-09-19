import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExecutionContext } from '../src/application/context.js';
import { inspectAdoption } from '../src/application/project-evolution/adoption/planning.js';
import type { AdoptionProposal } from '../src/application/project-evolution/adoption/proposal.js';
import { adoptProject, type AdoptRequest, type AdoptionReport } from '../src/application/project-evolution/adoption/use-case.js';
import { PresentationSession } from '../src/terminal.js';
import { CaptureStream } from './helpers.js';

export const adoptionFixtureClock = new Date('2026-09-15T08:00:00Z');

export async function createAdoptionFixture(
  roots: string[],
  files: Readonly<Record<string, string>> = {
    'package.json': '{"name":"fixture-vue","private":true,"type":"module","dependencies":{"vue":"^3.5.0"}}\n',
    'App.vue': '<template><main>Unchanged application</main></template>\n'
  }
) {
  const parent = path.resolve('tests', `.adoption-boundary-${randomUUID()}`);
  roots.push(parent);
  const root = path.join(parent, 'project'), home = path.join(parent, 'home'), staging = path.join(parent, 'staging');
  for (const directory of [root, home, staging]) await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [name, content] of Object.entries(files)) {
    const filename = path.join(root, ...name.split('/'));
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, content);
  }
  return { parent, root, home, staging };
}

export type AdoptionFixture = Awaited<ReturnType<typeof createAdoptionFixture>>;

export function adoptionFixtureStorage(fixture: AdoptionFixture) {
  return { homedir: fixture.home, env: {}, repositoryRoot: fixture.root, clock: () => adoptionFixtureClock };
}

export async function invokeAdoptionFixture(
  fixture: AdoptionFixture, request: Omit<AdoptRequest, 'project'>, extra: Partial<ExecutionContext> = {}
) {
  const stdout = new CaptureStream(), stderr = new CaptureStream();
  const code = await adoptProject({ project: fixture.root, json: true, ...request }, {
    cwd: fixture.parent, stdout, stderr, presentation: new PresentationSession({ stdout, stderr, json: true }),
    updateNow: () => adoptionFixtureClock, updatePreview: adoptionFixtureStorage(fixture), ...extra
  });
  return { code, report: JSON.parse(stdout.text()) as AdoptionReport, stderr: stderr.text() };
}

export async function adoptionFixtureProposal(fixture: AdoptionFixture): Promise<AdoptionProposal> {
  const current = await inspectAdoption({
    project: fixture.root, profile: 'vue-component', now: adoptionFixtureClock,
    storage: adoptionFixtureStorage(fixture)
  });
  return {
    schemaVersion: 1, kind: 'liftoff-adoption-proposal', projectRoot: fixture.root,
    inspectionDigest: current.inventory.inspectionDigest, projectName: current.manifest.project.name,
    profile: current.plan.component.profile.id, componentRootPathParts: [],
    framework: { workflow: 'openspec', agents: [], initialize: false, copilotCloud: false },
    governanceProfile: 'none', dynamicReferencesReviewed: true, patch: null, additions: [],
    verification: { commands: [], preparation: [] }
  };
}

export function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected object in production fixture.');
  return value;
}

export function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return objectValue(value[key]);
}

export function arrayField(value: Record<string, unknown>, key: string): unknown[] {
  const array = value[key];
  if (!Array.isArray(array)) throw new Error(`Expected array ${key} in production fixture.`);
  return array;
}

export function firstObject(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return objectValue(arrayField(value, key)[0]);
}

export function stringField(value: Record<string, unknown>, key: string): string {
  const text = value[key];
  if (typeof text !== 'string') throw new Error(`Expected string ${key} in production fixture.`);
  return text;
}
