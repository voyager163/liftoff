#!/usr/bin/env node
import { verifyReleaseIdentity } from '../dist/release-identity.js';

const args = process.argv.slice(2);
if (args.length > 1 || args[0]?.startsWith('-')) {
  process.stderr.write('Usage: npm run verify:release-identity -- [v<package-version>]\n');
  process.exitCode = 1;
} else {
  try {
    const result = await verifyReleaseIdentity({
      packageRoot: process.cwd(),
      ...(args[0] === undefined ? {} : { releaseTag: args[0] })
    });
    const tagResult = result.releaseTag
      ? ` and Git tag ${result.releaseTag}`
      : ` (expected Git tag ${result.expectedTag})`;
    process.stdout.write(`Verified release identity ${result.name}@${result.version}${tagResult}.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}