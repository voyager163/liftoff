import path from 'node:path';
import { canonicalSha256 } from '../../src/domain/governance/activation/canonical-json.js';
import { modernComposeInputPolicy } from '../../src/domain/governance/activation/modern-compose.js';
import {
  manualInfrastructureEnvironment, manualInfrastructureOutputPaths, manualInfrastructurePolicy,
  type ManualInfrastructureInputs, type ManualInfrastructureOutput, type ManualInfrastructureOutputEntry
} from '../../src/domain/governance/activation/modern-manual-infrastructure.js';
import {
  localExecutionDigest, manualNativeExecutionPolicy,
  type LocalExecutionPreviewV6, type LocalExecutionResultV5, type LocalExecutionTool
} from '../../src/domain/governance/activation/modern-local-runtime.js';

// Synthetic wire values only: no installed source, observed process or native completion authority.
export const manualWireTime = new Date('2026-10-01T00:00:00.000Z');
export function manualInfrastructureWireInput(count = 1): ManualInfrastructureInputs {
  const modulePathParts = ['infrastructure', 'opentofu', 'azure', 'modules', 'application'];
  return {
    kind: 'liftoff-manual-locked-infrastructure-inputs', schemaVersion: 1,
    policyDigest: canonicalSha256(manualInfrastructurePolicy), moduleComponent: 'opentofu-application', modulePathParts,
    roots: ['dev', 'staging', 'prod'].slice(0, count).map((name, index) => {
      const cwdPathParts = ['infrastructure', 'opentofu', 'azure', 'environments', name];
      return {
        component: `opentofu-environment:${name}`, cwdPathParts, dataPathParts: ['cache', 'manual-init', String(index)],
        lockPathParts: [...cwdPathParts, '.terraform.lock.hcl'], lockDigest: 'a'.repeat(64),
        module: { key: 'application', source: '../../modules/application', pathParts: modulePathParts }
      };
    })
  };
}
export function manualInfrastructureWireOutput(options: {
  input?: ManualInfrastructureInputs; workspace?: string; sourceDigest?: string; toolDigest?: string; component?: string
} = {}): ManualInfrastructureOutput {
  const input = options.input ?? manualInfrastructureWireInput(), component = options.component ?? input.roots[0]!.component;
  const entries = [...manualInfrastructureOutputPaths()].map(([name, kind]): ManualInfrastructureOutputEntry => {
    const binary = name.endsWith(`/${manualInfrastructurePolicy.providerBinary}`);
    const bytes = kind === 'file' ? binary ? 8 : name === 'modules/modules.json' ? 2 : 0 : 0;
    const mode = kind === 'directory' ? name ? 0o755 : 0o700 : binary ? 0o755 : 0o644;
    return { pathParts: name ? name.split('/') : [], kind, bytes, mode, digest: kind === 'file' ? 'c'.repeat(64) : null,
      physical: [1, 1, (kind === 'file' ? 0o100000 : 0o040000) | mode, kind === 'file' ? 1 : 2, bytes, 1, 1, 1, 1, 1].join(':') };
  }).sort((a, b) => a.pathParts.join('/') < b.pathParts.join('/') ? -1 : 1);
  return {
    kind: 'liftoff-manual-infrastructure-output', schemaVersion: 1, component,
    inputDigest: canonicalSha256(input), sourceDigest: options.sourceDigest ?? 'a'.repeat(64),
    toolDigest: options.toolDigest ?? 'b'.repeat(64),
    environmentDigest: canonicalSha256(manualInfrastructureEnvironment(options.workspace ?? path.resolve('workspace'), input, component)),
    dataPathParts: input.roots.find(root => root.component === component)!.dataPathParts,
    entries, outputDigest: canonicalSha256(entries)
  };
}
export function manualExecutionWirePreview(count = 1): LocalExecutionPreviewV6 {
  const infrastructure = manualInfrastructureWireInput(count), executable = path.resolve('wire-tool', 'tofu');
  const toolBody = {
    id: 'tofu', launcherPath: executable, executablePath: executable, prefixArgs: [],
    version: manualInfrastructurePolicy.tofuVersion, versions: { tofu: manualInfrastructurePolicy.tofuVersion },
    files: [{ path: executable, digest: 'a'.repeat(64), bytes: 8, mode: 0o755,
      device: '1', inode: '2', modifiedNs: '3', changedNs: '4' }],
    probe: { executable, args: ['version', '-json'] }
  };
  const tool: LocalExecutionTool = { ...toolBody, digest: canonicalSha256(toolBody) };
  type Check = LocalExecutionPreviewV6['checks'][number];
  function check(id: string, cwdPathParts: readonly string[], args: readonly string[] | null): Check {
    return { id, cwdPathParts: [...cwdPathParts], status: args ? 'planned' : 'inapplicable',
      command: args ? { executable: 'tofu', args: [...args] } : null, env: {}, reasons: [], prerequisites: [], effects: [] };
  }
  const checks = [
    check('framework-source', [], null), check('tofu-validate:opentofu-application', infrastructure.modulePathParts, null),
    ...[{ component: infrastructure.moduleComponent, cwdPathParts: infrastructure.modulePathParts }, ...infrastructure.roots]
      .map(root => check(`tofu-format:${root.component}`, root.cwdPathParts, ['fmt', '-check', '-write=false', './main.tf'])),
    ...infrastructure.roots.flatMap(root => [
      check(`tofu-initialize:${root.component}`, root.cwdPathParts, manualInfrastructurePolicy.initArgs),
      check(`tofu-validate:${root.component}`, root.cwdPathParts, manualInfrastructurePolicy.validateArgs)
    ])
  ];
  const body: Omit<LocalExecutionPreviewV6, 'fingerprint'> = {
    kind: 'liftoff-local-execution-preview', schemaVersion: 6, operationKind: 'verify-local',
    projectRoot: path.resolve('wire-project'), operationId: '11111111-1111-4111-8111-111111111111',
    createdAt: manualWireTime.toISOString(), expiresAt: new Date(manualWireTime.getTime() + 900_000).toISOString(),
    installedBinding: 'a'.repeat(64), observationDigest: 'b'.repeat(64), physicalDigest: 'c'.repeat(64),
    baselineDigest: 'd'.repeat(64), recipeDigest: 'e'.repeat(64), policyDigest: canonicalSha256(manualNativeExecutionPolicy),
    checks, tools: [tool], preparation: [], preparationDigest: canonicalSha256([]),
    outputRoles: [{ ...manualNativeExecutionPolicy.outputRole, pathParts: [...manualNativeExecutionPolicy.outputRole.pathParts] }],
    selectedPlan: null, selectedPlanDigest: null,
    manualInputs: { infrastructure, compose: { kind: 'liftoff-closed-compose-inputs', schemaVersion: 1,
      policyDigest: canonicalSha256(modernComposeInputPolicy), sourceDigest: 'f'.repeat(64), unsetEnvironment: [] } }
  };
  return { ...body, fingerprint: localExecutionDigest(body) };
}
export function manualExecutionWireResult(preview: LocalExecutionPreviewV6) {
  const workspace = path.resolve('wire-workspaces', preview.operationId), tool = preview.tools[0]!;
  const at = (milliseconds: number) => new Date(manualWireTime.getTime() + milliseconds).toISOString();
  const body: Omit<LocalExecutionResultV5, 'resultDigest'> = {
    kind: 'liftoff-local-execution-result', schemaVersion: 5, projectRoot: preview.projectRoot,
    fingerprint: preview.fingerprint, operationId: preview.operationId, status: 'checks-verified', complete: true,
    startedAt: at(0), completedAt: at(5_000), preparation: [],
    checks: preview.checks.map((check, index) => check.status === 'inapplicable'
      ? { id: check.id, status: 'inapplicable', code: 'inapplicable', commandDigest: null, toolDigest: null,
        exitStatus: null, signal: null, startedAt: null, completedAt: null, stdoutDigest: null, stderrDigest: null, processTreeSettled: true }
      : { id: check.id, status: 'passed', code: 'passed',
        commandDigest: canonicalSha256({ executable: tool.executablePath, args: check.command!.args }), toolDigest: tool.digest,
        exitStatus: 0, signal: null, startedAt: at(index * 100), completedAt: at(index * 100 + 50),
        stdoutDigest: 'f'.repeat(64), stderrDigest: 'f'.repeat(64), processTreeSettled: true }),
    inputsUnchanged: true, cleanupComplete: true, retainedWorkspace: null,
    policyDigest: preview.policyDigest, baselineDigest: preview.baselineDigest, selectedPlanDigest: null, failureCode: null,
    infrastructure: {
      inputDigest: canonicalSha256(preview.manualInputs.infrastructure),
      outputs: preview.manualInputs.infrastructure.roots.map(root => manualInfrastructureWireOutput({
        input: preview.manualInputs.infrastructure, workspace, sourceDigest: preview.observationDigest,
        toolDigest: tool.digest, component: root.component
      }))
    }
  };
  const result: LocalExecutionResultV5 = { ...body, resultDigest: canonicalSha256(body) };
  return { result, workspace };
}
