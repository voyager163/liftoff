import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertWorkflowCheckovLiteralScope, checkWorkflowCheckovResult, readWorkflowCheckovPythonLauncher,
  WorkflowCheckovInvocation, WorkflowCheckovRefusal, workflowCheckovInventoryRoots
} from '../src/adapters/process/workflow-checkov.js';
import { parseWorkflowContextValidatorArgs } from '../src/workflow-context-validator.js';
import { NodeCommandRunner, type CommandResult } from '../src/process-runner.js';

describe('private Checkov protocol validation, not scanner or proof substitution', () => {
  const file = path.resolve('fixture-only', 'source.tf');
  const finding = (result = 'PASSED', check_id = 'CKV_AZURE_10') => ({
    check_id, check_result: { result }, resource: 'azurerm_network_security_group.fixture',
    file_abs_path: file, file_line_range: [1, 20]
  });

  describe('private GitHub Actions Checkov protocol, not workflow execution or a controlled-red source', () => {
    const file = path.resolve('fixture-only', '.github/workflows/ci.yml');
    const finding = (resource = 'on(Source fixture)', checkId = 'CKV_GHA_7', lines = [0, 1], result = 'PASSED') => ({
      check_id: checkId, check_result: { result }, resource, file_abs_path: file, file_line_range: lines
    });
    function report(failed = false) {
      return { check_type: 'github_actions',
        results: { passed_checks: [finding()], failed_checks: failed ? [finding('permissions', 'CKV2_GHA_1', [3, 4], 'FAILED')] : [],
          skipped_checks: [], parsing_errors: [] },
        summary: { passed: 1, failed: failed ? 1 : 0, skipped: 0, parsing_errors: 0,
          resource_count: 0, checkov_version: '3.3.20' } };
    }
    function command(value: unknown, status = 0): CommandResult {
      return { command: { executable: 'not-executed-protocol-data', args: [] }, displayCommand: 'not executed',
        status, signal: null, stdout: JSON.stringify(value), stderr: '', timedOut: false,
        processTreeSettled: true, processSpawned: true };
    }
    it.each([false, true])('requires actual nonempty Actions findings despite the unused zero resource counter (%s)', failed => {
      expect(checkWorkflowCheckovResult(command(report(failed), failed ? 1 : 0), [file], 'github_actions'))
        .toBe(failed ? 'failed' : 'passed');
      expect(() => checkWorkflowCheckovResult(command(report(failed), failed ? 0 : 1), [file], 'github_actions')).toThrow();
      expect(() => checkWorkflowCheckovResult(command(report(failed)), [file])).toThrow();
    });
    it('requires actual findings for every explicit workflow and rejects an invented populated counter', () => {
      const value = report();
      expect(() => checkWorkflowCheckovResult(command(value), [file, path.resolve('other/.github/workflows/empty.yml')], 'github_actions')).toThrow(/Every selected workflow/u);
      value.summary.resource_count = 1;
      expect(() => checkWorkflowCheckovResult(command(value), [file], 'github_actions')).toThrow(/counter shape/u);
      value.summary.resource_count = 0;
      value.results.passed_checks = []; value.summary.passed = 0;
      expect(() => checkWorkflowCheckovResult(command(value), [file], 'github_actions')).toThrow(/empty/u);
    });
    it('keeps real job/step identities distinct but refuses duplicate and contradictory source findings', () => {
      const value = report();
      value.results.passed_checks.push(finding('jobs(__proto__).steps[1](First)', 'CKV_GHA_3', [8, 10]),
        finding('jobs(__proto__).steps[2](Second)', 'CKV_GHA_3', [11, 13]));
      value.summary.passed = 3;
      expect(checkWorkflowCheckovResult(command(value), [file], 'github_actions')).toBe('passed');
      value.results.passed_checks.push(finding()); value.summary.passed++;
      expect(() => checkWorkflowCheckovResult(command(value), [file], 'github_actions')).toThrow(/Duplicate/u);
      const contradictory = report(true);
      contradictory.results.failed_checks[0] = finding('on(Source fixture)', 'CKV_GHA_7', [0, 1], 'FAILED');
      expect(() => checkWorkflowCheckovResult(command(contradictory, 1), [file], 'github_actions')).toThrow(/Duplicate/u);
    });
    it.each([
      { check_id: 'CKV_AZURE_10' }, { resource: 'arbitrary' }, { resource: 'jobs(../outside)' },
      { resource: 'jobs(test).steps[0]' }, { file_abs_path: path.resolve('other/.github/workflows/ci.yml') },
      { check_id: 'CKV_GHA_3' }, { file_line_range: [0, 0] }, { file_line_range: [-1, 1] },
      { file_line_range: [3, 2] }
    ])('refuses other-framework, foreign-file and invalid resource/span identity %j', patch => {
      const value = report();
      value.results.passed_checks[0] = { ...finding(), ...patch };
      expect(() => checkWorkflowCheckovResult(command(value), [file], 'github_actions')).toThrow();
    });
    it.each([
      { skipped: 1 }, { parsing_errors: 1 }, { passed: 0 }, { resource_count: -1 }, { checkov_version: '3.3.29' }
    ])('refuses suppressed, unparsed or inconsistent Actions reports %j', patch => {
      const value = report(); Object.assign(value.summary, patch);
      expect(() => checkWorkflowCheckovResult(command(value), [file], 'github_actions')).toThrow();
    });
    it('does not open public selectors, composite metadata, arbitrary paths or image execution', async () => {
      for (const selector of ['github_actions', 'checkov-workflows']) {
        expect(() => parseWorkflowContextValidatorArgs(['--validator', selector, '--source-sha', 'a'.repeat(40)])).toThrow();
      }
      const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-gha-file-kind-')));
      const run = vi.spyOn(NodeCommandRunner.prototype, 'run');
      try {
        for (const name of ['ci.yml', '.github/actions/action.yml', '.github/workflows/nested/ci.yml', 'source.tf', 'Dockerfile']) {
          const selected = new WorkflowCheckovInvocation(root, root, [path.join(root, name)], performance.now() + 180_000, 'github_actions');
          await expect(selected.execute({})).rejects.toThrow(/finite scanner framework/u);
          expect(selected.processSpawned).toBe(false);
        }
        expect(run).not.toHaveBeenCalled();
      } finally { run.mockRestore(); await rm(root, { recursive: true }); }
    });
  });

  function report(failed = false) {
    return { check_type: 'terraform',
      results: { passed_checks: failed ? [] : [finding()], failed_checks: failed ? [finding('FAILED')] : [],
        skipped_checks: [], parsing_errors: [] },
      summary: { passed: failed ? 0 : 1, failed: failed ? 1 : 0, skipped: 0,
        parsing_errors: 0, resource_count: 1, checkov_version: '3.3.20' } };
  }
  function command(value: unknown, status = 0): CommandResult {
    return { command: { executable: 'not-executed-protocol-data', args: [] }, displayCommand: 'not executed',
      status, signal: null, stdout: JSON.stringify(value), stderr: '', timedOut: false,
      processTreeSettled: true, processSpawned: true };
  }
  it.each([false, true])('checks internally consistent protocol data without issuing authority (%s)', failed => {
    expect(checkWorkflowCheckovResult(command(report(failed), failed ? 1 : 0), [file])).toBe(failed ? 'failed' : 'passed');
  });
  it.each([
    { signal: 'SIGTERM' as const }, { timedOut: true }, { outputLimitExceeded: true },
    { aborted: true }, { errorCode: 'ENOENT' }, { processTreeSettled: false },
    { processTreeSettled: undefined }, { processSpawned: false }, { status: null }, { status: 2 },
    { stdout: 'not json' }, { stdout: '{}\n{}' }
  ])('refuses incomplete process evidence %j', patch => {
    expect(() => checkWorkflowCheckovResult({ ...command(report()), ...patch }, [file])).toThrow();
  });
  it.each([null, [], {}, [report()], { ...report(), check_type: 'dockerfile' },
    { ...report(), summary: {} }, { ...report(), results: {} }])('refuses incomplete or other-framework reports %j', value => {
    expect(() => checkWorkflowCheckovResult(command(value), [file])).toThrow();
  });
  it.each([
    { passed: 2 }, { failed: 1 }, { skipped: 1 }, { parsing_errors: 1 }, { resource_count: 0 },
    { resource_count: 2 }, { resource_count: 1.5 }, { resource_count: '1' }, { checkov_version: '3.3.29' }
  ])('refuses contradictory, empty or unsupported coverage %j', patch => {
    const value = report(); Object.assign(value.summary, patch);
    expect(() => checkWorkflowCheckovResult(command(value), [file])).toThrow();
  });
  it.each(['passed_checks', 'failed_checks', 'skipped_checks', 'parsing_errors'] as const)(
    'requires the actual %s inventory', name => {
      const value = report();
      const result = { ...value, results: { ...value.results, [name]: null } };
      expect(() => checkWorkflowCheckovResult(command(result), [file])).toThrow();
    });
  it.each(['skipped_checks', 'parsing_errors'] as const)('refuses any actual %s entry', name => {
    const value = report(), result = { ...value, results: { ...value.results, [name]: [{ unavailable: true }] } };
    expect(() => checkWorkflowCheckovResult(command(result), [file])).toThrow();
  });
  it('refuses soft-fail and fabricated red exit/result disagreement', () => {
    expect(() => checkWorkflowCheckovResult(command(report(true), 0), [file])).toThrow(/exit status/u);
    expect(() => checkWorkflowCheckovResult(command(report(), 1), [file])).toThrow(/exit status/u);
  });
  it.each([
    { check_id: '' }, { check_id: 'custom-caller-policy' }, { check_result: { result: 'FAILED' } },
    { file_abs_path: path.resolve('different.tf') }, { file_abs_path: 'relative.tf' },
    { resource: '' }, { resource: null }, { file_line_range: [] }, { file_line_range: [0, 20] },
    { file_line_range: [20, 1] }, { file_line_range: [1, 1.5] }, { file_line_range: [1, 2, 3] }
  ])('refuses malformed or out-of-scope findings %j', patch => {
    const value = report(), result = { ...value, results: { ...value.results, passed_checks: [{ ...finding(), ...patch }] } };
    expect(() => checkWorkflowCheckovResult(command(result), [file])).toThrow();
  });
  it('refuses zero-check resource success and duplicate findings', () => {
    const empty = report(); empty.results.passed_checks = []; empty.summary.passed = 0;
    expect(() => checkWorkflowCheckovResult(command(empty), [file])).toThrow(/empty/u);
    const duplicate = report(); duplicate.results.passed_checks.push(finding()); duplicate.summary.passed++;
    expect(() => checkWorkflowCheckovResult(command(duplicate), [file])).toThrow(/Duplicate/u);
  });
  it('refuses the actual summary-only empty scanner shape, despite its zero exit', () => {
    expect(() => checkWorkflowCheckovResult(command({ passed: 0, failed: 0, skipped: 0, parsing_errors: 0,
      resource_count: 0, checkov_version: '3.3.20' }), [file])).toThrow(WorkflowCheckovRefusal);
  });
  it.each([[], [file, file], ['relative.tf']])('requires a nonempty exact source inventory %j', (...selected) => {
    expect(() => checkWorkflowCheckovResult(command(report()), selected)).toThrow(WorkflowCheckovRefusal);
  });
  it('does not register a public selector or arbitrary scanner options', () => {
    for (const selector of ['checkov', 'checkov-terraform', 'checkov-terraform:opentofu-azure']) {
      expect(() => parseWorkflowContextValidatorArgs(['--validator', selector, '--source-sha', 'a'.repeat(40)])).toThrow();
    }
  });
  it.each(['/installed/bin/python', '/installed/bin/python3.14'])('reads a literal Python launcher without executing it (%s)', interpreter => {
    expect(readWorkflowCheckovPythonLauncher(`#!${interpreter}\nfrom checkov.main import Checkov\n`)).toBe(interpreter);
  });
  it('reads the actual finite long-path console-script form without invoking its shell', () => {
    const interpreter = '/owned program/bin/python';
    expect(readWorkflowCheckovPythonLauncher(`#!/bin/sh\n'''exec' '${interpreter}' "$0" "$@"\n' '''\nfrom checkov.main import Checkov\n`))
      .toBe(interpreter);
  });
  it.each(['#!/usr/bin/env python\n', '#!/bin/sh\nexec arbitrary-command\n',
    '#!/bin/python3.14 --extra\n', '#!/bin/node\n', '#!/bin/python3.15\n',
    '#!/bin/sh\n\'\'\'exec\' \'/bin/python\' "$0" "$@" ; other-command\n\' \'\'\'\n'])(
    'refuses unsupported launcher commands %j', source => {
      expect(() => readWorkflowCheckovPythonLauncher(source)).toThrow(WorkflowCheckovRefusal);
    });
  it.each(['module "remote" { source = "/outside" }', 'locals { value = file("/outside") }',
    'locals { value = templatefile("/outside", {}) }', 'locals { value = toset(["unknown evaluation"]) }',
    '# A module example in a comment is conservatively refused, not parsed away.'])(
    'refuses unproved module or expression input closure %j', source => {
      expect(() => assertWorkflowCheckovLiteralScope([source])).toThrow(WorkflowCheckovRefusal);
    });
  it('accepts literal scope without pretending to parse or qualify it', () => {
    expect(() => assertWorkflowCheckovLiteralScope(['resource "azurerm_network_security_group" "fixture" { name = "literal" }'])).not.toThrow();
    expect(() => assertWorkflowCheckovLiteralScope([])).toThrow(WorkflowCheckovRefusal);
  });
});

