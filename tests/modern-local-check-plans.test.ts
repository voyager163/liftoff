import { describe, expect, it, vi } from 'vitest';
import { assembleModernLocalPlan, copyModernLocalData, localPath, modernLocalBounds } from '../src/domain/governance/activation/modern-local-inputs.js';
import { hclComputationPolicy } from '../src/adapters/hcl/parser-child.js';
import {
  appendSpecKitDocumentIssues, appendSpecKitTaskIssues, appendSpecKitDefaultIssues, appendSpecKitSelectedIssues,
  isSpecKitIntegrationRecord, isSpecKitInstalledList, isOpenSpecCodexTarget,
  extractDeclaredCapabilities, mainSpecPurpose, specKitBootstrapTaskIds,
  pythonBackendCommand, workerTestCommand, tofuInitCommand
} from '../src/domain/governance/activation/local-check-values.js';

describe('bounded synchronous own-data intake', () => {
  it('binds actual complete resource policy values, not only a recipe version label', () => {
    const inspection = { status: 'blocked' as const, blockers: ['No fabricated runtime authority.'] };
    const actual = assembleModernLocalPlan(inspection, null, [], [], null, hclComputationPolicy);
    for (const field of ['wasmPages', 'batchDocuments', 'batchTargetBytes', 'derivationReplyBytes', 'expressionRequests'] as const) {
      const changed = { ...hclComputationPolicy, [field]: hclComputationPolicy[field] + 1 };
      expect(assembleModernLocalPlan(inspection, null, [], [], null, changed).recipeSet.digest).not.toBe(actual.recipeSet.digest);
    }
    const changedRuntime = { ...hclComputationPolicy, qualifiedRuntime: { ...hclComputationPolicy.qualifiedRuntime, arch: 'x64' } };
    expect(assembleModernLocalPlan(inspection, null, [], [], null, changedRuntime).recipeSet.digest).not.toBe(actual.recipeSet.digest);
    expect(actual.execution).toBe('not-authorized');
  });
  it('never evaluates initial getters or proxy traps', () => {
    const getter = vi.fn(), value = Object.defineProperty({}, 'snapshot', { enumerable: true, get: getter });
    expect(() => copyModernLocalData(value)).toThrow(/accessors/);
    const trap = vi.fn(), proxy = new Proxy({}, { ownKeys: trap });
    expect(() => copyModernLocalData(proxy)).toThrow(/proxies/);
    expect(getter).not.toHaveBeenCalled(); expect(trap).not.toHaveBeenCalled();
  });
  it.each([new Array(2), Object.assign([], { extra: true }), Buffer.from('bytes'), { callback() {} }])('rejects non-data input %#', value => {
    expect(() => copyModernLocalData(value)).toThrow();
  });
  it('makes independent nested arrays rather than freezing caller-owned memory', () => {
    const input = { paths: [['actual', 'source']], records: [{ bytes: 'YQ==' }] }, copied = copyModernLocalData(input);
    input.paths[0][0] = 'changed'; input.records[0].bytes = '';
    expect(copied).toEqual({ paths: [['actual', 'source']], records: [{ bytes: 'YQ==' }] });
  });
  it.each([0, 1])('checks actual path depth inclusive plus %i', excess => {
    const parts = Array.from({ length: modernLocalBounds.depth + excess }, () => 'part');
    if (excess) expect(() => localPath(parts)).toThrow(/depth/);
    else expect(localPath(parts)).toEqual(parts);
  });
  it.each([0, 1])('checks the1024-byte portable path contract plus %i', excess => {
    const parts = ['backend', 'a'.repeat(255), 'b'.repeat(255), 'c'.repeat(255), 'd'.repeat(248 + excess)];
    expect(Buffer.byteLength(parts.join('/'))).toBe(1024 + excess);
    if (excess) expect(() => localPath(parts)).toThrow(/byte/);
    else expect(localPath(parts)).toEqual(parts);
  });
  it.each([0, 1])('checks the200000-value-node copy bound plus %i', excess => {
    const value = Array.from({ length: modernLocalBounds.dataNodes - 1 + excess }, () => 0);
    if (excess) expect(() => copyModernLocalData(value)).toThrow(/bound/);
    else expect(copyModernLocalData(value)).toEqual(value);
  });
  it.each([0, 1])('checks the24-level copy bound plus %i', excess => {
    let value: unknown = 0;
    for (let index = 0; index < modernLocalBounds.dataDepth + excess; index += 1) value = { nested: value };
    if (excess) expect(() => copyModernLocalData(value)).toThrow(/structural/);
    else expect(copyModernLocalData(value)).toEqual(value);
  });
});

