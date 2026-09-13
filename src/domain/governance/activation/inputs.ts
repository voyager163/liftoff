import { canonicalSha256 } from './canonical-json.js';
import { canonicalPhaseGraph } from './graph.js';
import type { PhaseId, UserActivationState } from './types.js';
import { phaseScope } from './types.js';

export interface ActivationInputFile {
  path: string;
  digest: string;
}

export function isProjectMutationReservationName(name: string): boolean {
  return /^\.liftoff-mutation-[a-f0-9]{64}\.lock$/.test(name);
}

export interface ActivationInputSnapshot {
  schemaVersion: 2;
  project: unknown;
  files: readonly ActivationInputFile[];
  git: {
    head: string | null;
    branch: string | null;
    pushUrls: readonly string[];
  };
  baselineSha: string;
  workflowSpecDigest?: string;
  sensitivePathExclusions?: readonly (readonly string[])[];
}

const publicEnvironmentKeys = new Set([
  'APP_NAME', 'APP_ENV', 'ENVIRONMENT', 'LOG_LEVEL', 'PORT', 'HOST', 'CORS_ORIGINS',
  'MODEL_PROVIDER', 'MODEL_NAME', 'AI_MODEL_PROVIDER', 'AI_MODEL_NAME', 'AI_MODEL_ID',
  'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT', 'OPENAI_MODEL', 'OLLAMA_BASE_URL',
  'LANGFUSE_HOST', 'OTEL_SERVICE_NAME', 'OTEL_EXPORTER_OTLP_ENDPOINT',
  'MESSAGING_TRANSPORT', 'REDIS_STREAM', 'REDIS_STREAM_NAME', 'SERVICE_BUS_NAMESPACE',
  'SERVICE_BUS_QUEUE_NAME', 'SERVICEBUS_FULLY_QUALIFIED_NAMESPACE', 'SERVICEBUS_QUEUE_NAME'
]);

export function normalizedPublicEnvironment(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || !publicEnvironmentKeys.has(match[1]!)) continue;
    let value = match[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    if (value.includes('${')) throw new Error(`Public configuration ${match[1]} has unresolved interpolation; no project configuration is executed.`);
    if (/https?:\/\/[^/]*@/i.test(value) || /[?&](?:token|key|secret|sig)=/i.test(value)) continue;
    result[match[1]!] = value;
  }
  return result;
}

export function normalizedSeedInput(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/^(\s*-\s+\[)[xX](\])/gm, '$1 $2');
}

export function activationBaselineDigest(project: unknown, files: readonly ActivationInputFile[]): string {
  return canonicalSha256({ schemaVersion: 2, project, files: [...files].sort((a, b) => a.path.localeCompare(b.path, 'en')) });
}

export function phaseInputFiles(phaseId: PhaseId, snapshot: ActivationInputSnapshot): readonly ActivationInputFile[] {
  const workflow = (file: ActivationInputFile) =>
    file.path.startsWith('.github/workflows/') || file.path.startsWith('.github/actions/') ||
    file.path.startsWith('.github/rulesets/') || file.path.startsWith('governance/rulesets/');
  if (['seed-valid', 'seed-verified', 'seed-archived', 'committed', 'pushed', 'activation-approved'].includes(phaseId)) {
    // Workflow publication is qualified by its own phases, not by local application checks.
    return snapshot.files.filter((file) => !workflow(file) && file.path !== 'governance/credentials/preflight-policy.json');
  }
  if (phaseId === 'bootstrap-workflow-source-ready' || phaseId === 'credential-ready' ||
    phaseId === 'runner-ready' || phaseId === 'private-backend-proof') {
    return snapshot.files.filter((file) =>
      file.path.startsWith('.github/workflows/liftoff-bootstrap') ||
      file.path === '.github/workflows/bootstrap-import-preflight.yml' ||
      file.path === '.github/workflows/private-dast-preflight.yml' ||
      file.path.startsWith('.github/actions/') ||
      file.path === 'governance/credentials/preflight-policy.json'
    );
  }
  if (phaseId === 'phase-0-complete' || phaseId === 'provider-ready' || phaseId === 'state-path-selected' ||
    phaseId === 'bootstrap-state-disposed') {
    return snapshot.files.filter((file) => file.path.startsWith('.liftoff/governance/'));
  }
  if (['existing-private-path', 'bootstrap-local', 'remote-import-verified', 'remote-ready', 'application-prerequisites-ready'].includes(phaseId)) {
    return snapshot.files.filter((file) => file.path.startsWith('infrastructure/') || file.path.startsWith('.liftoff/governance/'));
  }
  return snapshot.files;
}

export function phaseInputDigest(phaseId: PhaseId, snapshot: ActivationInputSnapshot, state?: UserActivationState): string {
  const local = phaseScope(phaseId) === 'local';
  const dependencies = canonicalPhaseGraph.phases.find((phase) => phase.id === phaseId)?.dependencies ?? [];
  const parentOutputs = Object.fromEntries(dependencies.flatMap((dependency) => dependency.anyOf)
    .filter((id) => state?.phaseOutputs?.[id] !== undefined)
    .map((id) => [id, state!.phaseOutputs![id]]));
  return canonicalSha256({
    schemaVersion: 3,
    phaseId,
    project: snapshot.project,
    files: phaseInputFiles(phaseId, snapshot),
    ...(snapshot.sensitivePathExclusions?.length ? {
      protectedPathsDigest: canonicalSha256(snapshot.sensitivePathExclusions)
    } : {}),
    ...(!local && phaseId !== 'committed' ? { pushUrls: snapshot.git.pushUrls } : {}),
    ...(!local ? {
      configuration: state?.activationInputs ? {
        repository: state.activationInputs.repository ?? null,
        azure: state.activationInputs.azure ?? null,
        phase: state.activationInputs.phases[phaseId] ?? null
      } : null,
      parentOutputs
    } : {})
  });
}

export function remoteBindingDigest(binding: UserActivationState['remoteBinding']): string | undefined {
  if (!binding) return undefined;
  const { verifiedAt: _verifiedAt, ...identity } = binding;
  return canonicalSha256(identity);
}

export function remoteRepository(state: UserActivationState): UserActivationState['repository'] {
  return state.remoteBinding ?? state.repository;
}

export function githubRepositoryFromPushUrl(url: string): string {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
  if (!match) throw new Error('A supported credential-free GitHub push destination is required for repository discovery.');
  return match[1]!;
}
