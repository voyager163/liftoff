import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { UpdatePreviewOptions } from '../src/adapters/filesystem/update-previews.js';
import { parseArgs } from '../src/args.js';
import { writeArtifacts, writeProjectFile } from '../src/file-system.js';
import { buildProjectPlan } from '../src/planner.js';
import { buildArtifacts } from '../src/templates.js';
import type { ProjectOptions } from '../src/types.js';

export interface UpdateTestResult {
  code: number;
  out: string;
  err: string;
}

const execFileAsync = promisify(execFile);
const fixtureDirectories: string[] = [];

export async function fingerprintUpdateTestProject(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    result[path.relative(root, absolute)] = createHash('sha256').update(await readFile(absolute)).digest('hex');
  }
  return result;
}

export async function createUpdateTestRoot(): Promise<string> {
  const directory = path.resolve(`.reviewed-update-fixture-${randomUUID()}`);
  fixtureDirectories.push(directory);
  const repositoryRoot = path.join(directory, 'repository');
  await mkdir(repositoryRoot, { recursive: true });
  await execFileAsync('git', ['init', '--quiet', repositoryRoot]);
  return repositoryRoot;
}

export async function cleanupUpdateTestRoots(): Promise<void> {
  while (fixtureDirectories.length > 0) {
    await rm(fixtureDirectories.pop()!, { recursive: true, force: true });
  }
}

export function updateTestPreviewOptions(cwd: string): UpdatePreviewOptions {
  const directory = fixtureDirectories.find((candidate) => {
    const relative = path.relative(candidate, path.resolve(cwd));
    return relative === '' || relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
  assert.ok(directory, 'Update tests must use an isolated fixture repository and receipt home.');
  return {
    homedir: path.join(directory, 'receipt-home'),
    env: { ...process.env, XDG_STATE_HOME: undefined, LOCALAPPDATA: undefined }
  };
}

export async function createReviewedUpdateFixture(options: ProjectOptions): Promise<string> {
  const repositoryRoot = await createUpdateTestRoot();
  const plan = buildProjectPlan(options, { requireProjectName: true });
  const target = path.join(repositoryRoot, plan.safeProjectName);
  await writeArtifacts(target, buildArtifacts(plan));
  for (const marker of [
    ...plan.framework.baseMarkers,
    ...plan.agents.flatMap((agent) => plan.framework.agentMarkers[agent.id])
  ]) {
    let content = 'fixture marker\n';
    if (marker.join('/') === '.specify/integration.json') {
      const installed = plan.agents.map((agent) => agent.integrationIds['spec-kit']);
      const defaultIntegration = plan.defaultAgent?.integrationIds['spec-kit'];
      content = `${JSON.stringify({
        integration_state_schema: 1,
        integration: defaultIntegration,
        default_integration: defaultIntegration,
        installed_integrations: installed,
        integration_settings: {}
      }, null, 2)}\n`;
    } else if (marker.join('/') === '.specify/init-options.json') {
      content = '{}\n';
    }
    await writeProjectFile(target, marker, content);
  }
  return target;
}

export async function reviewedUpdateArguments(
  args: string[],
  invokeRaw: (args: string[]) => Promise<UpdateTestResult>
): Promise<string[]> {
  const parsed = parseArgs(args);
  if (
    parsed.command !== 'update' || parsed.flags.check === true || parsed.flags.help === true ||
    Object.hasOwn(parsed.flags, 'approve-plan')
  ) {
    return args;
  }
  const project = parsed.positional[0] ??
    (typeof parsed.flags.project === 'string' ? parsed.flags.project : undefined);
  const preview = await invokeRaw([
    'update', '--check', '--json', ...(project === undefined ? [] : ['--project', project])
  ]);
  assert.ok(
    preview.code === 0 || preview.code === 2,
    `Expected an eligible preview before a positive update case, received ${preview.code}:\n${preview.out}\n${preview.err}`
  );
  const report = JSON.parse(preview.out) as {
    schemaVersion: number;
    scope: string;
    plans: Array<{ mode: string; fingerprint: string }>;
  };
  assert.equal(report.schemaVersion, 3);
  assert.equal(report.scope, 'project-update');
  assert.ok(Array.isArray(report.plans), 'The update preview must expose its effective plans.');
  if (preview.code === 0) return args;

  const mode = parsed.flags.force === true ? 'force' : 'normal';
  const selected = report.plans.filter((plan) => plan.mode === mode);
  assert.equal(selected.length, 1, `Expected exactly one previewed ${mode} plan; never substitute another mode.`);
  const fingerprint = selected[0]!.fingerprint;
  assert.equal(typeof fingerprint, 'string');
  assert.equal(fingerprint.length, 64);
  assert.match(fingerprint, /^[a-f0-9]{64}$/u);
  return [...args, '--approve-plan', fingerprint];
}
