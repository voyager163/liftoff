import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPublicGovernanceInputs } from '../src/adapters/filesystem/governance-records.js';
import { parseModernLocalConsentRequest, parseModernLocalVerificationRequest } from '../src/application/governance/modern-local-request.js';
import { parseArgs } from '../src/args.js';

const scopes = {
  projectCode: true, hostCapabilitiesAcknowledged: true, dependencyPreparation: false, dependencyNetwork: false,
  workflowFinalization: false, publishLocalRecords: false
};
const kinds = ['verify-local', 'verify-openspec-local', 'verify-openspec-initialized', 'verify-openspec-archived'];
const fingerprint = 'a'.repeat(64);
const roots: { path: string; dev: number; ino: number }[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const stat = await fs.lstat(root.path);
    expect([stat.dev, stat.ino, stat.isDirectory(), stat.isSymbolicLink()]).toEqual([root.dev, root.ino, true, false]);
    await fs.rm(root.path, { recursive: true });
  }
});

describe('closed public local request and consent values', () => {
  it.each(kinds)('accepts only explicit %s preparation', kind => {
    expect(parseModernLocalVerificationRequest({ kind, preparation: [] })).toEqual({ kind, preparation: [] });
    expect(() => parseModernLocalVerificationRequest({ kind })).toThrow();
    expect(() => parseModernLocalVerificationRequest({ kind, preparation: [], execute: true })).toThrow();
  });
  it.each([null, [], true, 'verify-local', {}, { kind: 'verify', preparation: [] },
    { kind: 'verify-local', preparation: 'automatic' }, { kind: 'verify-local', preparation: [{ network: true }] }])(
    'refuses an incomplete or unknown request %j', value => {
      expect(() => parseModernLocalVerificationRequest(value)).toThrow();
    });
  it('retains six independent consent scopes and separate initialization attestation', () => {
    const ordinary = { kind: 'approve-local-execution', scopes };
    expect(parseModernLocalConsentRequest(ordinary)).toEqual(ordinary);
    const initialized = { kind: 'approve-openspec-initialized', scopes: { ...scopes, dependencyPreparation: true },
      bootstrapScopeAttestation: { generatedBaselineReviewed: true, domainBehaviorDeferred: true } };
    expect(parseModernLocalConsentRequest(initialized)).toEqual(initialized);
    for (const field of Object.keys(scopes)) {
      const incomplete = { ...scopes };
      Reflect.deleteProperty(incomplete, field);
      expect(() => parseModernLocalConsentRequest({ ...ordinary, scopes: incomplete })).toThrow();
    }
    for (const field of ['projectCode', 'hostCapabilitiesAcknowledged']) {
      expect(() => parseModernLocalConsentRequest({ ...ordinary, scopes: { ...scopes, [field]: false } })).toThrow();
    }
    for (const field of ['workflowFinalization', 'publishLocalRecords']) {
      expect(() => parseModernLocalConsentRequest({ ...ordinary, scopes: { ...scopes, [field]: true } })).toThrow();
    }
    for (const field of ['dependencyPreparation', 'dependencyNetwork']) {
      expect(() => parseModernLocalConsentRequest({ ...ordinary, scopes: { ...scopes, [field]: 'true' } })).toThrow();
    }
    for (const field of ['generatedBaselineReviewed', 'domainBehaviorDeferred']) {
      expect(() => parseModernLocalConsentRequest({ ...initialized,
        bootstrapScopeAttestation: { ...initialized.bootstrapScopeAttestation, [field]: false } })).toThrow();
    }
    expect(() => parseModernLocalConsentRequest({ ...ordinary, bootstrapScopeAttestation: initialized.bootstrapScopeAttestation })).toThrow();
    expect(() => parseModernLocalConsentRequest({ kind: initialized.kind, scopes })).toThrow();
  });
  it('preserves exact registered preparation and separate network consent without dispatch', () => {
    const preparation = [{ provider: 'npm-ci', version: 1, cwdPathParts: ['backend'],
      packageSource: 'npmjs', network: true, lifecycle: 'disabled' }];
    expect(parseModernLocalVerificationRequest({ kind: 'verify-local', preparation })).toEqual({ kind: 'verify-local', preparation });
    const request = { kind: 'approve-local-execution', scopes: { ...scopes, dependencyPreparation: true, dependencyNetwork: true } };
    expect(parseModernLocalConsentRequest(request)).toEqual(request);
    expect(() => parseModernLocalVerificationRequest({ kind: 'verify-local',
      preparation: [{ ...preparation[0], credentials: 'not-accepted' }] })).toThrow();
  });
  it.each([null, [], 'yes', true, {}, { kind: 'approve', scopes }, { kind: 'approve-local-execution', scopes, credentials: {} },
    { kind: 'approve-local-execution', scopes: { ...scopes, network: true } }])('refuses unknown consent %j', value => {
    expect(() => parseModernLocalConsentRequest(value)).toThrow();
  });
  it('does not invoke accessors or retain mutable caller input', () => {
    let invoked = false;
    const object = Object.defineProperty({ preparation: [] }, 'kind', { enumerable: true, get() { invoked = true; return 'verify-local'; } });
    expect(() => parseModernLocalVerificationRequest(object)).toThrow();
    expect(invoked).toBe(false);
    const source = { kind: 'approve-local-execution', scopes: { ...scopes } };
    const parsed = parseModernLocalConsentRequest(source);
    source.scopes.dependencyNetwork = true;
    expect(parsed.scopes.dependencyNetwork).toBe(false);
  });
});

