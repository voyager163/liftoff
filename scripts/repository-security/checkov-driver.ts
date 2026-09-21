import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessCheckovScope, checkovCustomPolicyFiles, CheckovFixtureError, type CheckovInputScope } from './checkov.ts';
import {
  committedIacRoots, generatedInputInventory, generatedSecurityCases,
  type GeneratedArtifactInput
} from './inventory.ts';
import { fixtureGitEnvironment, fixtureGitOptions } from './gitleaks.ts';
import { readOsvSource } from './osv-driver.ts';
import { createOsvWorkspace } from './osv-fixture.ts';
import { osvDigest, runOsvBoundary } from './osv.ts';
import { portableParts, SecurityEvidenceError } from './evidence.ts';
import { previewCheckovRoleDiagnostics } from './checkov-role-policy.ts';
import { summarizeCheckovGate, type CheckovGateOutcome } from './artifact-gates.ts';

export interface CheckovCase {
  id: string;
  scope: CheckovInputScope;
}
export interface CheckovPlan {
  cases: CheckovCase[];
  unsupported: { pathParts: string[]; reason: string }[];
}
function fail(code: string): never { throw new SecurityEvidenceError(`checkov-${code}`); }
export const bootstrapRepresentativeVariables = [
  'subscription_id = "00000000-0000-4000-8000-000000000000"',
  'location = "westeurope"', 'resource_suffix = "scanonly"',
  'operator_cidrs = ["192.0.2.1/32"]', ''
].join('\n');

export function checkovAssessmentExitCode(result: {
  selectedAnalysisComplete: boolean; findingGate: { analysisComplete: boolean; gate: 'passed' | 'blocked' | 'incomplete' };
}): 0 | 1 | 2 {
  if (result.selectedAnalysisComplete !== result.findingGate.analysisComplete) fail('incoherent-gate');
  if (!result.selectedAnalysisComplete || result.findingGate.gate === 'incomplete') return 2;
  return result.findingGate.gate === 'passed' ? 0 : 1;
}

export function composeImageInventory(baseline: unknown): string[] {
  if (!baseline || typeof baseline !== 'object' || !('containers' in baseline) ||
      !baseline.containers || typeof baseline.containers !== 'object' || Array.isArray(baseline.containers)) fail('invalid-image-inventory');
  const images = Object.values(baseline.containers).map(value => {
    if (!value || typeof value !== 'object' || !('image' in value) || !('tag' in value) || !('digest' in value) ||
        typeof value.image !== 'string' || !/^[a-z0-9][a-z0-9./_-]+$/.test(value.image) ||
        typeof value.tag !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.tag) || value.tag === 'latest' ||
        typeof value.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.digest)) fail('invalid-image-inventory');
    return `${value.image}:${value.tag}@${value.digest}`;
  });
  if (!images.length || images.length > 100) fail('invalid-image-inventory');
  return [...new Set(images)].sort();
}

export function committedCheckovPlan(files: readonly { pathParts: string[]; content: string }[]): CheckovPlan {
  const cases: CheckovCase[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const key = portableParts(file.pathParts).join('/');
    if (seen.has(key.toLowerCase())) fail('duplicate-input');
    seen.add(key.toLowerCase());
    if (!committedIacRoots.some(root => key.startsWith(`${root.join('/')}/`) && key.endsWith('.tf')) &&
        key !== 'services/telemetry-ingest/Dockerfile') fail('unregistered-source-input');
  }
  for (const root of committedIacRoots) {
    const selected = files.filter(file => file.pathParts.slice(0, -1).join('/') === root.join('/'));
    if (!selected.length || !selected.some(file => file.pathParts.at(-1) === 'versions.tf')) fail('missing-source-iac');
    cases.push({ id: `source/${root.join('/')}`, scope: {
      framework: 'terraform', files: structuredClone(selected),
      ...(root.join('/') === 'infrastructure/opentofu/bootstrap' ? {
        terraformContext: {
          rootDirectory: [...root], moduleDirectories: [], variableFiles: [{
            pathParts: [...root, 'liftoff-security.tfvars'],
            content: bootstrapRepresentativeVariables
          }]
        }
      } : {})
    } });
  }
  const docker = files.filter(file => file.pathParts.join('/') === 'services/telemetry-ingest/Dockerfile');
  if (docker.length !== 1) fail('missing-telemetry-build');
  cases.push({ id: 'source/telemetry-dockerfile', scope: { framework: 'dockerfile', files: structuredClone(docker) } });
  if (cases.flatMap(item => item.scope.files).length !== files.length) fail('unmapped-source-input');
  return { cases, unsupported: [] };
}

