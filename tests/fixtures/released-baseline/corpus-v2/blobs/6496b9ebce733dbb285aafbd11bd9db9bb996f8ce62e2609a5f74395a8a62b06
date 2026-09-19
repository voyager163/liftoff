import { canonicalSha256 } from './canonical-json.js';
import type { PhaseId, UserActivationState } from './types.js';

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

export function phaseInputDigest(phaseId: PhaseId, snapshot: ActivationInputSnapshot): string {
  // Publication creates HEAD; earlier local receipts bind source bytes rather than
  // the later Git container. The actual resulting OID is recorded in its receipt.
  const local = ['seed-valid', 'seed-verified', 'seed-archived', 'committed'].includes(phaseId);
  return canonicalSha256({
    phaseId,
    baselineSha: snapshot.baselineSha,
    ...(!local ? { git: snapshot.git } : {})
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
