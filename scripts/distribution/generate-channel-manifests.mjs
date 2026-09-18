#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  inspectFile, loadReleaseContext, loadReleaseContracts, readJsonFile, REQUIRED_NATIVE_TARGETS,
  verifyNativeArtifactFile, verifyNativeManifestFile, verifySourceWorktree
} from '../release-evidence.mjs';
import { createGitHubEvidenceVerifier } from '../release-evidence-github.mjs';
import { assertOwnedOutput, createOwnedOutput, demand, writeJson, writeNew } from './native-build-files.mjs';
import { directArtifactDescriptor, renderHomebrewDefinition, renderWinGetDefinitions } from './channel-definitions.mjs';

export async function generateChannelManifests(options) {
  demand(options && Object.keys(options).every((key) => ['projectRoot', 'evidencePath', 'outputDirectory'].includes(key)), 'Channel preparation accepts verified evidence, not approval booleans or version/checksum defaults');
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  demand(typeof options.evidencePath === 'string' && typeof options.outputDirectory === 'string', 'Explicit evidence and new output paths are required');
  const outputRelative = path.relative(projectRoot, path.resolve(projectRoot, options.outputDirectory)).split(path.sep).join('/');
  demand(outputRelative.startsWith('build/'), 'Channel preparation output must be a new owned build/ directory, not source or installation paths');
  const relative = path.relative(projectRoot, path.resolve(projectRoot, options.evidencePath)).split(path.sep).join('/');
  const evidence = readJsonFile(projectRoot, relative).value;
  demand(evidence.schemaVersion === 1 && evidence.kind === 'liftoff-coordinated-release-evidence', 'Native channel preparation requires versioned release evidence');
  verifySourceWorktree(projectRoot, evidence.sourceCommit);
  const context = await loadReleaseContext(projectRoot, evidence.sourceCommit, await loadReleaseContracts(projectRoot, evidence.sourceCommit));
  const registrations = context.scope.verification?.channels;
  demand(registrations?.homebrewCask?.packageId === context.contracts.native.canonicalHomebrewCask &&
    registrations?.winget?.packageId === context.contracts.native.canonicalWinGetId &&
    registrations?.linuxDirect?.repository === 'voyager163/liftoff', 'Missing exact registered owner-channel identities; no package IDs or publisher authority are inferred');
  const root = path.dirname(path.resolve(projectRoot, relative));
  const verifier = createGitHubEvidenceVerifier({ projectRoot, verification: context.scope.verification, sourceCommit: evidence.sourceCommit });
  const tracked = [];
  const { manifest } = await verifyNativeManifestFile(context, evidence.manifest, root, verifier, tracked);
  demand(Object.keys(evidence.artifacts ?? {}).length === 6, 'All six final signed artifact payloads are required');
  for (const target of REQUIRED_NATIVE_TARGETS) await verifyNativeArtifactFile(context, manifest, target, evidence.artifacts[target], root, verifier, tracked);
  const cask = renderHomebrewDefinition(manifest, registrations.homebrewCask);
  const winget = renderWinGetDefinitions(manifest, registrations.winget);
  const direct = directArtifactDescriptor(manifest);
  for (const file of tracked) inspectFile(root, file.path, file.sha256);
  verifier.assertFresh();
  verifySourceWorktree(projectRoot, evidence.sourceCommit);
  const output = createOwnedOutput(projectRoot, options.outputDirectory);
  writeNew(path.join(output.root, 'liftoff.rb'), cask);
  for (const [kind, content] of Object.entries(winget)) writeNew(path.join(output.root, `${registrations.winget.packageId}.${kind}.yaml`), content);
  writeJson(path.join(output.root, 'direct-artifacts.json'), direct);
  assertOwnedOutput(output);
  return { outputDirectory: output.root, status: 'PREPARED_NOT_PUBLISHED', productionQualified: false,
    remaining: ['actual owner catalog availability', 'all required native/production qualification', 'separate publication approval'] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    demand(args.length === 4 && args[0] === '--evidence' && args[2] === '--output',
      'Usage: generate-channel-manifests.mjs --evidence VERIFIED-INDEX.json --output NEW-BUILD-DIRECTORY');
    const result = await generateChannelManifests({ evidencePath: args[1], outputDirectory: args[3] });
    process.stdout.write(`${result.status}: ${result.outputDirectory}\nNo installation receipt, package submission or publication was performed.\n`);
  } catch (error) {
    process.stderr.write(`CHANNEL_PREPARATION_BLOCKED: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