export function generatedCheckovPlan(caseId: string, artifacts: readonly GeneratedArtifactInput[], approvedImages: readonly string[] = []): CheckovPlan {
  const entry = generatedSecurityCases.find(item => item.id === caseId);
  if (!entry) fail('unknown-generated-case');
  const inventory = generatedInputInventory(entry, artifacts);
  const cases: CheckovCase[] = [], unsupported: CheckovPlan['unsupported'] = [];
  const groups = new Map<string, CheckovInputScope['files']>();
  const variables = new Map<string, { pathParts: string[]; content: string }>();
  for (const input of inventory) {
    if (!['iac', 'docker'].includes(input.kind)) continue;
    const artifact = artifacts.find(item => item.logicalName === input.logicalName)!;
    const supportingOnly = entry.options.environments.some(environment =>
      input.logicalName === `opentofu-${environment}-remote-state-example`);
    const file = {
      pathParts: [...input.pathParts], content: artifact.content,
      ...(supportingOnly ? { supportingOnly: true as const } : {})
    };
    if (input.pathParts.at(-1) === 'Dockerfile') {
      cases.push({ id: `generated/${caseId}/${input.logicalName}`, scope: { framework: 'dockerfile', files: [file] } });
    } else if (input.logicalName === 'docker-compose' && input.pathParts.join('/') === 'docker-compose.yml') {
      if (!approvedImages.length) fail('missing-compose-image-inventory');
      const localBuilds: [string, string][] = inventory.filter(item => item.pathParts.at(-1) === 'Dockerfile').map(item =>
        [item.pathParts.slice(0, -1).join('/') || '.', 'Dockerfile']);
      cases.push({ id: `generated/${caseId}/compose`, scope: {
        framework: 'yaml', files: [file], compose: { images: [...approvedImages], localBuilds }
      } });
    } else if (input.pathParts.at(-1)!.endsWith('.tf')) {
      const parent = input.pathParts.slice(0, -1).join('/');
      groups.set(parent, [...groups.get(parent) ?? [], file]);
    } else if (input.pathParts.at(-1)!.endsWith('.tfvars')) {
      const environment = entry.options.environments.find(environment => input.logicalName === `opentofu-${environment}-tfvars`);
      if (!environment || variables.has(environment)) fail('unmapped-generated-variables');
      variables.set(environment, file);
    } else {
      unsupported.push({
        pathParts: [caseId, ...input.pathParts],
        reason: 'compose-configuration-not-supported-by-selected-native-frameworks'
      });
    }
  }
  const moduleDirectory = ['infrastructure', 'opentofu', 'azure', 'modules', 'application'];
  const moduleFiles = groups.get(moduleDirectory.join('/'));
  if (!moduleFiles?.length || groups.size !== entry.options.environments.length + 1 ||
      variables.size !== entry.options.environments.length) fail('incomplete-local-module-closure');
  for (const environment of entry.options.environments) {
    const rootDirectory = ['infrastructure', 'opentofu', 'azure', 'environments', environment];
    const files = groups.get(rootDirectory.join('/')), variableFile = variables.get(environment);
    if (!files?.length || !variableFile) fail('incomplete-local-module-closure');
    cases.push({
      id: `generated/${caseId}/${rootDirectory.join('/')}`,
      scope: {
        framework: 'terraform', files: [...files, ...moduleFiles],
        terraformContext: {
          rootDirectory, moduleDirectories: [moduleDirectory],
          variableFiles: [variableFile, {
            pathParts: [...rootDirectory, 'liftoff-security.tfvars'],
            content: 'postgres_admin_password = "NONFUNCTIONAL_SCANNER_FIXTURE_NOT_A_CREDENTIAL"\n'
          }]
        }
      }
    });
  }
  if (!cases.some(item => item.scope.framework === 'terraform') ||
      !cases.some(item => item.scope.framework === 'dockerfile')) fail('missing-generated-framework');
  return { cases, unsupported };
}