describe('private scanner invocation refusals do not launch a fake successful scanner', () => {
  let root: string | undefined;
  afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); if (root) await rm(root, { recursive: true }); root = undefined; });
  async function invocation(deadline: number) {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-checkov-refusal-')));
    return new WorkflowCheckovInvocation(root, root, [path.join(root, 'source.tf')], deadline);
  }
  it('refuses an expired original cutoff before any child and does not authorize replay', async () => {
    const run = vi.spyOn(NodeCommandRunner.prototype, 'run');
    const selected = await invocation(performance.now() - 1);
    await expect(selected.execute({})).rejects.toThrow(/deadline/u);
    await expect(selected.execute({})).rejects.toThrow(/single-use/u);
    expect(run).not.toHaveBeenCalled();
    expect(selected.processTreeSettled).toBe(true);
    expect(selected.processSpawned).toBe(false);
  });
  it.each(['Infinity', 'NaN', 'renewed'] as const)('refuses unbounded or renewed preparation cutoffs %s', kind => {
    const deadline = kind === 'Infinity' ? Infinity : kind === 'NaN' ? NaN : performance.now() + 3600_000;
    expect(() => new WorkflowCheckovInvocation('/unused', '/unused', [], deadline)).toThrow(/cutoff/u);
  });
  it('reports missing installed Checkov without installing, substituting or invoking a command', async () => {
    const run = vi.spyOn(NodeCommandRunner.prototype, 'run');
    vi.stubEnv('PATH', '');
    const selected = await invocation(performance.now() + 180_000);
    await expect(selected.execute({})).rejects.toThrow(/unavailable/u);
    expect(run).not.toHaveBeenCalled();
    expect(selected.validationResult).toBeNull();
    expect(selected.processTreeSettled).toBe(true);
  });
});

