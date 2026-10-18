export interface CaskStageWritePlan {
  schemaVersion: 1;
  kind: 'liftoff-cask-stage-write';
  mode: 'create' | 'manifest';
  root: string;
  directoryIdentity: string;
  files: { name: string; bytes: number; sha256: string }[];
}

export function parseCaskStageWritePlan(value: unknown): CaskStageWritePlan;
