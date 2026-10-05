import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/domain/governance/activation/canonical-json.js';
import {
  validateLocalExecutionConsentRecord, validateLocalExecutionPreview, validateLocalExecutionResult,
  type LocalExecutionPreviewV6, type LocalExecutionResultV5
} from '../src/domain/governance/activation/modern-local-runtime.js';
import { manualExecutionWirePreview, manualExecutionWireResult, manualWireTime } from './fixtures/modern-manual-records.js';

function previewDigest(preview: LocalExecutionPreviewV6) {
  const { fingerprint: _digest, ...body } = preview;
  return { ...body, fingerprint: canonicalSha256(body) };
}
function resultDigest(result: LocalExecutionResultV5) {
  const { resultDigest: _digest, ...body } = result;
  return { ...body, resultDigest: canonicalSha256(body) };
}

describe('Manual execution wire codecs, never native qualification or stored authority', () => {
  it.each([1, 2, 3])('round-trips only the internally consistent %i-root wire shape', count => {
    const preview = manualExecutionWirePreview(count), { result, workspace } = manualExecutionWireResult(preview);
    expect(validateLocalExecutionPreview(preview, manualWireTime)).toEqual(preview);
    expect(validateLocalExecutionResult(result, preview, workspace)).toEqual(result);
  });
  it.each(['missing-role', 'widened-role', 'missing-tofu', 'wrong-version', 'wrong-version-map',
    'external-framework', 'standalone-module', 'missing-init', 'missing-validate', 'init-args',
    'validate-args', 'init-cwd', 'validate-cwd', 'init-env', 'validate-env', 'missing-format',
    'format-cwd', 'recursive-format', 'variable-format', 'parent-format'] as const)(
    'rejects a rehashed %s preview', mutation => {
      let preview = manualExecutionWirePreview();
      if (mutation === 'missing-role') preview = { ...preview, outputRoles: [] };
      else if (mutation === 'widened-role') preview = { ...preview, outputRoles: [{ ...preview.outputRoles[0]!, protectedAfterPreparation: true }] };
      else if (mutation === 'missing-tofu') preview = { ...preview, tools: [] };
      else if (mutation === 'wrong-version' || mutation === 'wrong-version-map') {
        const { digest: _digest, ...tool } = preview.tools[0]!;
        const changed = mutation === 'wrong-version' ? { ...tool, version: '1.12.5' } : { ...tool, versions: { tofu: '1.12.5' } };
        preview = { ...preview, tools: [{ ...changed, digest: canonicalSha256(changed) }] };
      } else {
        preview = { ...preview, checks: preview.checks.flatMap(check => {
          if (mutation === 'external-framework' && check.id === 'framework-source') return [{ ...check, status: 'planned' }];
          if (mutation === 'standalone-module' && check.id === 'tofu-validate:opentofu-application') {
            return [{ ...check, status: 'planned', command: { executable: 'tofu', args: ['validate', '-no-color'] } }];
          }
          const init = check.id.startsWith('tofu-initialize:'), validate = check.command && check.id.startsWith('tofu-validate:');
          const format = check.id.startsWith('tofu-format:');
          if (mutation === 'missing-init' && init || mutation === 'missing-validate' && validate || mutation === 'missing-format' && format) return [];
          if (mutation === 'init-args' && init || mutation === 'validate-args' && validate) {
            return [{ ...check, command: { executable: 'tofu', args: [init ? 'init' : 'validate'] } }];
          }
          if (mutation === 'init-cwd' && init || mutation === 'validate-cwd' && validate || mutation === 'format-cwd' && format) {
            return [{ ...check, cwdPathParts: ['unapproved'] }];
          }
          if (mutation === 'init-env' && init || mutation === 'validate-env' && validate) return [{ ...check, env: { TF_INPUT: '1' } }];
          if (format && ['recursive-format', 'variable-format', 'parent-format'].includes(mutation)) {
            const args = mutation === 'recursive-format' ? ['fmt', '-check', '-recursive']
              : ['fmt', '-check', '-write=false', mutation === 'variable-format' ? './secret.tfvars' : './../main.tf'];
            return [{ ...check, command: { executable: 'tofu', args } }];
          }
          return [check];
        }) };
      }
      expect(() => validateLocalExecutionPreview(previewDigest(preview), manualWireTime)).toThrow();
    }
  );
  it('binds Manual consent to both native inputs without accepting old scopes or identity', () => {
    const preview = manualExecutionWirePreview();
    const consent = {
      kind: 'liftoff-local-execution-consent', schemaVersion: 5, projectRoot: preview.projectRoot,
      fingerprint: preview.fingerprint, approvedAt: preview.createdAt, expiresAt: preview.expiresAt,
      manualInputDigest: canonicalSha256(preview.manualInputs),
      scopes: { projectCode: true, hostCapabilitiesAcknowledged: true, dependencyPreparation: false, dependencyNetwork: false,
        infrastructurePreparation: true, infrastructureNetwork: true, workflowFinalization: false, publishLocalRecords: false }
    };
    expect(validateLocalExecutionConsentRecord(preview.projectRoot, preview, consent, manualWireTime)).toEqual(consent);
    expect(() => validateLocalExecutionConsentRecord(preview.projectRoot, preview, { ...consent, schemaVersion: 1 }, manualWireTime)).toThrow();
    expect(() => validateLocalExecutionConsentRecord(preview.projectRoot, preview, { ...consent, manualInputDigest: 'e'.repeat(64) }, manualWireTime)).toThrow();
    for (const field of ['infrastructurePreparation', 'infrastructureNetwork']) {
      expect(() => validateLocalExecutionConsentRecord(preview.projectRoot, preview,
        { ...consent, scopes: { ...consent.scopes, [field]: false } }, manualWireTime)).toThrow();
    }
  });
  it.each(['missing-workspace', 'relative-workspace', 'foreign-workspace', 'wrong-input', 'missing-output',
    'duplicate-output', 'reversed-output', 'wrong-source', 'wrong-tool', 'wrong-environment', 'failed-init', 'early-validation'] as const)(
    'rejects a rehashed %s result', mutation => {
      const preview = manualExecutionWirePreview(2), fixture = manualExecutionWireResult(preview);
      let result = fixture.result, workspace: string | undefined = fixture.workspace;
      if (mutation === 'missing-workspace') workspace = undefined;
      else if (mutation === 'relative-workspace') workspace = preview.operationId;
      else if (mutation === 'foreign-workspace') workspace = path.resolve('not-the-operation');
      else if (mutation === 'failed-init' || mutation === 'early-validation') {
        const init = result.checks.find(check => check.id.startsWith('tofu-initialize:'))!;
        result = { ...result, checks: result.checks.map(check =>
          mutation === 'failed-init' && check.id === init.id ? { ...check, status: 'failed', code: 'nonzero-exit', exitStatus: 1 }
            : mutation === 'early-validation' && check.id === init.id.replace('initialize', 'validate')
              ? { ...check, startedAt: init.startedAt } : check) };
      } else {
        let outputs = result.infrastructure.outputs;
        if (mutation === 'missing-output') outputs = [];
        else if (mutation === 'duplicate-output') outputs = [outputs[0]!, outputs[0]!];
        else if (mutation === 'reversed-output') outputs = [...outputs].reverse();
        else outputs = outputs.map(output => ({
          ...output,
          ...(mutation === 'wrong-source' ? { sourceDigest: '0'.repeat(64) } : {}),
          ...(mutation === 'wrong-tool' ? { toolDigest: '0'.repeat(64) } : {}),
          ...(mutation === 'wrong-environment' ? { environmentDigest: '0'.repeat(64) } : {})
        }));
        result = { ...result, infrastructure: {
          inputDigest: mutation === 'wrong-input' ? '0'.repeat(64) : result.infrastructure.inputDigest, outputs
        } };
      }
      expect(() => validateLocalExecutionResult(resultDigest(result), preview, workspace)).toThrow();
    }
  );
});
