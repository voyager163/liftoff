import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, mkdtempSync, openSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFixtureProject } from '../src/application/initialize/fixture.js';
import { runCli } from '../src/cli.js';
import { runCommand } from '../src/cli/commands/dispatch.js';
import { CaptureStream, ReadyInitRunner } from './helpers.js';
import { coverageState } from './fixtures/governance-coverage/transition-project.js';

const symlinkedInputsRefused = constants.O_NOFOLLOW !== undefined && (() => {
  const probe = mkdtempSync(path.join(os.tmpdir(), 'liftoff-governance-inputs-probe-'));
  try {
    writeFileSync(path.join(probe, 'target.json'), '{}');
    symlinkSync(path.join(probe, 'target.json'), path.join(probe, 'link.json'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

// mkfifo runs synchronously and exits before the test continues.
function makeFifo(file: string): void {
  execFileSync('mkfifo', [file], { stdio: 'ignore', timeout: 10_000 });
}

const fifos = process.platform !== 'win32' && (() => {
  const probe = mkdtempSync(path.join(os.tmpdir(), 'liftoff-governance-inputs-probe-'));
  try {
    makeFifo(path.join(probe, 'probe-fifo'));
    return statSync(path.join(probe, 'probe-fifo')).isFIFO();
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

// Observes an operation that must not wait for a FIFO writer. If it is still pending at the
// deadline, a non-blocking writer releases the open() waiting for one, so no reader thread is
// left behind, and the caller fails on `blocked`.
async function settleOrReleaseFifo<T>(operation: Promise<T>, fifo: string, deadlineMs: number): Promise<{
  blocked: boolean; result: PromiseSettledResult<T>;
}> {
  const settled = operation.then(
    (value): PromiseSettledResult<T> => ({ status: 'fulfilled', value }),
    (reason: unknown): PromiseSettledResult<T> => ({ status: 'rejected', reason })
  );
  const within = async (milliseconds: number) => {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'pending'>((resolve) => {
      timer = setTimeout(() => resolve('pending'), milliseconds);
    });
    try {
      return await Promise.race([settled, deadline]);
    } finally {
      clearTimeout(timer);
    }
  };
  const first = await within(deadlineMs);
  if (first !== 'pending') return { blocked: false, result: first };
  let released = false;
  for (let attempt = 0; !released && attempt < 250; attempt += 1) {
    try {
      closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
      released = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENXIO' || await within(20) !== 'pending') break;
    }
  }
  const final = await within(10_000);
  if (final === 'pending') throw new Error('The FIFO reader could not be released.');
  return { blocked: true, result: final };
}

const notJson = 'Activation inputs are not valid JSON; credential or state content must not be supplied here.';
const refusal = 'Activation inputs must be a singly linked regular public JSON file no larger than 64 KiB.';
const cleanups: string[] = [];
let project = '';
let workspace = '';
let baselineFingerprint = '';
let previewStore = { directory: '', prefix: '' };

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// The real entrypoint: argv parsing, command dispatch and error rendering. Only the process
// runner is the deterministic test double, and telemetry is never prepared or sent.
async function governance(args: readonly string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const afterCommand = vi.fn(async () => undefined);
  const code = await runCli({
    argv: ['governance', ...args],
    cwd,
    stdin: Readable.from([]),
    stdout,
    stderr,
    env: { ...process.env, LIFTOFF_TELEMETRY: '0', DO_NOT_TRACK: '1' },
    telemetry: { beforeCommand: async () => false, afterCommand },
    execute: (parsed, context) => runCommand(parsed, {
      ...context, runner: new ReadyInitRunner(), terminal: { snapshot: true, columns: 100 }
    })
  });
  expect(afterCommand).not.toHaveBeenCalled();
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

async function projectTree(root: string): Promise<Record<string, string>> {
  const tree: Record<string, string> = {};
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const key = path.relative(root, file).split(path.sep).join('/');
      if (entry.isDirectory()) {
        tree[`${key}/`] = 'directory';
        await walk(file);
      } else if (entry.isSymbolicLink()) {
        tree[key] = `symlink:${await readlink(file)}`;
      } else {
        tree[key] = createHash('sha256').update(await readFile(file)).digest('hex');
      }
    }
  };
  await walk(root);
  return tree;
}

async function projectPreviews(): Promise<string[]> {
  try {
    return (await readdir(previewStore.directory)).filter((name) => name.startsWith(previewStore.prefix)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function effects(): Promise<{ tree: Record<string, string>; previews: string[] }> {
  return { tree: await projectTree(project), previews: await projectPreviews() };
}

async function inputsFile(name: string, content: string): Promise<string> {
  const file = path.join(workspace, name);
  await writeFile(file, content);
  return file;
}

beforeAll(async () => {
  const userStateRoot = process.env.LIFTOFF_TEST_USER_STATE_ROOT;
  expect(userStateRoot, 'governance previews must be written only below the run-owned user state root').toBeTruthy();
  const isolatedRoot = await realpath(userStateRoot!);
  expect(inside(isolatedRoot, await realpath(os.homedir()))).toBe(true);

  project = await createFixtureProject({
    projectName: 'Governance Inputs Routing', projectType: 'standard', apiStack: 'node', cloud: 'azure', region: 'eastus',
    environments: ['dev'], specWorkflow: 'openspec', agents: ['github-copilot']
  });
  cleanups.push(path.dirname(project));
  workspace = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-governance-inputs-')));
  cleanups.push(workspace);

  const baseline = await governance(['plan', '--json'], project);
  expect(baseline.code).toBe(0);
  const planned = JSON.parse(baseline.stdout) as { preview: { fingerprint: string; path: string }; plan: { configuration?: unknown } };
  expect(planned.plan.configuration).toBeUndefined();
  expect(inside(isolatedRoot, await realpath(planned.preview.path))).toBe(true);
  baselineFingerprint = planned.preview.fingerprint;
  const name = path.basename(planned.preview.path);
  expect(name.endsWith(`-${baselineFingerprint}.json`)).toBe(true);
  previewStore = { directory: path.dirname(planned.preview.path), prefix: name.slice(0, name.length - `${baselineFingerprint}.json`.length) };
}, 60_000);

afterAll(async () => {
  while (cleanups.length > 0) await rm(cleanups.pop()!, { recursive: true, force: true });
});

describe('governance --inputs routing', () => {
  it('binds a valid public inputs file into the saved external preview without project writes', async () => {
    const inputs = { schemaVersion: 1, phases: {}, repository: { name: 'octo/governance-inputs', visibility: 'private' } };
    const file = await inputsFile('valid-inputs.json', `${JSON.stringify(inputs, null, 2)}\n`);
    const before = await effects();

    const result = await governance(['plan', '--inputs', file, '--json'], project);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout) as {
      projectWrites: boolean; preview: { fingerprint: string; path: string }; plan: { configuration?: unknown };
    };
    expect(output.projectWrites).toBe(false);
    expect(output.plan.configuration).toEqual(inputs);
    expect(output.preview.fingerprint).not.toBe(baselineFingerprint);
    const stored = JSON.parse(await readFile(output.preview.path, 'utf8')) as { plan: { configuration?: unknown } };
    expect(stored.plan.configuration).toEqual(inputs);

    const after = await effects();
    expect(after.tree).toEqual(before.tree);
    expect(after.previews).toEqual([...new Set([...before.previews, path.basename(output.preview.path)])].sort());
  });

  it('resolves a relative inputs path from the invocation directory, not the project root', async () => {
    const inputs = { schemaVersion: 1, phases: {}, repository: { name: 'octo/relative-inputs' } };
    await inputsFile('relative-inputs.json', JSON.stringify(inputs));
    const accepted = await governance(['plan', '--project', project, '--inputs', 'relative-inputs.json', '--json'], workspace);
    expect(accepted.code).toBe(0);
    expect((JSON.parse(accepted.stdout) as { plan: { configuration?: unknown } }).plan.configuration).toEqual(inputs);

    const projectOnly = path.join(project, 'project-only-inputs.json');
    await writeFile(projectOnly, JSON.stringify(inputs));
    try {
      const missing = await governance(['plan', '--project', project, '--inputs', 'project-only-inputs.json', '--json'], workspace);
      expect(missing.code).toBe(1);
      expect(missing.stdout).toBe('');
      expect(missing.stderr).toContain('ENOENT');
      expect(missing.stderr).toContain(path.join(workspace, 'project-only-inputs.json'));
    } finally {
      await rm(projectOnly, { force: true });
    }
  });

  it('refuses malformed inputs for every reading subcommand before inspection or writes, without echoing the payload', async () => {
    const sentinel = 'SENTINEL-governance-inputs-command-41d9';
    const file = await inputsFile('malformed-inputs.json', `{"repository": {"name": "${sentinel}"}, ${sentinel}`);
    for (const subcommand of ['plan', 'status', 'apply-next']) {
      const before = await effects();
      const result = await governance([subcommand, '--inputs', file, '--json'], project);
      expect(result.code, subcommand).toBe(1);
      expect(result.stdout, subcommand).toBe('');
      expect(result.stderr, subcommand).toContain(notJson);
      expect(`${result.stdout}${result.stderr}`, subcommand).not.toContain(sentinel);
      expect(await effects(), subcommand).toEqual(before);
    }
  });

  it('refuses oversized and unsupported inputs before any preview or project write', async () => {
    const oversized = await inputsFile('oversized-inputs.json', JSON.stringify({ schemaVersion: 1, phases: {} }).padEnd(64 * 1024 + 1, ' '));
    const unsupported = await inputsFile('unsupported-inputs.json', JSON.stringify({ schemaVersion: 2, phases: {} }));
    for (const [file, message] of [[oversized, refusal], [unsupported, 'activationInputs.schemaVersion must be 1.']] as const) {
      const before = await effects();
      const result = await governance(['plan', '--inputs', file, '--json'], project);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(message);
      expect(await effects()).toEqual(before);
    }
  });

  it.skipIf(!symlinkedInputsRefused)('refuses a symlinked inputs file without following it (requires symlinks and O_NOFOLLOW)', async () => {
    const target = await inputsFile('linked-target.json', JSON.stringify({ schemaVersion: 1, phases: {} }));
    const alias = path.join(workspace, 'linked-inputs.json');
    await symlink(target, alias);
    const before = await effects();

    const result = await governance(['plan', '--inputs', alias, '--json'], project);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('ELOOP');
    expect(await effects()).toEqual(before);
  });

  it.skipIf(!fifos)('refuses a FIFO inputs path without waiting for a writer or writing anything (requires mkfifo)', async () => {
    const fifo = path.join(workspace, 'fifo-inputs.json');
    makeFifo(fifo);
    try {
      const before = await effects();
      const { blocked, result } = await settleOrReleaseFifo(governance(['plan', '--inputs', fifo, '--json'], project), fifo, 5_000);
      expect(blocked, 'governance --inputs waited for a FIFO writer').toBe(false);
      expect(result.status).toBe('fulfilled');
      const outcome = (result as PromiseFulfilledResult<Awaited<ReturnType<typeof governance>>>).value;
      expect(outcome.code).toBe(1);
      expect(outcome.stdout).toBe('');
      expect(outcome.stderr).toContain(refusal);
      expect(await effects()).toEqual(before);
    } finally {
      await rm(fifo, { force: true });
    }
  });
});

// Input and approval diagnostics name trusted locations only; supplied keys, values and record content stay out of stderr.
describe('governance public-input and approval diagnostics', () => {
  const token = ['ghp', 'R'.repeat(36)].join('_');
  const escaped = 'SENTINEL-\u001b[2J-routing';
  let refusedInputs = 0;

  async function refusedWithoutEffects(subcommand: 'status' | 'plan', content: unknown, message: string, withheld: readonly string[]) {
    refusedInputs += 1;
    const file = await inputsFile(`refused-inputs-${refusedInputs}.json`, JSON.stringify(content));
    const before = await effects();
    const result = await governance([subcommand, '--inputs', file, '--json'], project);
    expect(result.code, message).toBe(1);
    expect(result.stdout, message).toBe('');
    expect(result.stderr, message).toContain(message);
    for (const text of withheld) expect(result.stderr, `${message} must withhold supplied text`).not.toContain(text);
    expect(await effects(), message).toEqual(before);
  }

  it('refuses credential-shaped repository names, phase field names and phase values before inspection or writes', async () => {
    for (const subcommand of ['status', 'plan'] as const) {
      await refusedWithoutEffects(subcommand, { schemaVersion: 1, phases: {}, repository: { name: `acme/${token}` } },
        'activationInputs.repository.name contains credential material; use protected credential enrollment instead.', [token]);
      await refusedWithoutEffects(subcommand, { schemaVersion: 1, phases: { 'runner-ready': { [token]: 'restricted' } } },
        'activationInputs.phases.runner-ready contains credential material in a field name; use protected credential enrollment instead.', [token]);
      await refusedWithoutEffects(subcommand, { schemaVersion: 1, phases: { 'runner-ready': { notes: ['Bearer SENTINELbearer0value'] } } },
        'activationInputs.phases.runner-ready contains credential material in a nested value; use protected credential enrollment instead.',
        ['SENTINELbearer0value']);
    }
  });

  it('repeats no unsupported supplied keys or values in input diagnostics', async () => {
    await refusedWithoutEffects('status', { schemaVersion: 1, phases: {}, [escaped]: 1 },
      'activationInputs contains an unsupported field; allowed fields: schemaVersion, phases, repository, azure, budget.', ['SENTINEL', '\u001b']);
    await refusedWithoutEffects('status', { schemaVersion: 1, phases: { [escaped]: {} } },
      'activationInputs.phases contains an unsupported phase identifier; use only phase ids from the managed phase graph.', ['SENTINEL', '\u001b']);
    await refusedWithoutEffects('status', { schemaVersion: 1, phases: {}, repository: { name: 'acme/widget', visibility: { token, note: escaped } } },
      'activationInputs.repository.visibility must be "private" or "public".', [token, 'SENTINEL', '\u001b']);
  });

  it('withholds malformed approval record content from governance diagnostics', async () => {
    const governanceDirectory = path.join(project, 'governance');
    const governanceExisted = await readdir(governanceDirectory).then(() => true, () => false);
    const approvals = path.join(governanceDirectory, 'approvals');
    const stateFile = path.join(governanceDirectory, 'activation-state.json');
    // Approval records are read only once an activation state exists; the shared coverage state is schema-valid.
    await mkdir(approvals, { recursive: true });
    await writeFile(stateFile, `${JSON.stringify(coverageState(), null, 2)}\n`);
    await writeFile(path.join(approvals, 'malformed.json'), '{"note": SENTINEL-approval-routing-9d0b}');
    try {
      const result = await governance(['status', '--json'], project);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(
        'Unable to parse governance/approvals/malformed.json: the file is not valid JSON; its content was withheld.'
      );
      expect(result.stderr).not.toContain('SENTINEL');
    } finally {
      if (governanceExisted) {
        await rm(approvals, { recursive: true, force: true });
        await rm(stateFile, { force: true });
      } else {
        await rm(governanceDirectory, { recursive: true, force: true });
      }
    }
  });
});
