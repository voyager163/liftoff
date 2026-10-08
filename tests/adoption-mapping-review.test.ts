import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdoptionMappingReview } from '../src/application/adoption/mapping-review.js';
import { prepareAdoptionDestinationPlan } from '../src/application/adoption/destination-plan.js';
import { createAdoptionReview } from '../src/application/adoption/preview.js';
import { adoptionFixture } from './fixtures/adoption.js';

const roots: string[] = [];
const now = new Date('2026-10-20T09:00:00.000Z');

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'liftoff-adoption-mapping-')));
  roots.push(root);
  return root;
}

async function put(root: string, pathParts: readonly string[], content: string): Promise<void> {
  const filename = path.join(root, ...pathParts);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, content, { mode: 0o640 });
}

async function fixture() {
  const root = await directory();
  const value = adoptionFixture();
  const backend = value.source.activeLayout.bindings.find(binding =>
    binding.kind === 'artifact' && binding.logicalName !== 'root-readme');
  if (!backend || backend.kind !== 'artifact') throw new Error('Missing backend binding fixture.');
  const backendRoot = backend.pathParts.slice(0, 2);
  const helper = [...backendRoot, 'custom', 'helper.ts'];
  const test = [...backendRoot, 'test', 'integration.test.ts'];
  await put(root, backend.pathParts, 'export const application = true;\n');
  await put(root, ['README.md'], `See "${backend.pathParts.join('/')}".\n`);
  await put(root, helper, 'export const helper = 37;\n');
  await put(root, test, 'import { helper } from "../custom/helper.js";\n');
  await put(root, [...backendRoot, 'package.json'], `{"scripts":{"test":"node ${test.slice(2).join('/')}"} }\n`);
  await put(root, ['Dockerfile'], `COPY "${backendRoot.join('/')}" /app\n`);
  await put(root, ['compose.yml'], `services:\n  api:\n    build:\n      context: "${backendRoot.join('/')}"\n`);
  await put(root, ['.github', 'workflows', 'check.yml'], `steps:\n  - run: node "${test.join('/')}"\n`);
  await put(root, ['docs', 'operations.md'], `Run "${test.join('/')}" before release.\n`);
  const review = await createAdoptionReview(root, value.source, now);
  const destination = await prepareAdoptionDestinationPlan(review.preview, value.source, now);
  return { root, value, backendRoot, helper, test, review, destination };
}

describe('finite adoption file and reference review draft', () => {
  it('classifies import, build/test, Docker, Compose, CI, and documentation review surfaces without approving them', async () => {
    const input = await fixture();
    const report = createAdoptionMappingReview(
      input.review.report.inventory,
      input.review.preview,
      input.destination.report
    );
    expect(report).toMatchObject({
      schemaVersion: 1,
      kind: 'liftoff-adoption-mapping-review',
      readOnly: true,
      projectRoot: input.root,
      status: 'blocked',
      dynamicReferencesReviewed: false,
      verificationSelection: 'not-provided',
      compatibility: 'not-verified',
      publication: 'not-authorized'
    });
    expect(report.observedSurfaces).toEqual(expect.arrayContaining([
      'source', 'build', 'test', 'container', 'compose', 'ci', 'documentation'
    ]));
    expect(report.observedReferenceSurfaces).toEqual(expect.arrayContaining([
      'import', 'build', 'container', 'compose', 'ci', 'documentation'
    ]));
    expect(report.files).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pathParts: input.helper,
        surface: 'source',
        suggestedDisposition: 'mapping-decision-required'
      }),
      expect.objectContaining({ pathParts: ['Dockerfile'], surface: 'container' }),
      expect.objectContaining({ pathParts: ['compose.yml'], surface: 'compose' }),
      expect.objectContaining({ pathParts: ['.github', 'workflows', 'check.yml'], surface: 'ci' }),
      expect.objectContaining({ pathParts: ['docs', 'operations.md'], surface: 'documentation' })
    ]));
    expect(report.references).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourcePathParts: input.test,
        targetPathParts: input.helper,
        surface: 'import'
      }),
      expect.objectContaining({ sourcePathParts: ['Dockerfile'], surface: 'container' }),
      expect.objectContaining({ sourcePathParts: ['compose.yml'], surface: 'compose' }),
      expect.objectContaining({ sourcePathParts: ['.github', 'workflows', 'check.yml'], surface: 'ci' }),
      expect.objectContaining({ sourcePathParts: ['docs', 'operations.md'], surface: 'documentation' })
    ]));
    expect(report.unresolvedMappings).toContainEqual({
      pathParts: input.helper,
      reason: 'mapping-decision-required'
    });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.files)).toBe(true);
    expect(Object.isFrozen(report.files[0]?.pathParts)).toBe(true);
    expect(JSON.stringify(report)).not.toContain('helper = 37');
  });

  it('keeps unsupported backend-language conversion unresolved instead of substituting starter bytes', async () => {
    const input = await fixture();
    const incompatible = [...input.backendRoot, 'legacy.go'];
    await put(input.root, incompatible, 'package legacy\n');
    const review = await createAdoptionReview(input.root, input.value.source, now);
    const destination = await prepareAdoptionDestinationPlan(review.preview, input.value.source, now);
    const report = createAdoptionMappingReview(
      review.report.inventory,
      review.preview,
      destination.report
    );
    expect(report.status).toBe('blocked');
    expect(report.files).toContainEqual(expect.objectContaining({
      pathParts: incompatible,
      suggestedDisposition: 'unsupported-language-conversion'
    }));
    expect(report.unresolvedMappings).toContainEqual({
      pathParts: incompatible,
      reason: 'unsupported-language-conversion'
    });
    expect(report.limitations.join(' ')).toContain('language or framework evidence remains unresolved');
  });

  it('produces a deterministic explicit-review draft for an already bound compatible application', async () => {
    const root = await directory();
    const value = adoptionFixture();
    for (const observation of value.request.adoptionObservations) {
      await put(root, observation.pathParts, `${observation.logicalName}\n`);
    }
    const review = await createAdoptionReview(root, value.source, now);
    const destination = await prepareAdoptionDestinationPlan(review.preview, value.source, now);
    const first = createAdoptionMappingReview(review.report.inventory, review.preview, destination.report);
    const second = createAdoptionMappingReview(review.report.inventory, review.preview, destination.report);
    expect(first).toEqual(second);
    expect(first.status).toBe('explicit-review-required');
    expect(first.unresolvedMappings).toEqual([]);
    expect(first.files.every(file =>
      file.suggestedDisposition === 'preserve-current-path' &&
      file.decision === 'explicit-review-required')).toBe(true);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });
});
