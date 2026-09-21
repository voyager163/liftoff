#!/usr/bin/env node
import { verifyPublishedPackage } from '../dist/published-verifier.js';

const args = process.argv.slice(2);
const allowLegacyVersionCommand = args.includes('--allow-legacy-version-command');
const integrityIndex = args.indexOf('--expected-integrity');
const expectedIntegrity = integrityIndex === -1 ? undefined : args[integrityIndex + 1];
const positional = args.filter((arg, index) =>
  arg !== '--allow-legacy-version-command' &&
  (integrityIndex === -1 || index !== integrityIndex && index !== integrityIndex + 1)
);

if (positional.length !== 1 || positional[0].startsWith('-') ||
    (integrityIndex !== -1 && (!expectedIntegrity || expectedIntegrity.startsWith('-'))) ||
    args.filter(arg => arg === '--expected-integrity').length > 1) {
  process.stderr.write(
    'Usage: npm run verify:published -- <dist-tag> [--expected-integrity <sha512-value>] [--allow-legacy-version-command]\n'
  );
  process.exitCode = 1;
} else {
  try {
    const result = await verifyPublishedPackage({
      packageRoot: process.cwd(),
      tag: positional[0],
      allowLegacyVersionCommand,
      ...(expectedIntegrity === undefined ? {} : { expectedIntegrity })
    });
    const compatibility = result.legacyVersionCommandAllowed ? ' (legacy version-command compatibility)' : '';
    process.stdout.write(
      `Verified ${result.name}@${result.version} from ${result.registry} using ${result.tag}${compatibility}.\n`
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}