import type { CommandResult } from '../../process-runner.js';
import { windowsWorkingDirectoryErrorCode } from '../../domain/execution/windows-working-directory.js';
import {
  applicationCommandFailure, applicationDiagnosticMatches, type ApplicationCommandFailure
} from './application-diagnostics.js';
import type { ApplicationResolvedPreparation } from './application-preparation-types.js';
import type { ApplicationVerificationCommand } from './application-types.js';

export function applicationPreparationFailure(
  preparation: ApplicationResolvedPreparation, command: ApplicationVerificationCommand, result: CommandResult
): ApplicationCommandFailure | null {
  const ordinary = applicationCommandFailure(command, result);
  if (!ordinary) return null;
  if (['timed-out', 'output-limit', 'interrupted', 'termination-unconfirmed', 'missing-executable'].includes(ordinary.kind) ||
      ['RESTRICTED_EXECUTION_POLICY', 'CONSTRAINED_LANGUAGE_MODE', 'CORRUPTED_CONTROLLER_ASSET', 'POWERSHELL_SPAWN_FAILED',
        windowsWorkingDirectoryErrorCode].includes(result.errorCode ?? '')) {
    return ordinary;
  }
  const matches = (pattern: RegExp) => applicationDiagnosticMatches(result, command.maxOutputBytes, pattern);
  const message = (text: string): ApplicationCommandFailure => ({ kind: 'missing-dependencies', cleanupUnsafe: false, message: text });
  if (matches(/\b(?:ENOTCACHED|only-if-cached|not found in (?:the )?cache|Network connectivity is disabled|module lookup disabled by GOPROXY)\b/iu)) {
    return message('[private-cache-miss] Frozen preparation cannot obtain a required package from the fresh private cache with the current network scope. No ambient cache or network fallback is permitted; request a fresh separately approved network/preparation scope if needed.');
  }
  if (matches(/\b(?:lockfile needs to be updated|lock file needs to be updated|No lockfile found|can only install packages when|package-lock\.json.*in sync|updates to go\.mod needed|missing go\.sum entry)\b/iu)) {
    return message('[mismatched-lock] The provider could not consume the exact candidate manifest/lock inputs without changes. Correct the externally reviewed inputs and request a fresh plan; no lock generation, upgrade, or silent resolution fallback is permitted.');
  }
  if (matches(/\b(?:no wheels|no compatible wheel|source distributions? (?:are|is) disabled|Building source distributions is disabled|failed to build|has no source distribution or wheel|could not find.*esbuild|installed esbuild.*another platform)\b/iu)) {
    return message('[unsupported-build-hook] Required locked wheel/prebuilt artifacts are unavailable with source builds and install hooks suppressed. This provider cannot enable unsupported hooks; review the locked platform support rather than treating failed preparation as success.');
  }
  if (matches(/\b(?:E401|E403|401 Unauthorized|403 Forbidden|authentication required|credentials required)\b/iu)) {
    return message('[unsupported-package-source] A package source requested authentication or denied access. Only the selected credential-free public source is supported; no credentials, user configuration, or helper may be inherited.');
  }
  if (preparation.provider === 'uv-locked-sync') {
    return message('[python-preparation-failed] Locked wheel-only Python preparation failed. Review compatible wheel availability, exact pyproject/uv.lock pins and the selected public index. Interpreter downloads, source builds, and root-project installation remain disabled; private diagnostics are withheld.');
  }
  if (preparation.provider === 'go-mod-download') {
    return message('[go-preparation-failed] Go module preparation failed with the approved local toolchain and private caches. Review exact go.mod/go.sum inputs and declared proxy availability; no toolchain download or checksum/module update is allowed.');
  }
  return message('[npm-preparation-failed] Frozen npm ci failed for the exact candidate package/lock and selected public registry. Review lock consistency, package availability and supported suppressed-hook behavior; no ordinary npm install, global installation, or live dependency reuse is authorized.');
}