describe('declared Checkov import-root inventory coverage, not program or phase authority', () => {
  const standard = path.resolve('fixture-only', 'python3.14');
  const nested = path.join(standard, 'site-packages');
  it.each(['standard-first', 'import-first'] as const)('retains the declared nested import root in %s order', order => {
    const roots = order === 'standard-first' ? [standard, nested] : [nested, standard];
    expect(workflowCheckovInventoryRoots(roots)).toEqual(roots);
  });
  it('retains a declared import deeper below an otherwise skipped global site directory', () => {
    const declared = path.join(nested, 'package', 'site-packages');
    expect(workflowCheckovInventoryRoots([standard, declared])).toEqual([standard, declared]);
  });
  it('retains an explicitly declared site directory beneath another imported site directory', () => {
    const declared = path.join(nested, 'site-packages');
    expect(workflowCheckovInventoryRoots([standard, nested, declared])).toEqual([standard, nested, declared]);
  });
  it('does not repeat ordinary nested roots already covered by the parent traversal', () => {
    expect(workflowCheckovInventoryRoots([standard, path.join(standard, 'lib-dynload')])).toEqual([standard]);
    expect(workflowCheckovInventoryRoots([standard, nested, path.join(nested, 'package')])).toEqual([standard, nested]);
  });
  it('does not add an undeclared global site directory to the isolated import inventory', () => {
    expect(workflowCheckovInventoryRoots([standard])).toEqual([standard]);
  });
  it('preserves the caller root sequence without mutating or inventing roots', () => {
    const roots = Object.freeze([standard, nested, path.join(standard, 'lib-dynload')]);
    expect(workflowCheckovInventoryRoots(roots)).toEqual([standard, nested]);
    expect(roots).toEqual([standard, nested, path.join(standard, 'lib-dynload')]);
  });
});

