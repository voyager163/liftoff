import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { templateDependencyInventory } from '../template-dependency-security.mjs';
import { dependencyInventory } from './inventory.ts';
import { fixtureGitEnvironment, fixtureGitOptions } from './gitleaks.ts';
import { evaluateSecurityReport, parseIdentity, portableParts, SecurityEvidenceError, type EvidenceIdentity } from './evidence.ts';
import { osvDigest, osvRelease, osvUnscoredPolicyRules, runOsvBoundary } from './osv.ts';
import { createOsvWorkspace, qualifyFrozenGo, qualifyOsvFixtures, type RepositoryOsvAssessment } from './osv-fixture.ts';
import { reportRepositorySecurity, type RepositorySecuritySummary, type ReportingProducerOutcome } from './reporting.ts';
import { securityWorkflowInvocation } from './workflow-invocation.ts';

function fail(code: string): never { throw new SecurityEvidenceError(code); }

export async function readOsvSource(root: string, parts: readonly string[]): Promise<string> {
  const target = path.join(root, ...portableParts([...parts]));
  if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK) fail('osv-source-filesystem-unqualified');
  let file;
  try {
    file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await file.stat({ bigint: true }), named = await lstat(target, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 16_777_216n ||
        named.isSymbolicLink() || named.ino !== before.ino || named.dev !== before.dev ||
        await realpath(target) !== target) fail('osv-source-file-identity');
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    try {
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await file.stat({ bigint: true }), current = await lstat(target, { bigint: true });
      if (BigInt(length) !== before.size || after.size !== before.size || after.mtimeNs !== before.mtimeNs ||
          after.ctimeNs !== before.ctimeNs || current.ino !== before.ino || current.dev !== before.dev ||
          current.isSymbolicLink() || await realpath(target) !== target) fail('osv-source-file-changed');
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    } finally { buffer.fill(0); }
  } catch (error) {
    if (error instanceof SecurityEvidenceError) throw error;
    return fail('osv-source-file-unreadable');
  } finally { await file?.close(); }
}

interface LocalOsvReport {
  schemaVersion: 1;
  kind: 'local-non-npm-assessment';
  identity: EvidenceIdentity;
  provenance: 'working-tree-input-digests-with-HEAD-anchor';
  inputs: { pathParts: string[]; digest: string }[];
  assessments: RepositoryOsvAssessment[];
  analysisComplete: boolean;
  findingsPassed: boolean | null;
  missingGraphs: string[];
  errors: string[];
  policy: 'strict-no-exceptions-not-adopted-policy-authorization';
  hostedQualification: false;
  publicationQualified: false;
  componentCoverage?: { python: object[]; go: object[] };
  workflowInvocation?: ReturnType<typeof securityWorkflowInvocation>;
  reporting: RepositorySecuritySummary | null;
  ownerActions: { owner: 'voyager163'; graph: string; action: 'rerun-complete-graph' | 'triage-blocking-findings' | 'triage-lower-findings' }[];
}

