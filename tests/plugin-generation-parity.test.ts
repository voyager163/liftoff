import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { GeneratedArtifact } from '../src/domain/project/contracts.js';
import { buildArtifacts } from '../src/templates.js';
import { matrixPlan, pluginGenerationMatrix, type MatrixCase } from './fixtures/plugin-generation-matrix.js';
import { expectReviewedRendering, previousGenerationHashes } from './fixtures/reviewed-rendering.js';
import { expectBeforeTemplateAuditGeneration, restoreTemplateAuditArtifacts } from './fixtures/template-audit-rendering.js';

/*
 * Rendered-output oracle for built-in plugin composition. It was captured once from unchanged
 * generation, before composition was wired, and must stay byte-identical afterwards. Never update
 * this snapshot to bless a wiring change. Separately versioned behavior uses exact before/after
 * digest records; identities, counts and rows still compare with the unchanged original snapshot.
 */

const digest = (value: string): string => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;

const identityOf = (artifact: GeneratedArtifact) => [
  artifact.logicalName,
  artifact.category,
  artifact.lifecycle,
  artifact.lifecycle === 'project' ? artifact.provisioningGroup : null,
  artifact.pathParts
];

const identityRow = (artifact: GeneratedArtifact): string => [
  artifact.lifecycle === 'project' ? `${artifact.lifecycle}:${artifact.provisioningGroup}` : artifact.lifecycle,
  artifact.category,
  artifact.logicalName,
  artifact.pathParts.join('/')
].join(' ');

/** Every workload-variant under both workflows, with governance enabled and the frontend included. */
const withRows = (entry: MatrixCase): boolean => /^m1\/[^/]+\/[^/]+\/governed\/frontend$/.test(entry.id);

function artifactRecord(entry: MatrixCase, artifacts: GeneratedArtifact[]) {
  const manifest = artifacts.filter((artifact) => artifact.logicalName === 'manifest');
  expect(manifest).toHaveLength(1);
  return {
    count: artifacts.length,
    identities: digest(JSON.stringify(artifacts.map(identityOf))),
    artifacts: digest(JSON.stringify(artifacts)),
    contents: digest(JSON.stringify(artifacts.map((artifact) => artifact.content))),
    manifest: digest(manifest[0].content),
    ...(withRows(entry) ? { rows: artifacts.map(identityRow) } : {})
  };
}

function record(entry: MatrixCase) {
  const artifacts = buildArtifacts(matrixPlan(entry));
  expect(buildArtifacts(matrixPlan(entry)), 'generation is deterministic').toEqual(artifacts);
  expectBeforeTemplateAuditGeneration(entry.id, artifactRecord(entry, restoreTemplateAuditArtifacts(artifacts)));
  return artifactRecord(entry, artifacts);
}

describe('built-in plugin generation parity matrix', () => {
  it('is the fixed 165-case matrix', () => {
    const groups = Object.fromEntries(['M1', 'M2a', 'M2b', 'M3', 'M4'].map((group) =>
      [group, pluginGenerationMatrix.filter((entry) => entry.group === group).length]));
    expect(groups).toEqual({ M1: 96, M2a: 28, M2b: 8, M3: 21, M4: 12 });
    expect(new Set(pluginGenerationMatrix.map((entry) => entry.id)).size).toBe(165);
    expect(pluginGenerationMatrix.filter((entry) => entry.agentless).map((entry) => entry.group))
      .toEqual(Array(8).fill('M2b'));
    expect(pluginGenerationMatrix.filter(withRows)).toHaveLength(24);
  });

  it.each(pluginGenerationMatrix.map((entry) => [entry.id, entry] as const))('renders %s unchanged', (_id, entry) => {
    const current = record(entry);
    const baseline = { ...current, ...previousGenerationHashes(entry.id) };
    expectReviewedRendering('plugin-generation', entry.id, current, baseline);
    expect(baseline).toMatchSnapshot();
  });

  it('rejects unreviewed content, identity and non-hash manifest changes during audit rollback', () => {
    const entry = pluginGenerationMatrix.find(value => value.id === 'm1/node-fastify/openspec/governed/frontend')!;
    expect(entry).toBeDefined();
    const artifacts = buildArtifacts(matrixPlan(entry));
    const mutations: Array<(values: GeneratedArtifact[]) => void> = [
      values => { values.find(value => value.logicalName === 'node-backend-package')!.content += '\nunreviewed\n'; },
      values => { values.find(value => value.logicalName === 'root-readme')!.content += '\nunreviewed\n'; },
      values => { values[0]!.pathParts.push('unreviewed'); },
      values => {
        const manifest = values.find(value => value.logicalName === 'manifest')!;
        manifest.content = JSON.stringify({ ...JSON.parse(manifest.content), unreviewed: true }, null, 2) + '\n';
      },
      values => {
        const manifest = values.find(value => value.logicalName === 'manifest')!;
        manifest.content = manifest.content.replace(/"generationHash": "sha256:[a-f0-9]{64}"/u,
          `"generationHash": "sha256:${'0'.repeat(64)}"`);
      }
    ];
    for (const mutate of mutations) {
      const altered = structuredClone(artifacts);
      mutate(altered);
      expect(() => expectBeforeTemplateAuditGeneration(entry.id, artifactRecord(entry, restoreTemplateAuditArtifacts(altered))))
        .toThrow();
    }
  });
});
