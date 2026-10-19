import { describe, expect, it } from 'vitest';
import { assertNativeTestReport } from '../distribution/native/native-bundle-contract.mjs';

function report() {
  return {
    success: true, numTotalTests: 6, numPassedTests: 3, numFailedTests: 0,
    numPendingTests: 2, numTodoTests: 1, numFailedTestSuites: 0,
    numTotalTestSuites: 12, numPassedTestSuites: 12,
    testResults: [
      { name: 'C:\\fixture\\tests\\first.test.ts', status: 'passed', assertionResults: [
        { title: 'first', status: 'passed' }, { title: 'second', status: 'passed' },
        { title: 'foreign host', status: 'skipped' }, { title: 'pending', status: 'pending' },
        { title: 'future', status: 'todo' }
      ] },
      { name: 'C:\\fixture\\tests\\second.test.ts', status: 'passed',
        assertionResults: [{ title: 'ancillary', status: 'passed' }] }
    ]
  };
}

describe('native report assertion and summary consistency', () => {
  it('accepts consistent combined reports without normalizing nested suite totals or unrun statuses', () => {
    const selected = report(), before = structuredClone(selected);
    expect(() => assertNativeTestReport(selected)).not.toThrow();
    expect(selected).toEqual(before);
  });

  it.each(['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests'] as const)(
    'rejects a dishonest or invalid %s count', key => {
      for (const value of [undefined, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, report()[key] + 1]) {
        const selected = { ...report(), [key]: value };
        expect(() => assertNativeTestReport(selected)).toThrow();
      }
    });

  it.each(['failed', 'skipped', 'pending', 'todo', 'unknown', ''])(
    'rejects an ancillary file reported as %j despite green aggregate fields', status => {
      const selected = report();
      selected.testResults[1].status = status;
      expect(() => assertNativeTestReport(selected)).toThrow('test file');
    });

  it('rejects a failed ancillary assertion even when its file and summary claim success', () => {
    const selected = report();
    selected.testResults[1].assertionResults[0].status = 'failed';
    expect(() => assertNativeTestReport(selected)).toThrow('failed assertions');
  });

  it('rejects unknown assertion statuses instead of treating them as passed or unrun', () => {
    const selected = report();
    selected.testResults[1].assertionResults[0].status = 'not-executed';
    expect(() => assertNativeTestReport(selected)).toThrow('assertion status');
  });

  it('rejects duplicate file records across native path separators', () => {
    const selected = report();
    selected.testResults[1].name = 'C:/fixture/tests/first.test.ts';
    expect(() => assertNativeTestReport(selected)).toThrow('duplicate test file');
  });

  it.each([null, [], {}, { success: true, numFailedTests: 0, numFailedTestSuites: 0, testResults: [] }])(
    'rejects an absent or empty report: %j', value => {
      expect(() => assertNativeTestReport(value)).toThrow();
    });

  it('rejects malformed file names and absent assertion arrays', () => {
    for (const field of ['name', 'assertionResults']) {
      const selected = report();
      Reflect.deleteProperty(selected.testResults[1], field);
      expect(() => assertNativeTestReport(selected)).toThrow();
    }
  });

  it('rejects a fully unrun report even with matching zero-passed counts', () => {
    const selected = report();
    for (const file of selected.testResults) for (const test of file.assertionResults) test.status = 'skipped';
    selected.numPassedTests = 0;
    selected.numPendingTests = 6;
    selected.numTodoTests = 0;
    expect(() => assertNativeTestReport(selected)).toThrow('no passing tests');
  });
});