export function summarizeRepositoryOsv(
  identity: EvidenceIdentity, inputs: LocalOsvReport['inputs'], assessments: RepositoryOsvAssessment[],
  errors: string[] = [], now = new Date()
): LocalOsvReport {
  const expected = ['standard-backend', 'genai-backend', 'function-worker', 'go-backend'];
  const ids = assessments.map(item => item.graph);
  const verdicts = new Map<string, ReturnType<typeof evaluateSecurityReport>>();
  if (new Set(ids).size !== ids.length || ids.some(id => !expected.includes(id))) fail('osv-driver-graph-inventory');
  for (const assessment of assessments) {
    if (!Number.isSafeInteger(assessment.components) || assessment.components < 1) fail('osv-driver-graph-inventory');
    if (assessment.status !== 'complete') {
      if (assessment.status !== 'error' || assessment.passed !== false) fail('osv-driver-assessment-status');
      continue;
    }
    const report = assessment.report;
    const verdict = evaluateSecurityReport(report, {
      identity, role: 'non-npm-dependencies', tool: report.tool,
      units: [{ id: assessment.graph, inputDigest: assessment.inputDigest, count: assessment.components, platform: 'all' }]
    }, { blockingRules: osvUnscoredPolicyRules, exceptions: [] }, now);
    if (report.tool.name !== 'osv-scanner' || report.tool.version !== osvRelease.version ||
        verdict.passed !== assessment.passed || verdict.blocking.length !== assessment.blocking ||
        verdict.tracked.length !== assessment.tracked) fail('osv-driver-assessment-status');
    verdicts.set(assessment.graph, verdict);
  }
  const missingGraphs = expected.filter(id => !ids.includes(id));
  const analysisComplete = missingGraphs.length === 0 && errors.length === 0 &&
    assessments.every(item => item.status === 'complete');
  const completed = assessments.filter((item): item is Extract<RepositoryOsvAssessment, { status: 'complete' }> =>
    item.status === 'complete');
  const ownerActions = expected.flatMap<LocalOsvReport['ownerActions'][number]>(graph => {
    const assessment = assessments.find(item => item.graph === graph), verdict = verdicts.get(graph);
    if (!assessment || assessment.status !== 'complete' || errors.length) return [{ owner: 'voyager163', graph, action: 'rerun-complete-graph' }];
    return [
      ...(verdict!.blocking.length ? [{ owner: 'voyager163' as const, graph, action: 'triage-blocking-findings' as const }] : []),
      ...(verdict!.tracked.length ? [{ owner: 'voyager163' as const, graph, action: 'triage-lower-findings' as const }] : [])
    ];
  });
  const reporting = analysisComplete ? reportRepositorySecurity({
    identity, blockingRules: osvUnscoredPolicyRules, controls: [],
    producers: completed.map(item => ({
      id: item.graph, owner: 'voyager163', policy: 'repository-findings',
      identity, role: 'non-npm-dependencies', tool: item.report.tool,
      units: [{ id: item.graph, inputDigest: item.inputDigest, count: item.components, platform: 'all' }],
      previousFindingDigests: null
    }))
  }, {
    producers: completed.map((item): ReportingProducerOutcome => {
      const verdict = verdicts.get(item.graph)!;
      return { id: item.graph, analysis: 'complete', report: item.report,
        assessment: { status: verdict.passed ? 'passed' : 'blocked', blocking: verdict.blocking, reviewed: verdict.reviewed,
          tracked: verdict.tracked.map(id => ({ id, owner: 'voyager163' })) } };
    }),
    capabilities: [], admission: null
  }, now).summary : null;
  return {
    schemaVersion: 1, kind: 'local-non-npm-assessment', identity: parseIdentity(identity),
    provenance: 'working-tree-input-digests-with-HEAD-anchor', inputs, assessments,
    analysisComplete, findingsPassed: analysisComplete ? assessments.every(item => item.passed) : null,
    missingGraphs, errors, policy: 'strict-no-exceptions-not-adopted-policy-authorization',
    hostedQualification: false, publicationQualified: false, reporting, ownerActions
  };
}

