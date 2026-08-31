#!/usr/bin/env node
import { verifyPublishedPackage } from '../dist/published-verifier.js';

const args = process.argv.slice(2);
const allowLegacyVersionCommand = args.includes('--allow-legacy-version-command');
const positional = args.filter((arg) => arg !== '--allow-legacy-version-command');

if (positional.length !== 1 || positional[0].startsWith('-')) {
  process.stderr.write(
    'Usage: npm run verify:published -- <dist-tag> [--allow-legacy-version-command]\n'
  );
  process.exitCode = 1;
} else {
  try {
    const result = await verifyPublishedPackage({
      packageRoot: process.cwd(),
      tag: positional[0],
      allowLegacyVersionCommand
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