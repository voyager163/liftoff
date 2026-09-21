import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { supportedStack } from '../src/supported-stack.js';
import { actionDefinition, inspectPinnedRemoteAction, parseActionReference, verifyActionGraph, workflowActionReferences } from '../scripts/repository-security/actions.ts';

const first = `example/first@${'a'.repeat(40)}`, second = `example/second/inner@${'b'.repeat(40)}`;
const node = { runs: { using: 'node24', main: 'dist/index.js' } };

describe('explicit action dependency closure', () => {
  it('binds the fetched descriptor bytes to the observed Git blob without executing action code', async () => {
    const source = JSON.stringify(node);
    const descriptorGitBlob = createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex');
    const definition = await inspectPinnedRemoteAction({ reference: first, descriptorGitBlob }, async (url, options) => {
      expect(String(url)).toBe(`https://raw.githubusercontent.com/example/first/${'a'.repeat(40)}/action.yml`);
      expect(options?.redirect).toBe('error');
      expect(options?.headers).toBeUndefined();
      return new Response(source);
    });
    expect(definition.kind).toBe('node');
    await expect(inspectPinnedRemoteAction({ reference: first, descriptorGitBlob }, async () => new Response('different')))
      .rejects.toThrow('action-descriptor-identity-mismatch');
    await expect(inspectPinnedRemoteAction({ reference: first, descriptorGitBlob }, async () => new Response('', { status: 503 })))
      .rejects.toThrow('action-descriptor-unavailable');
  });

  it('binds current action inspection to the existing supported-stack pins without claiming hosted enforcement', async () => {
    const source = JSON.parse(await readFile(path.join(process.cwd(), 'security', 'action-dependencies.json'), 'utf8'));
    const expected = Object.values(supportedStack.githubActions).map(action => `${action.repository}@${action.commit}`).sort();
    const registered = source.actions.map((item: { reference: string }) => item.reference).sort();
    expect(registered).toEqual([...expected,
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
      'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c'].sort());
    expect(source.hostedAllowlistApplied).toBe(false);
    const auditWorkflow = await readFile(path.join(process.cwd(), '.github', 'workflows', 'template-dependency-audit.yml'), 'utf8');
    expect(auditWorkflow).toContain('run: node scripts/check-repository-actions.mjs');
    for (const name of ['ci.yml', 'release.yml', 'template-dependency-audit.yml', 'supported-stack-freshness.yml', 'codeql.yml']) {
      const value: unknown = parse(await readFile(path.join(process.cwd(), '.github', 'workflows', name), 'utf8'));
      for (const reference of workflowActionReferences(value)) {
        expect(registered).toContain(reference);
        expect(parseActionReference(reference).kind).toBe('remote');
      }
    }
  });

  it('inspects composite and reusable dependencies rather than trusting a pinned outer reference', () => {
    const composite = { runs: { using: 'composite', steps: [{ uses: second }] } };
    const definitions = new Map([
      [first, actionDefinition(first, JSON.stringify(composite))],
      [second, actionDefinition(second, JSON.stringify(node))]
    ]);
    expect(verifyActionGraph([first], [first, second], definitions)).toEqual([first, second]);
    expect(() => verifyActionGraph([first], [first], definitions)).toThrow('unapproved-action-dependency');
    const reusable = { jobs: { test: { uses: second } } };
    expect(actionDefinition(first, JSON.stringify(reusable)).dependencies).toEqual([second]);
  });

  it('rejects mutable nested refs, unknown local actions, cycles and missing descriptors', () => {
    const mutable = { runs: { using: 'composite', steps: [{ uses: 'example/second@v1' }] } };
    expect(() => actionDefinition(first, JSON.stringify(mutable))).toThrow('invalid-revision');
    const local = './.github/actions/check';
    const definitions = new Map([
      [first, actionDefinition(first, JSON.stringify({ runs: { using: 'composite', steps: [{ uses: local }] } }))],
      [local, actionDefinition(local, JSON.stringify({ runs: { using: 'composite', steps: [{ uses: first }] } }))]
    ]);
    expect(() => verifyActionGraph([first], [first], definitions)).toThrow('unapproved-action-dependency');
    expect(() => verifyActionGraph([first], [first, local], definitions)).toThrow('action-dependency-cycle');
    expect(() => verifyActionGraph([first], [first], new Map())).toThrow('missing-action-inspection');
  });

  it.each(['./../outside', `owner/repo/../action@${'a'.repeat(40)}`, 'docker://image:latest'])(
    'rejects unqualified reference %s', reference => expect(() => parseActionReference(reference)).toThrow());

  it('rejects unqualified runtime or escaping action entrypoints', () => {
    expect(() => actionDefinition(first, JSON.stringify({ runs: { using: 'docker', image: 'Dockerfile' } })))
      .toThrow('unqualified-action-runtime');
    expect(() => actionDefinition(first, JSON.stringify({ runs: { using: 'node24', main: '../outside.js' } })))
      .toThrow('unsafe-location');
  });
});
