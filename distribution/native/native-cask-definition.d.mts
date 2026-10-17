export interface NativeCaskDefinition {
  readonly filename: string;
  readonly content: string;
}

export function nativeCaskDefinition(
  record: unknown,
  evidence: unknown,
  approvedPolicy?: unknown
): NativeCaskDefinition;
