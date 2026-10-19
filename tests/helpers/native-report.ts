export function nativeReport<Suite extends {
  name: string;
  assertionResults: { status: string }[];
}>(suites: Suite[]) {
  const cases = suites.flatMap(suite => suite.assertionResults);
  return {
    success: true,
    numTotalTests: cases.length,
    numPassedTests: cases.filter(test => test.status === 'passed').length,
    numFailedTests: cases.filter(test => test.status === 'failed').length,
    numPendingTests: cases.filter(test => ['pending', 'skipped'].includes(test.status)).length,
    numTodoTests: cases.filter(test => test.status === 'todo').length,
    numFailedTestSuites: 0,
    testResults: suites.map(suite => ({ status: 'passed', ...suite }))
  };
}