export async function executeCheckovAssessment(options: {
  executable: string; workspaceParent: string; generatedCase?: string; onlyFramework?: 'yaml';
}) {
  const root = await realpath(process.cwd()), workspace = await createOsvWorkspace(root, options.workspaceParent);
  try {
    const env = fixtureGitEnvironment(workspace.root, path.join(workspace.root, 'bin'));
    const git = (args: string[]) => runOsvBoundary({
      executable: '/usr/bin/git', args: [...fixtureGitOptions(workspace.root), '-C', root, ...args],
      cwd: workspace.root, env, timeoutMs: 15_000, project: source => source
    });
    const head = (await git(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    const inputs = new Map<string, { pathParts: string[]; content: string }>();
    const capture = async (parts: string[]) => {
      const content = await readOsvSource(root, parts), input = { pathParts: parts, content };
      inputs.set(parts.join('/'), input);
      return input;
    };
    for (const name of ['checkov.ts', 'checkov-driver.ts', 'checkov-role-policy.ts', 'generated-role-policy.ts', 'artifact-gates.ts',
      'finding-policy.ts', 'evidence.ts', 'admission.ts', 'inventory.ts', 'gitleaks.ts', 'osv-driver.ts']) {
      await capture(['scripts', 'repository-security', name]);
    }
    await capture(['security', 'telemetry-feature-diagnostic-decision.json']);
    await capture(['security', 'generated-role-diagnostic-decision.json']);
    const names = () => git([
      'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--',
      ...committedIacRoots.map(parts => parts.join('/')), 'services/telemetry-ingest/Dockerfile'
    ]);
    const originalNames = await names();
    const selected = originalNames.split('\0').filter(name => name.endsWith('.tf') || name === 'services/telemetry-ingest/Dockerfile');
    if (new Set(selected).size !== selected.length) fail('duplicate-source-selection');
    const sourceFiles = await Promise.all(selected.map(name => capture(portableParts(name.split('/')))));
    let plan = committedCheckovPlan(sourceFiles);
    if (options.generatedCase) {
      const entry = generatedSecurityCases.find(item => item.id === options.generatedCase);
      if (!entry) fail('unknown-generated-case');
      const { buildProjectPlan } = await import('../../dist/planner.js');
      const { buildArtifacts } = await import('../../dist/templates.js');
      const baseline = await capture(['assets', 'supported-stack.json']);
      plan = generatedCheckovPlan(entry.id, buildArtifacts(buildProjectPlan(entry.options, { requireProjectName: true })),
        composeImageInventory(JSON.parse(baseline.content)));
    }
    const customPolicies = await Promise.all(checkovCustomPolicyFiles.map(async policy => ({
      ...policy, content: (await capture(['security', 'checkov', policy.filename])).content
    })));
    const findingPolicySource = await capture(['security', 'finding-policy.json']);
    for (const item of plan.cases) {
      if (item.scope.framework === 'terraform') {
        item.scope.customPolicies = customPolicies.filter(policy =>
          !policy.bootstrapOnly || item.id === 'source/infrastructure/opentofu/bootstrap');
      }
    }
    if (options.onlyFramework) {
      if (options.onlyFramework !== 'yaml' || !options.generatedCase) fail('invalid-targeted-selection');
      plan = { cases: plan.cases.filter(item => item.scope.framework === options.onlyFramework), unsupported: plan.unsupported };
      if (!plan.cases.length) fail('empty-targeted-selection');
    }
    const results: (CheckovGateOutcome & { code?: string; diagnostic?: unknown })[] = [];
    for (const item of plan.cases) {
      try {
        const result = await assessCheckovScope(root, options.executable, item.scope, options.workspaceParent);
        results.push({ id: item.id, status: 'complete', result });
      } catch (error) {
        if (error instanceof CheckovFixtureError) {
          const diagnostic = {
            network: error.networkDiagnostic, filesystem: error.filesystemDiagnostic,
            process: error.processDiagnostic, scope: error.scopeDiagnostic
          };
          results.push({ id: item.id, status: 'error', code: error.code, diagnostic });
        } else if (error instanceof SecurityEvidenceError) {
          results.push({ id: item.id, status: 'error', code: error.code });
        } else throw new SecurityEvidenceError('checkov-scope-failed');
      }
    }
    if ((await git(['rev-parse', '--verify', 'HEAD^{commit}'])).trim() !== head ||
        await names() !== originalNames) fail('source-drift');
    for (const input of inputs.values()) {
      if (await readOsvSource(root, input.pathParts) !== input.content) fail('source-drift');
    }
    const findingGate = summarizeCheckovGate(plan.cases, results, findingPolicySource.content);
    return {
      schemaVersion: 1, kind: 'local-checkov-assessment', sourceCommit: head,
      provenance: 'exact-working-tree-input-digests-not-hosted-proof',
      inputs: [...inputs.values()].map(item => ({ pathParts: item.pathParts, digest: osvDigest(item.content) })),
      selectedScope: options.generatedCase ?? 'committed-iac-and-telemetry-dockerfile',
      selectedFramework: options.onlyFramework ?? null,
      generatedSourceBinding: options.generatedCase ? 'materialized-output-bytes-not-generator-source-qualification' : null,
      planDigest: osvDigest(JSON.stringify(plan)),
      expectedCases: plan.cases.map(item => item.id), results, unsupported: plan.unsupported,
      roleDiagnostics: results.every(item => item.status === 'complete')
        ? previewCheckovRoleDiagnostics(results.flatMap(item => item.status === 'complete' ? [item.result] : [])) : null,
      findingGate,
      selectedAnalysisComplete: results.every(item => item.status === 'complete'),
      fullInventoryQualified: false, findingPolicyQualified: findingGate.gate !== 'incomplete',
      policyAuthority: 'local-contract-preview-not-adopted-pr-policy',
      hostedQualification: false, publicationQualified: false
    };
  } finally { await workspace.cleanup(); }
}

export async function executeFullCheckovAssessment(options: {
  executable: string; workspaceParent: string;
}) {
  const reports = [];
  for (const generatedCase of [undefined, ...generatedSecurityCases.map(entry => entry.id)]) {
    reports.push(await executeCheckovAssessment({ ...options, ...(generatedCase ? { generatedCase } : {}) }));
  }
  const sourceCommit = reports[0]!.sourceCommit;
  const inputs = new Map<string, string>();
  for (const report of reports) {
    if (report.sourceCommit !== sourceCommit) fail('matrix-source-drift');
    for (const input of report.inputs) {
      const key = input.pathParts.join('/');
      if (inputs.has(key) && inputs.get(key) !== input.digest) fail('matrix-input-drift');
      inputs.set(key, input.digest);
    }
  }
  const root = await realpath(process.cwd());
  for (const [name, expected] of inputs) {
    if (osvDigest(await readOsvSource(root, name.split('/'))) !== expected) fail('matrix-input-drift');
  }
  return {
    kind: 'complete-local-checkov-matrix', sourceCommit, expectedGroups: generatedSecurityCases.length + 1,
    reports, analysisComplete: reports.every(report => report.selectedAnalysisComplete),
    gate: reports.some(report => report.findingGate.gate === 'incomplete') ? 'incomplete' as const
      : reports.some(report => report.findingGate.gate === 'blocked') ? 'blocked' as const : 'passed' as const,
    nativeFailuresUnchanged: true, adoptedPolicyAuthority: false, hostedQualification: false, publicationQualified: false
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (![4, 6].includes(args.length) || args[0] !== '--checkov' || args[2] !== '--workspace-parent' ||
        args.length === 6 && args[4] !== '--case') fail('usage');
    const result = await executeCheckovAssessment({
      executable: path.resolve(args[1]!), workspaceParent: path.resolve(args[3]!),
      ...(args.length === 6 ? { generatedCase: args[5]! } : {})
    });
    console.log(JSON.stringify(result));
    process.exitCode = checkovAssessmentExitCode(result);
  } catch (error) {
    console.error(JSON.stringify({
      kind: 'local-checkov-assessment', analysisComplete: false,
      code: error instanceof SecurityEvidenceError ? error.code : 'checkov-driver-failed'
    }));
    process.exitCode = 2;
  }
}