describe('private Dockerfile Checkov protocol, not image or execution authority', () => {
  const file = path.resolve('fixture-only', 'Dockerfile');
  const finding = (line: number, result = 'PASSED') => ({
    check_id: 'CKV2_DOCKER_1', check_result: { result }, resource: `${file}.RUN`,
    file_abs_path: file, file_line_range: [line, line]
  });
  function report(failed = false) {
    return { check_type: 'dockerfile',
      results: { passed_checks: [finding(6)], failed_checks: failed ? [finding(7, 'FAILED')] : [],
        skipped_checks: [], parsing_errors: [] },
      summary: { passed: 1, failed: failed ? 1 : 0, skipped: 0, parsing_errors: 0,
        resource_count: 1, checkov_version: '3.3.20' } };
  }
  function command(value: unknown, status = 0): CommandResult {
    return { command: { executable: 'not-executed-protocol-data', args: [] }, displayCommand: 'not executed',
      status, signal: null, stdout: JSON.stringify(value), stderr: '', timedOut: false,
      processTreeSettled: true, processSpawned: true };
  }
  it.each([false, true])('requires actual Dockerfile framework and exit/finding agreement (%s)', failed => {
    expect(checkWorkflowCheckovResult(command(report(failed), failed ? 1 : 0), [file], 'dockerfile'))
      .toBe(failed ? 'failed' : 'passed');
    expect(() => checkWorkflowCheckovResult(command(report(failed), failed ? 0 : 1), [file], 'dockerfile')).toThrow();
    expect(() => checkWorkflowCheckovResult(command(report(failed)), [file])).toThrow();
  });
  it('counts checked files, not instruction findings, as Dockerfile resources', () => {
    const value = report();
    value.results.passed_checks.push(finding(7)); value.summary.passed++;
    expect(checkWorkflowCheckovResult(command(value), [file], 'dockerfile')).toBe('passed');
    expect(() => checkWorkflowCheckovResult(command(value), [file, path.resolve('different', 'Dockerfile')], 'dockerfile'))
      .toThrow(/Every selected Dockerfile/u);
    value.summary.resource_count = 2;
    expect(() => checkWorkflowCheckovResult(command(value), [file], 'dockerfile')).toThrow(/resource inventory/u);
  });
  it('refuses duplicate or contradictory findings for the same instruction and source span', () => {
    const value = report();
    value.results.passed_checks.push(finding(6)); value.summary.passed++;
    expect(() => checkWorkflowCheckovResult(command(value), [file], 'dockerfile')).toThrow(/Duplicate/u);
    const contradictory = report(true);
    contradictory.results.failed_checks[0] = finding(6, 'FAILED');
    expect(() => checkWorkflowCheckovResult(command(contradictory, 1), [file], 'dockerfile')).toThrow(/Duplicate/u);
  });
  it.each([
    { check_id: 'CKV_AZURE_10' }, { check_id: 'CKV_DOCKER_external' }, { resource: `${file}.UNKNOWN` },
    { resource: `${path.resolve('other', 'Dockerfile')}.RUN` }, { resource: `${file}.RUN.extra` },
    { file_abs_path: path.resolve('outside', 'Dockerfile') }, { file_line_range: [0, 1] }
  ])('refuses out-of-scope Dockerfile finding identity %j', patch => {
    const value = report();
    const changed = { ...value, results: { ...value.results, passed_checks: [{ ...finding(6), ...patch }] } };
    expect(() => checkWorkflowCheckovResult(command(changed), [file], 'dockerfile')).toThrow();
  });
  it.each([
    { skipped: 1 }, { parsing_errors: 1 }, { passed: 0 }, { resource_count: 0 },
    { checkov_version: '3.3.29' }
  ])('refuses empty, suppressed, malformed or unsupported Dockerfile coverage %j', patch => {
    const value = report(); Object.assign(value.summary, patch);
    expect(() => checkWorkflowCheckovResult(command(value), [file], 'dockerfile')).toThrow();
  });
  it('refuses unfinished Dockerfile processes and other framework reports', () => {
    for (const patch of [{ processTreeSettled: false }, { processSpawned: false }, { timedOut: true },
      { outputLimitExceeded: true }, { signal: 'SIGTERM' as const }, { status: 2 }]) {
      expect(() => checkWorkflowCheckovResult({ ...command(report()), ...patch }, [file], 'dockerfile')).toThrow();
    }
    expect(() => checkWorkflowCheckovResult(command({ ...report(), check_type: 'terraform' }), [file], 'dockerfile')).toThrow();
  });
  it('does not open a public selector, arbitrary framework or image option', () => {
    for (const selector of ['checkov-dockerfile', 'checkov-dockerfile:backend', 'sca_image']) {
      expect(() => parseWorkflowContextValidatorArgs(['--validator', selector, '--source-sha', 'a'.repeat(40)])).toThrow();
    }
    expect(() => Reflect.apply(checkWorkflowCheckovResult, undefined, [command(report()), [file], 'all'])).toThrow();
    expect(() => Reflect.construct(WorkflowCheckovInvocation,
      ['/unused', '/unused', [file], performance.now() + 180_000, 'sca_image'])).toThrow();
  });
  it.each(['terraform', 'dockerfile'] as const)('refuses a mismatched file kind before any %s child', async framework => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'liftoff-checkov-file-kind-')));
    const run = vi.spyOn(NodeCommandRunner.prototype, 'run');
    try {
      const selected = new WorkflowCheckovInvocation(root, root,
        [path.join(root, framework === 'dockerfile' ? 'source.tf' : 'Dockerfile')], performance.now() + 180_000, framework);
      await expect(selected.execute({})).rejects.toThrow(/finite scanner framework/u);
      expect(run).not.toHaveBeenCalled();
      expect(selected.processSpawned).toBe(false);
    } finally {
      run.mockRestore();
      await rm(root, { recursive: true });
    }
  });
});
