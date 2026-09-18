import { mkdtemp, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { CANONICAL_SKILL_IDS } from '../src/domain/skills/contracts.js';
import { CaptureStream } from './helpers.js';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff skills cli ')));
  roots.push(root);
  const home = path.join(root, 'personal home');
  const cwd = path.join(root, 'unrelated repository');
  await mkdir(home);
  await mkdir(cwd);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  return { home, cwd };
}

async function invoke(argv: string[], cwd: string) {
  const stdout = new CaptureStream();
  const stderr = new CaptureStream();
  const exitCode = await runCli({
    argv, cwd, stdout, stderr, env: { LIFTOFF_TELEMETRY: '0' }
  });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

describe('public skills command routing', () => {
  it('lists the actual canonical catalog without project or personal writes', async () => {
    const { home, cwd } = await fixture();
    const result = await invoke(['skills', 'list', '--json'], cwd);
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ schemaVersion: 1, command: 'skills', outcome: 'listed' });
    expect(report).not.toHaveProperty('schema');
    expect(report.result.skills.map((skill: { id: string }) => skill.id).sort())
      .toEqual([...CANONICAL_SKILL_IDS].sort());
    expect(await readdir(home, { recursive: true })).toEqual([]);
    expect(await readdir(cwd, { recursive: true })).toEqual([]);
  });

  it('keeps a redirected installation as a project-independent preview', async () => {
    const { home, cwd } = await fixture();
    const result = await invoke(['skills', 'install', '--host', 'copilot,codex', '--json'], cwd);
    expect(result.exitCode).toBe(2);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      schemaVersion: 1, command: 'skills', outcome: 'planned', authorization: 'required',
      result: { targetRoot: home, scope: 'user', intent: 'install' }
    });
    expect(report.result.actions).toHaveLength(CANONICAL_SKILL_IDS.length);
    for (const action of report.result.actions) {
      expect(action.consumers).toEqual(['github-copilot', 'codex']);
    }
    expect(await readdir(home, { recursive: true })).toEqual([]);
    expect(await readdir(cwd, { recursive: true })).toEqual([]);
  });

  it('applies only the exact reviewed personal plan and leaves the invocation project untouched', async () => {
    const { home, cwd } = await fixture();
    const command = ['skills', 'install', '--host', 'copilot,codex', '--json'];
    const preview = await invoke([...command, '--check'], cwd);
    expect(preview.exitCode).toBe(2);
    const plan = JSON.parse(preview.stdout).result;
    const applied = await invoke([...command, '--approve-plan', plan.fingerprint], cwd);
    expect(applied.exitCode, `${applied.stdout}${applied.stderr}`).toBe(0);
    const result = JSON.parse(applied.stdout);
    expect(result).toMatchObject({
      schemaVersion: 1, outcome: 'executed',
      result: { outcome: 'applied', committed: true, verified: true, uncertain: false }
    });
    expect(await readdir(cwd, { recursive: true })).toEqual([]);
    for (const id of CANONICAL_SKILL_IDS) {
      expect(await readFile(path.join(home, '.agents', 'skills', `liftoff-${id}`, 'SKILL.md'), 'utf8'))
        .toContain(`name: liftoff-${id}`);
    }
    const unchanged = await invoke(command, cwd);
    expect(unchanged.exitCode).toBe(0);
    expect(JSON.parse(unchanged.stdout)).toMatchObject({
      outcome: 'executed', result: { outcome: 'unchanged', committed: false, verified: true }
    });
  });
});
