#!/usr/bin/env node
import {
  parseHistoricalVerifierArguments,
  verifyPublishedPackage
} from '../dist/published-verifier.js';

try {
  const options = parseHistoricalVerifierArguments(process.argv.slice(2));
  const result = await verifyPublishedPackage({
    packageRoot: process.cwd(),
    ...options
  });
  const compatibility = result.legacyVersionCommandAllowed ? ' (legacy version-command compatibility)' : '';
  process.stdout.write(
    `Verified historical command and package identity for ${result.name}@${result.version} ` +
    `from ${result.registry} using explicit version ${result.tag}${compatibility}.\n`
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}