describe('bounded local public files', () => {
  async function file(content: string) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'local-request-'))), stat = await fs.lstat(root);
    roots.push({ path: root, dev: stat.dev, ino: stat.ino });
    const target = path.join(root, 'request.json');
    await fs.writeFile(target, content);
    return target;
  }
  const read = (target: string) => readPublicGovernanceInputs(target, 'Local execution', parseModernLocalVerificationRequest);
  it('admits exactly 64 KiB and rejects 64 KiB plus one before decoding', async () => {
    const text = JSON.stringify({ kind: 'verify-local', preparation: [] }).padEnd(65536, ' ');
    const target = await file(text);
    expect(await read(target)).toEqual({ kind: 'verify-local', preparation: [] });
    await fs.appendFile(target, ' ');
    await expect(read(target)).rejects.toThrow('no larger than 64 KiB');
  });
  it('withholds malformed content and rejects nonregular or multiply linked files', async () => {
    const target = await file('PRIVATE_MALFORMED_CONTENT');
    await expect(read(target)).rejects.toThrow('Local execution inputs are not valid JSON');
    await expect(read(path.dirname(target))).rejects.toThrow();
    const linked = path.join(path.dirname(target), 'linked.json');
    await fs.link(target, linked);
    await expect(read(linked)).rejects.toThrow('singly linked');
  });
  it.skipIf(process.platform === 'win32')('refuses a symbolic public request without reading its target', async () => {
    const target = await file(JSON.stringify({ kind: 'verify-local', preparation: [] }));
    const link = path.join(path.dirname(target), 'link.json');
    await fs.symlink(target, link);
    await expect(read(link)).rejects.toThrow();
  });
});

describe('explicit modern local command grammar', () => {
  it.each([
    ['plan', '--inputs', 'request.json'],
    ['approve', '--plan', fingerprint, '--inputs', 'consent.json'],
    ['apply-next', '--plan', fingerprint],
    ['apply-next', '--plan', fingerprint, '--execute'],
    ['apply-next', '--plan', fingerprint, '--execute=false']
  ])('accepts separately selected %j', (...tail) => {
    expect(parseArgs(['governance', ...tail, '--scope', 'local', '--local-operation', 'verify']).flags['local-operation']).toBe('verify');
  });
  it.each([
    ['status'], ['resume'], ['verify'], ['assess'], ['recover', '--plan', fingerprint],
    ['plan'], ['plan', '--scope', 'activation', '--inputs', 'request.json'],
    ['plan', '--inputs', 'request.json', '--recover-phase', 'local-inputs-valid'],
    ['plan', '--inputs', 'request.json', '--live=false'],
    ['plan', '--inputs', 'request.json', '--protected-stdin=false'],
    ['plan', '--inputs', 'request.json', '--plan', fingerprint],
    ['plan', '--inputs', 'request.json', '--execute=false'],
    ['approve', '--inputs', 'consent.json'], ['approve', '--plan', fingerprint],
    ['apply-next'], ['apply-next', '--plan', fingerprint, '--inputs', 'request.json'],
    ['apply-next', '--plan', 'short'], ['apply-next', '--plan', fingerprint, '--revalidation-publication', fingerprint]
  ])('rejects conflicting or incomplete %j', (...tail) => {
    expect(() => parseArgs(['governance', ...tail, '--scope', 'local', '--local-operation', 'verify'])).toThrow();
  });
  it('rejects unknown operations and missing explicit scope while keeping help project independent', () => {
    expect(() => parseArgs(['governance', 'plan', '--local-operation', 'publish', '--scope', 'local', '--inputs', 'request.json'])).toThrow();
    expect(() => parseArgs(['governance', 'plan', '--local-operation', 'verify', '--inputs', 'request.json'])).toThrow();
    expect(() => parseArgs(['governance', 'plan', '--local-operation', 'verify', '--help'])).not.toThrow();
    expect(() => parseArgs(['governance', 'plan', '--local-operation', 'verify', '--scope', 'local', '--inputs', '   '])).toThrow();
  });
});
