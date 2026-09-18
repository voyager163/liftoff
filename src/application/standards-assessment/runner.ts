import path from 'node:path';
import type {
  AssessmentDiagnostic,
  AssessmentFinding,
  AssessmentInventory,
  AssessmentResult,
  AssessmentTarget,
  AssessProjectOptions,
  StandardsProfileIdentity
} from '../../domain/standards-assessment/types.js';
import { containsSensitiveText, sanitizeText } from '../../domain/standards-assessment/sanitizer.js';
import { evaluateProfileRules } from '../../domain/standards-assessment/evaluation.js';
import { calculateCoverage, determineOutcomeAndExitCode } from '../../domain/standards-assessment/outcomes.js';
import { makeUnresolvedProfile } from '../../domain/standards-assessment/catalog.js';
import { resolveAssessmentTargetSnapshot, type AssessmentTargetSnapshot } from '../../adapters/filesystem/standards-assessment/boundary.js';
import { scanInventorySnapshot, type InventorySnapshot } from '../../adapters/filesystem/standards-assessment/scanner.js';
import { extractEvidence } from '../../adapters/filesystem/standards-assessment/evidence.js';
import { AssessmentError } from '../../adapters/filesystem/standards-assessment/errors.js';
import { captureInputsFile, recheckCapturedInputs, type CapturedInputsResult } from '../../adapters/filesystem/standards-assessment/inputs.js';
import { resolveTargetProfile } from './profile-resolver.js';
import { generateRecommendations } from './recommendations.js';
import { liftoffVersion } from '../../version.js';
import { publicProtocolSchemaVersion } from '../../protocol/schema.js';

function assessmentFailure(error: unknown): { code: string; message: string } {
  return {
    code: error instanceof AssessmentError ? error.code : 'ASSESSMENT_ERROR',
    message: sanitizeText(error instanceof Error ? error.message : 'Assessment could not safely complete.', 1024)
  };
}

export async function assessProject(
  input: AssessProjectOptions = {}
): Promise<AssessmentResult> {
  const invocationCwd = path.resolve(input.invocationCwd ?? process.cwd());
  const options: AssessProjectOptions = {
    ...input, invocationCwd,
    targetPath: path.resolve(invocationCwd, input.targetPath ?? input.projectRoot ?? '.'),
    ...(input.projectRoot ? { projectRoot: path.resolve(invocationCwd, input.projectRoot) } : {})
  };
  const now = new Date().toISOString();
  const observedAt = options.capturedClock ?? now;
  if (!Number.isFinite(Date.parse(observedAt)) || new Date(observedAt).toISOString() !== observedAt) {
    return makeErrorResult(options, now, 'INVALID_OBSERVATION_CLOCK', 'Observation clock must be a canonical UTC ISO timestamp.');
  }
  if ([options.targetPath, options.projectRoot, options.componentPath, options.profile, options.inputsPath]
    .some((value) => value !== undefined && containsSensitiveText(value))) {
    return makeErrorResult(options, observedAt, 'PROTECTED_INPUT', 'A credential-bearing input was withheld before filesystem observation.');
  }
  let capturedInputs: { reference: string; digest: string } | undefined;
  let capturedInputsResult: CapturedInputsResult | undefined;

  if (options.inputsPath) {
    try {
      capturedInputsResult = await captureInputsFile(
        options.inputsPath,
        options.invocationCwd ?? process.cwd()
      );
      capturedInputs = {
        reference: capturedInputsResult.reference,
        digest: capturedInputsResult.digest
      };
    } catch (error) {
      const err = assessmentFailure(error);
      return makeErrorResult(
        options,
        observedAt,
        err.code,
        err.message
      );
    }
  }

  let target: AssessmentTarget;
  let targetSnapshot: AssessmentTargetSnapshot;
  try {
    targetSnapshot = await resolveAssessmentTargetSnapshot({
      targetPath: input.targetPath === undefined ? undefined : options.targetPath,
      projectRoot: options.projectRoot,
      componentPath: options.componentPath,
      invocationCwd
    });
    target = targetSnapshot.target;
  } catch (error) {
    const err = assessmentFailure(error);
    return makeErrorResult(
      options,
      observedAt,
      err.code,
      err.message,
      capturedInputs
    );
  }

  let inventory: AssessmentInventory;
  let snapshot: InventorySnapshot;
  try {
    snapshot = await scanInventorySnapshot(target.scanRoot, {
      maxFiles: options.maxFiles,
      maxFileSize: options.maxFileSize,
      maxDepth: options.maxDepth,
      maxScanBytes: options.maxScanBytes,
      scanTimeoutMs: options.scanTimeoutMs
    });
    inventory = snapshot.inventory;
  } catch (error) {
    const err = assessmentFailure(error);
    return makeErrorResult(
      options,
      observedAt,
      err.code,
      err.message,
      capturedInputs,
      target
    );
  }

  try {
    const evidence = extractEvidence(target, inventory);
    const { profile, observedProfiles, diagnostics } = resolveTargetProfile(target, inventory, options.profile);
    let findings: AssessmentFinding[] = profile.status === 'supported'
      ? evaluateProfileRules(profile, target, inventory, evidence) : [];
    let coverage = calculateCoverage(profile, findings);
    const recommendations = inventory.unobserved.length || inventory.limits.exceeded ? [] : generateRecommendations({
      target, profile, observedProfiles, findings,
      inputsReference: capturedInputs?.reference, inputsDigest: capturedInputs?.digest,
      invocationCwd: options.invocationCwd, diagnostics
    });

    await targetSnapshot.assertCurrent();
    if (capturedInputsResult) {
      await recheckCapturedInputs(capturedInputsResult.reference, capturedInputsResult.metadata);
    }
    const observationCurrent = await snapshot.assertCurrent();
    if (!observationCurrent) {
      recommendations.length = 0;
      findings = findings.map((finding) => ({
        ...finding, classification: 'unknown',
        observed: {
          facts: { snapshotCurrent: false }, references: [],
          limitations: ['The final bounded snapshot recheck is incomplete; collected source facts are not current proof.']
        }
      }));
      coverage = calculateCoverage(profile, findings);
      diagnostics.push({
        code: 'ASSESSMENT_SNAPSHOT_INCOMPLETE', severity: 'warning',
        message: 'The bounded snapshot could not be fully rechecked. Source recommendations are withheld.'
      });
    }
    const { outcome, exitCode } = determineOutcomeAndExitCode(profile, coverage, diagnostics, inventory.unobserved.length);
    for (const diagnostic of diagnostics) diagnostic.message = sanitizeText(diagnostic.message, 1024);
    diagnostics.sort((a, b) => a.code.localeCompare(b.code));
    recommendations.sort((a, b) => a.id.localeCompare(b.id));
    const publicInventory = { ...inventory };
    delete publicInventory.contentMap;

    const result: AssessmentResult = {
      schemaVersion: 1, command: 'assess', cliVersion: liftoffVersion,
      capabilityProtocolSchemaVersion: publicProtocolSchemaVersion,
      target, profile, observedProfiles: observationCurrent ? observedProfiles : [],
      ...(capturedInputs ? { capturedInputs } : {}),
      observedAt, inventory: publicInventory, findings, diagnostics, coverage, recommendations, outcome, exitCode
    };
    if (containsSensitiveText(JSON.stringify(result))) {
      return makeErrorResult(options, observedAt, 'PROTECTED_OBSERVATION',
        'Credential-bearing observation data was withheld before retention.', capturedInputs, target);
    }
    return result;
  } catch (error) {
    const failure = assessmentFailure(error);
    return makeErrorResult(options, observedAt, failure.code, failure.message, capturedInputs, target);
  }
}