export async function executeRepositoryOsv(options: {
  repository: string; python: string; go: string; workspaceParent: string; restorePublicGo: boolean;
  workflowEnvironment?: NodeJS.ProcessEnv;
}): Promise<LocalOsvReport> {
  const root = await realpath(options.repository);
  if (root !== await realpath(process.cwd())) fail('osv-driver-source-root');
  const baselineParts = ['assets', 'supported-stack.json'], contractParts = ['security', 'go-tool-graphs.json'];
  const baselineSource = await readOsvSource(root, baselineParts);
  const inventory = dependencyInventory(JSON.parse(baselineSource), templateDependencyInventory);
  const go = inventory.find(item => item.ecosystem === 'go');
  if (!go) fail('osv-driver-go-inventory');
  const paths = [
    baselineParts, contractParts,
  ['security', 'finding-policy.json'], ['security', 'unscored-advisory-decision.json'],
    ...inventory.filter(item => item.ecosystem === 'pypi' || item.ecosystem === 'go').map(item => item.pathParts),
    [...go.pathParts.slice(0, -1), 'go.sum'],
    ['assets', 'locks', 'python-genai', 'function-requirements.txt']
  ];
  const snapshot = new Map<string, { pathParts: string[]; contents: string; digest: string }>();
  for (const parts of paths) {
    const key = parts.join('/');
    if (snapshot.has(key)) continue;
    const contents = await readOsvSource(root, parts);
    snapshot.set(key, { pathParts: [...parts], contents, digest: osvDigest(contents) });
  }
  if (snapshot.get(baselineParts.join('/'))?.contents !== baselineSource) fail('osv-driver-input-drift');
  const owned = await createOsvWorkspace(root, options.workspaceParent);
  try {
    const env = fixtureGitEnvironment(owned.root, path.join(owned.root, 'bin'));
    const git = (args: string[]) => runOsvBoundary({
      executable: '/usr/bin/git', args: [...fixtureGitOptions(owned.root), '-C', root, ...args],
      cwd: owned.root, env, project: source => source.trim(), timeoutMs: 15_000
    });
    if (await git(['rev-parse', '--show-toplevel']) !== root) fail('osv-driver-source-root');
    const head = await git(['rev-parse', '--verify', 'HEAD^{commit}']);
    const environment = options.workflowEnvironment;
    const selected = environment?.GITHUB_EVENT_NAME === 'schedule' ? environment.LIFTOFF_SCAN_REF : undefined;
    if (selected !== undefined && !['develop', 'main'].includes(selected)) fail('osv-driver-scheduled-ref');
    const invocation = environment ? securityWorkflowInvocation(environment, {
      checkoutSha: head,
      ...(environment.GITHUB_EVENT_NAME === 'pull_request'
        ? { mergeParents: (await git(['show', '--no-patch', '--format=%P', 'HEAD'])).split(' ') } : {}),
      ...(selected ? { selectedRef: {
        ref: `refs/heads/${selected}`, sha: await git(['rev-parse', '--verify', `refs/remotes/origin/${selected}^{commit}`])
      } } : {})
    }) : undefined;
    const implementation = [];
    for (const name of ['osv-driver.ts', 'osv-fixture.ts', 'osv.ts', 'osv-transport.ts', 'osv-linux-sandbox.py', 'osv-go-contract.ts', 'osv-advisory.ts', 'reporting.ts', 'workflow-invocation.ts']) {
      const parts = ['scripts', 'repository-security', name], contents = await readOsvSource(root, parts);
      snapshot.set(parts.join('/'), { pathParts: parts, contents, digest: osvDigest(contents) });
      implementation.push([name, osvDigest(contents)]);
    }
    const inputs = [...snapshot.values()].map(({ pathParts, digest }) => ({ pathParts, digest }));
    const identity = parseIdentity({
      repository: 'voyager163/liftoff', event: invocation?.event ?? 'workflow_dispatch', sourceSha: head,
      baseSha: invocation?.baseSha ?? head, workflowSha: invocation?.workflowSha ?? head,
      runId: invocation?.runId ?? String(Date.now()), attempt: invocation?.attempt ?? 1,
      policyDigest: osvDigest('strict-local-no-exceptions-not-adoption'),
      inventoryDigest: osvDigest(JSON.stringify(inputs)),
      configurationDigest: osvDigest(JSON.stringify({ implementation, tool: osvRelease, transport: 'coordinate-only-plus-offline-network-denial' }))
    });
    for (const item of snapshot.values()) await owned.write(['source', ...item.pathParts], item.contents);
    const frozenSource = path.join(owned.root, 'source');
    const reports: RepositoryOsvAssessment[] = [], errors: string[] = [];
    const python = await qualifyOsvFixtures(frozenSource, {
      python: options.python, workspaceParent: options.workspaceParent, extractRepositoryLocks: true,
      queryPublicFixtures: false, assessment: { identity }
    });
    reports.push(...python.assessments);
    const resolved = await qualifyFrozenGo(frozenSource, {
      go: options.go, restore: options.restorePublicGo, workspaceParent: options.workspaceParent,
      assessment: { python: options.python, identity }
    });
    reports.push(...resolved.extraction.assessments);
    if (await git(['rev-parse', '--verify', 'HEAD^{commit}']) !== head) fail('osv-driver-input-drift');
    for (const item of snapshot.values()) {
      await owned.verify(['source', ...item.pathParts], item.contents);
      if (await readOsvSource(root, item.pathParts) !== item.contents) fail('osv-driver-input-drift');
    }
    return { ...summarizeRepositoryOsv(identity, inputs, reports, errors),
      ...(invocation ? { workflowInvocation: invocation } : {}),
      componentCoverage: { python: python.extraction, go: resolved.extraction.scopes } };
  } finally { await owned.cleanup(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (![6, 7].includes(args.length) || args[0] !== '--python' || args[2] !== '--go' ||
        args[4] !== '--workspace-parent' || args.length === 7 && args[6] !== '--restore-public-go') fail('osv-driver-usage');
    const result = await executeRepositoryOsv({
      repository: process.cwd(), python: path.resolve(args[1]!), go: path.resolve(args[3]!),
      workspaceParent: path.resolve(args[5]!), restorePublicGo: args.length === 7,
      ...(process.env.GITHUB_ACTIONS === 'true' ? { workflowEnvironment: process.env } : {})
    });
    console.log(JSON.stringify(result));
    process.exitCode = result.analysisComplete ? result.findingsPassed ? 0 : 1 : 2;
  } catch (error) {
    const code = error instanceof SecurityEvidenceError ? error.code : 'osv-driver-failed';
    console.error(JSON.stringify({ kind: 'local-non-npm-assessment', analysisComplete: false, findingsPassed: null, code }));
    process.exitCode = 2;
  }
}
