import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import policy from './release-policy.json' with { type: 'json' };

export function assertNativePublicationEvidence(record, evidence, approvedPolicy = policy) {
  assert.equal(approvedPolicy.repository, record.repository);
  assert.match(approvedPolicy.approvedSigningKeySha256 ?? '', /^[a-f0-9]{64}$/, 'No approved native release signing identity is configured.');
  assert.ok(['darwin-arm64', 'win32-x64', 'linux-x64', 'linux-arm64'].includes(record.target), 'Unsupported native publication target.');
  for (const key of ['repository', 'commit', 'version', 'target', 'manifestSha256', 'inventorySha256']) {
    assert.equal(evidence[key], record[key], `Native qualification ${key} differs.`);
  }
  assert.deepEqual(evidence.files, record.files, 'Signing/qualification is not bound to the exact native artifacts.');
  for (const key of ['minimumHost', 'installerOwnership', 'signing', 'packageNamespace', 'hclSourceCorrespondence']) {
    assert.equal(evidence.qualification[key], true, `Native publication lacks ${key} evidence.`);
    assert.match(evidence.evidenceDigests[key] ?? '', /^[a-f0-9]{64}$/, `Native publication lacks the ${key} evidence artifact.`);
  }
  if (record.target === 'darwin-arm64') {
    assert.equal(evidence.qualification.notarization, true, 'macOS notarization is required.');
    assert.match(evidence.evidenceDigests.notarization ?? '', /^[a-f0-9]{64}$/);
    assert.match(approvedPolicy.homebrew.cask ?? '', /^[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+$/, 'No approved cask namespace.');
    assert.match(approvedPolicy.homebrew.sourceRepository ?? '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
    assert.match(approvedPolicy.homebrew.developerTeamId ?? '', /^[A-Z0-9]{10}$/, 'No approved Developer ID team.');
    assert.equal(evidence.channel.id, approvedPolicy.homebrew.cask);
    assert.equal(evidence.channel.source, approvedPolicy.homebrew.sourceRepository);
    assert.equal(evidence.platformSigningIdentity, approvedPolicy.homebrew.developerTeamId);
  } else if (record.target === 'win32-x64') {
    assert.match(approvedPolicy.winget.packageIdentifier ?? '', /^[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)+$/, 'No approved WinGet ID.');
    assert.match(approvedPolicy.winget.certificateSha256 ?? '', /^[a-f0-9]{64}$/, 'No approved Authenticode certificate.');
    assert.ok(approvedPolicy.winget.publisher && approvedPolicy.winget.installerAppId, 'No approved installer publisher/AppId.');
    assert.equal(evidence.channel.id, approvedPolicy.winget.packageIdentifier);
    assert.equal(evidence.platformSigningIdentity, approvedPolicy.winget.certificateSha256);
  } else {
    assert.match(approvedPolicy.linux.archiveSigningKeySha256 ?? '', /^[a-f0-9]{64}$/, 'No approved Linux archive signing key.');
    assert.equal(evidence.platformSigningIdentity, approvedPolicy.linux.archiveSigningKeySha256);
  }
  return evidence;
}

export function verifyNativeEvidenceSignature(bytes, signature, publicKey, expectedKeySha256) {
  const key = createPublicKey(publicKey);
  assert.equal(key.asymmetricKeyType, 'ed25519', 'Native evidence requires the approved Ed25519 signing algorithm.');
  const der = key.export({ format: 'der', type: 'spki' });
  assert.match(expectedKeySha256 ?? '', /^[a-f0-9]{64}$/, 'Native signing principal is not approved.');
  assert.equal(createHash('sha256').update(der).digest('hex'), expectedKeySha256, 'Native signing principal differs.');
  assert.ok(verify(null, bytes, key, signature), 'Native qualification signature did not verify.');
  return JSON.parse(bytes.toString('utf8'));
}
