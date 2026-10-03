import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  historyArray, historyRecord, historyString, parseHistoryJson, rawHistoryDigest,
  validateActivationHistoryIndex, validateHistoricalV3SourceMigrationJournal
} from '../../../src/governance-activation/history-contracts.js';
import { validateHistoricalV3ActivationState } from '../../../src/governance-activation/historical-v3.js';

export const releasedV3RecordsSha256 = 'cb9a4768b30e031d9d4b802528223679efa28259b50713221cdfc7a71d6eda46';
export const releasedV3GraphSha256 = '2e214353fe73edeea246dac49aa5126c3d1e50afb3e12801940b661afb853703';

export function capturedV3Records(): Record<string, unknown> {
  const bytes = readFileSync(new URL('./records.json', import.meta.url));
  if (createHash('sha256').update(bytes).digest('hex') !== releasedV3RecordsSha256) {
    throw new Error('The pre-extraction v3 capture changed; do not regenerate it from current output.');
  }
  return historyRecord(parseHistoryJson(bytes, 'v3 fixture'), 'v3 fixture');
}

export function capturedV3Successor(family: 1 | 2) {
  const record = historyArray(capturedV3Records().successors, 'captured successors')
    .map(value => historyRecord(value, 'captured successor')).find(value => value.family === family);
  if (!record) throw new Error('Missing captured predecessor family.');
  const index = validateActivationHistoryIndex(record.index);
  const indexContent = Buffer.from(historyString(record.indexContent, 'captured index bytes'), 'base64');
  const state = validateHistoricalV3ActivationState(record.state);
  const journal = validateHistoricalV3SourceMigrationJournal(record.journal);
  const files = new Map(historyArray(record.sourceFiles, 'captured files').map(value => {
    const file = historyRecord(value, 'captured file');
    const parts = historyArray(file.pathParts, 'captured file path').map(part => historyString(part, 'captured path part'));
    return [parts.join('/'), Buffer.from(historyString(file.content, 'captured bytes'), 'base64')] as const;
  }));
  for (const file of index.files) {
    const bytes = files.get(file.originalPathParts.join('/'));
    if (!bytes || rawHistoryDigest(bytes) !== file.digest) throw new Error('Captured original bytes disagree with their index.');
  }
  return { index, indexContent, state, journal, files };
}

export async function writeFixtureBytes(root: string, parts: readonly string[], bytes: string | Buffer, mode = 0o600) {
  const destination = path.join(root, ...parts);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { mode });
}

export async function writeCapturedV3Successor(root: string, family: 1 | 2) {
  const captured = capturedV3Successor(family);
  await writeFixtureBytes(root, ['liftoff.manifest.json'], JSON.stringify(capturedV3Records().manifest));
  await writeFixtureBytes(root, ['governance', 'activation-state.json'], JSON.stringify(captured.state));
  await writeFixtureBytes(root, ['governance', 'migration-state.json'], JSON.stringify(captured.journal));
  await writeFixtureBytes(root, captured.journal.historyIndexPathParts, captured.indexContent);
  for (const file of captured.index.files) {
    await writeFixtureBytes(root, file.copyPathParts, captured.files.get(file.originalPathParts.join('/'))!);
  }
  return captured;
}