function makeErrorResult(
  options: AssessProjectOptions,
  observedAt: string,
  code: string,
  message: string,
  capturedInputs?: { reference: string; digest: string },
  partialTarget?: AssessmentTarget
): AssessmentResult {
  const basePath = options.targetPath ?? options.projectRoot ?? process.cwd();
  const observedTarget: AssessmentTarget = partialTarget ?? {
    targetPath: path.resolve(basePath),
    projectRoot: path.resolve(options.projectRoot ?? basePath),
    repositoryRoot: null,
    componentPath: options.componentPath ?? null,
    scanRoot: path.resolve(basePath),
    hasGit: null,
    hasManifest: null,
    manifestVersion: null
  };
  const target: AssessmentTarget = {
    ...observedTarget,
    targetPath: sanitizeText(observedTarget.targetPath, 4096),
    projectRoot: sanitizeText(observedTarget.projectRoot, 4096),
    scanRoot: sanitizeText(observedTarget.scanRoot, 4096),
    repositoryRoot: observedTarget.repositoryRoot === null ? null : sanitizeText(observedTarget.repositoryRoot, 4096),
    componentPath: observedTarget.componentPath === null ? null : sanitizeText(observedTarget.componentPath, 4096),
    ...(observedTarget.manifestPath ? { manifestPath: sanitizeText(observedTarget.manifestPath, 4096) } : {})
  };

  const profile: StandardsProfileIdentity = makeUnresolvedProfile();

  const emptyInventory: AssessmentInventory = {
    summary: {
      totalFiles: 0,
      totalBytes: 0,
      byCategory: {
        source: 0,
        declarations: 0,
        locks: 0,
        tests: 0,
        build: 0,
        config: 0,
        docs: 0,
        containers: 0,
        infrastructure: 0,
        workflows: 0,
        framework: 0,
        agent: 0,
        provenance: 0
      }
    },
    files: [],
    unobserved: [],
    limits: {
      maxFiles: 5000,
      maxFileSize: 2 * 1024 * 1024,
      maxDepth: 15,
      exceeded: false
    },
    protectedExclusions: []
  };

  const diagnostics: AssessmentDiagnostic[] = [
    {
      code,
      severity: 'error',
      message: sanitizeText(message, 1024)
    }
  ];

  return {
    schemaVersion: 1,
    command: 'assess',
    cliVersion: liftoffVersion,
    capabilityProtocolSchemaVersion: publicProtocolSchemaVersion,
    target,
    profile,
    observedProfiles: [],
    ...(capturedInputs ? { capturedInputs } : {}),
    observedAt,
    inventory: emptyInventory,
    findings: [],
    diagnostics,
    coverage: {
      declaredRules: 0,
      assessedRules: 0,
      alignedRules: 0,
      differingRules: 0,
      missingRules: 0,
      unsupportedRules: 0,
      unknownRules: 0
    },
    recommendations: [],
    outcome: 'error',
    exitCode: 1
  };
}
