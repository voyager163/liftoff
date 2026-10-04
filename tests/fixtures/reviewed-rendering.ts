import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { expect } from 'vitest';

interface Change {
  surface: string;
  key: string;
  task: string;
  reason: string;
  baselineSha256: string;
  currentSha256: string;
  previous?: { artifacts: string; contents: string; manifest: string };
}

const { baselineComparison }: {
  baselineComparison: (surface: string, key: string, current: unknown, baseline: unknown, changes: Change[]) => { status: string };
} = createRequire(import.meta.url)('../../scripts/contract-baseline.mjs');
const review: { changes: Change[] } = JSON.parse(readFileSync(
  new URL('./contract-baseline-changes.json', import.meta.url), 'utf8'
));

export function expectReviewedRendering(surface: string, key: string, current: unknown, baseline: unknown): void {
  const verdict = baselineComparison(surface, key, current, baseline, review.changes);
  expect(['unchanged', 'recorded-change'], `${surface} ${key}: ${JSON.stringify(verdict)}`).toContain(verdict.status);
}

export function previousGenerationHashes(key: string): Partial<NonNullable<Change['previous']>> {
  const records = review.changes.filter(change => change.surface === 'plugin-generation' && change.key === key);
  if (records.length === 0) return {};
  expect(records).toHaveLength(1);
  const previous = records[0].previous;
  expect(previous).toBeDefined();
  expect(Object.keys(previous ?? {}).sort()).toEqual(['artifacts', 'contents', 'manifest']);
  for (const value of Object.values(previous ?? {})) expect(value).toMatch(/^sha256:[a-f0-9]{64}$/u);
  return previous ?? {};
}

const historicalSkills: { bodies: Record<string, { sha256: string; text: string }> } = JSON.parse(readFileSync(
  new URL('./pre-negotiation-skills.json', import.meta.url), 'utf8'
));

export function expectBoundedCapabilitySkill(content: string, operation: 'setup' | 'assessment'): void {
  const original = historicalSkills.bodies[operation === 'setup' ? 'setup' : 'governance-assessment'];
  expect(createHash('sha256').update(original.text).digest('hex')).toBe(original.sha256);
  if (operation === 'setup') {
    const modernStart = content.indexOf('Current update 4 preserves configuration,');
    const historicalStart = content.indexOf(original.text);
    expect(modernStart).toBeGreaterThan(0);
    expect(historicalStart).toBeGreaterThan(modernStart);
    const modernGuidance = content.slice(modernStart, historicalStart);
    // Only this reviewed v8 branch is outside the original historical bounds.
    expect(createHash('sha256').update(modernGuidance).digest('hex'))
      .toBe('dc8942ea3bfae14017327dc15b990605ece1941b2ac028405a219211eeb84c85');
    expect(content.length).toBeLessThan(5_500);
    const advertisement = 'governance 2,\nupdate 3 or update 4. Update 4 additionally requires `schemas.currentUpdate`\n'
      + 'with report 4, manifestWrite 8, separateConsent and explicitRecovery.';
    expect(content).toContain(advertisement);
    content = content.replace(modernGuidance, '').replace(advertisement, 'governance 2, update 3.');
  }
  const gateStart = content.indexOf('Before project access, run `liftoff capabilities --json`.');
  const protocolStart = content.indexOf(original.text);
  expect(gateStart).toBeGreaterThanOrEqual(0);
  expect(protocolStart).toBeGreaterThan(gateStart);
  expect(content.slice(protocolStart)).toBe(original.text);
  const header = content.slice(0, gateStart);
  expect(header.length + original.text.length).toBeLessThan(operation === 'setup' ? 3_000 : 2_500);
  expect(protocolStart - gateStart).toBeLessThan(operation === 'setup' ? 700 : 500);
  expect(content.length).toBeLessThan(operation === 'setup' ? 3_700 : 3_000);
}