describe('exact extracted source-content predicates', () => {
  it('retains duplicate/CRLF capability and Purpose semantics', () => {
    expect(extractDeclaredCapabilities('### New Capabilities\r\n- `one`: one\r\n- `one`: repeated\r\n### Modified Capabilities\r\n- `two`: no\r\n')).toEqual(['one', 'one']);
    expect(mainSpecPurpose('## Purpose\r\n\r\n Actual purpose. \r\n\r\n## Requirements\r\n')).toBe('Actual purpose.');
    expect(mainSpecPurpose('## Purpose\n\n## Requirements\n')).toBeNull();
    expect(mainSpecPurpose('## Purpose\n\nNo following section.')).toBeNull();
  });
  it.each(specKitBootstrapTaskIds)('retains missing/duplicate %s diagnostics', id => {
    const correct = specKitBootstrapTaskIds.map(task => `- [ ] ${task} Observe source.\n`).join('');
    const valid: string[] = []; appendSpecKitTaskIssues(correct, valid); expect(valid).toEqual([]);
    const missing: string[] = []; appendSpecKitTaskIssues(correct.replace(new RegExp(`^- \\[ \\] ${id} .*\\n`, 'm'), ''), missing);
    expect(missing).toEqual([`Bootstrap task ${id} must occur exactly once.`]);
    const duplicate: string[] = []; appendSpecKitTaskIssues(correct + `- [x] ${id} Again.\n`, duplicate);
    expect(duplicate).toEqual([`Bootstrap task ${id} must occur exactly once.`]);
  });
  it('uses the already-captured diagnostic path and preserves issue order', () => {
    const parts = ['actual', 'spec.md'], issues: string[] = [];
    appendSpecKitDocumentIssues('spec', '', parts, issues);
    expect(issues).toEqual([
      'actual/spec.md must declare the real 000-liftoff-bootstrap bootstrap identity, not a framework template.',
      'Bootstrap spec requires explicit requirements.'
    ]);
  });
  it.each([null, [], 'state', 1])('rejects a non-object parsed integration %#', value => expect(isSpecKitIntegrationRecord(value)).toBe(false));
  it('preserves staged default/list/selection diagnostics without needing a catalog callback', () => {
    const state = { default_integration: 'wrong', integration: 'another', installed_integrations: ['claude'] };
    const issues: string[] = [];
    expect(isSpecKitIntegrationRecord(state)).toBe(true);
    appendSpecKitDefaultIssues(state, 'copilot', issues);
    expect(isSpecKitInstalledList(state.installed_integrations)).toBe(true);
    appendSpecKitSelectedIssues(state.installed_integrations, ['copilot', 'codex'], issues);
    expect(issues).toEqual([
      'Spec Kit integration and default_integration disagree.',
      'Spec Kit default integration is "wrong"; expected "copilot".',
      'Spec Kit integration state does not include selected integration copilot.',
      'Spec Kit integration state does not include selected integration codex.'
    ]);
    expect(isSpecKitInstalledList(['copilot', false])).toBe(false);
    expect(isSpecKitInstalledList(undefined)).toBe(false);
  });
  it.each([[' codex\r\n', true], ['', false], ['Codex', false], ['claude', false]] as const)('keeps exact Codex text %j', (value, expected) => {
    expect(isOpenSpecCodexTarget(value)).toBe(expected);
  });
  it('returns independent literal command values with actual custom arguments', () => {
    expect(pythonBackendCommand('Custom/API', 'Custom/API/tests').args).toEqual(['run', '--project', 'Custom/API', 'python', '-m', 'pytest', '-q', 'Custom/API/tests']);
    expect(workerTestCommand('../../Custom/API').args).toEqual(['run', '--project', '../../Custom/API', '--directory', '.', 'python', '-m', 'pytest', '-q']);
    const command = tofuInitCommand(); command.args.push('changed');
    expect(tofuInitCommand().args).toEqual(['init', '-backend=false']);
  });
});
