import path from 'node:path';
import type {
  AssessmentDiagnostic,
  AssessmentFinding,
  AssessmentRecommendation,
  AssessmentTarget,
  StandardsProfileIdentity
} from '../../domain/standards-assessment/types.js';
import { containsSensitiveText } from '../../domain/standards-assessment/sanitizer.js';
import { createStructuredContinuation } from '../../protocol/continuation.js';
import { resolveCapability } from '../engine-composition.js';
import { canonicalSha256 } from '../../domain/governance/activation/canonical-json.js';
import { getRuleDefinition } from '../../domain/standards-assessment/rules.js';
import type { CommandSchemaDescriptor } from '../../protocol/capabilities.js';
import { liftoffVersion } from '../../version.js';

interface RecommendationContext {
  target: AssessmentTarget;
  profile: StandardsProfileIdentity;
  observedProfiles?: StandardsProfileIdentity[];
  findings: readonly AssessmentFinding[];
  inputsReference?: string;
  inputsDigest?: string;
  invocationCwd?: string;
  diagnostics?: AssessmentDiagnostic[];
}

export function generateRecommendations(
  context: RecommendationContext
): AssessmentRecommendation[] {
  const { target, profile, observedProfiles, findings, inputsReference, inputsDigest, diagnostics } = context;
  const rawRecommendations: AssessmentRecommendation[] = [];
  const cwd = path.resolve(context.invocationCwd ?? process.cwd());
  const projectRoot = target.projectRoot;

  if (profile.status === 'unsupported' || profile.status === 'unresolved') {
    return [];
  }

  const hasSupportedObservedSource = observedProfiles?.length === 1 &&
    observedProfiles[0]?.status === 'supported' && observedProfiles[0].id === profile.id;
  const hasUnsupportedOrConflicting = observedProfiles?.some(
    (p) => p.status === 'unsupported' || p.status === 'unresolved'
  );

  const inputs =
    inputsReference && inputsDigest
      ? { reference: inputsReference, digest: inputsDigest }
      : undefined;

  const add = (
    id: string, title: string, capabilityId: string,
    capability: AssessmentRecommendation['capability'], args: string[],
    approval: AssessmentRecommendation['approval'], scope: string,
    extraBlockers: string[] = [], inventoryMode = false
  ) => {
    const installed = resolveCapability(capabilityId);
    if (!installed) {
      const message = `Installed capability '${capabilityId}' is unavailable; no substitute command was invented.`;
      if (!diagnostics) throw new Error(message);
      diagnostics.push({ code: 'RECOMMENDATION_CAPABILITY_UNAVAILABLE', severity: 'warning', message });
      return;
    }
    const blockedReasons = [...extraBlockers];
    if (!installed.supportedPlatforms.some((platform) => platform === process.platform)) {
      blockedReasons.push('The installed capability does not support the current platform.');
    }
    if (capability !== 'governance' && !installed.supportedProfiles.includes(profile.id)) {
      blockedReasons.push('The installed capability does not declare support for the selected profile.');
    }
    if (installed.planner !== 'built-in' || installed.executor !== 'built-in') {
      blockedReasons.push('The required installed planner or executor is unavailable; registry presence does not establish an executable capability.');
    }
    if (inputsReference !== undefined || inputsDigest !== undefined) {
      blockedReasons.push('This command cannot consume the captured --inputs binding. No executable continuation is emitted; the reference and digest remain recorded.');
      diagnostics?.push({
        code: 'COMMAND_INPUTS_UNSUPPORTED', severity: 'info',
        message: `Capability '${capabilityId}' cannot consume the captured inputs. Its recommendation is blocked rather than dropping context.`
      });
    }
    const commandSchema: CommandSchemaDescriptor = installed.commandSchema;
    const compatibility = `sha256:${canonicalSha256({
      cliVersion: liftoffVersion, capabilityId, commandSchema,
      compatibilityIdentities: installed.compatibilityIdentities,
      operation: inventoryMode ? 'inspect-layout' : args.slice(0, capability === 'governance' ? 2 : 1)
    })}`;
    const requiredAuthority = approval === 'required' ? ['separate-preview-invocation'] : [];
    const blocked = blockedReasons.length > 0;
    rawRecommendations.push({
      id, title, capability, capabilityId, engine: installed.owner,
      status: blocked ? 'blocked' : installed.qualificationState === 'qualified' ? 'available' : 'plan-only',
      executable: blocked ? null : 'liftoff', args: blocked ? [] : args,
      cwd, scope, project: projectRoot, ...(inputs ? { inputs } : {}),
      approval, compatibility, commandSchema, qualification: installed.qualificationState,
      requiredAuthority, blockedReasons,
      ...(!blocked ? {
        continuation: createStructuredContinuation({
          executable: 'liftoff', args, cwd, scope, project: projectRoot, targetScope: 'project',
          requiredAuthority, compatibilityIdentity: compatibility
        })
      } : {})
    });
  };

  if (target.hasManifest === false && hasSupportedObservedSource && !hasUnsupportedOrConflicting) {
    const args = ['adopt', '--project', projectRoot, '--profile', profile.id];
    if (target.componentPath) args.push('--component', `.${path.sep}${target.componentPath}`);
    args.push('--check', '--json');
    add('REC-ADOPT-IN-PLACE', 'Review in-place adoption for this observed supported component',
      'project-adoption', 'adopt', args, 'required', 'project-adoption');
  }

  const projectScopeBlockers = target.componentPath
    ? ['The selected component boundary cannot be expressed by this project-wide operation. Broader scope requires a separate explicit selection.']
    : [];
  if (target.hasManifest === true && findings.some((finding) =>
    getRuleDefinition(finding.ruleId)?.applicableScope === 'component' && finding.classification !== 'aligned' &&
    finding.classification !== 'inapplicable')) {
    add('REC-REPAIR-INVENTORY', 'Inspect application layout before proposing any exact repair',
      'project-repair', 'repair', ['repair', projectRoot, '--inspect-layout', '--json'],
      'read-only', 'application-layout', projectScopeBlockers, true);
  }

  if (target.hasManifest === true) {
    add('REC-UPDATE-CHECK', 'Preview managed-core updates without replacing business files',
      'project-update', 'update', ['update', '--project', projectRoot, '--check', '--json'],
      'read-only', 'project-update', projectScopeBlockers);
  }

  if (target.hasGit === true) {
    add('REC-GOVERNANCE-ASSESS', 'Inspect repository governance through its separate read-only capability',
      'governance-assessment', 'governance', ['governance', 'assess', '--project', projectRoot, '--json'],
      'read-only', 'governance-assessment', projectScopeBlockers);
  }

  const validRecommendations: AssessmentRecommendation[] = [];
  for (const rec of rawRecommendations) {
    const jsonStr = JSON.stringify(rec);
    if (containsSensitiveText(jsonStr)) {
      diagnostics?.push({
        code: 'RECOMMENDATION_PAYLOAD_PROTECTED',
        severity: 'warning',
        message: `Recommendation '${rec.id}' omitted because sensitive credentials or keys were detected.`
      });
    } else {
      validRecommendations.push(rec);
    }
  }

  return validRecommendations;
}
