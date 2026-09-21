import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assessCheckovScope, parseCheckovScopeOutput, type CheckovInputScope
} from '../scripts/repository-security/checkov.ts';

const scope: CheckovInputScope = {
  framework: 'terraform',
  files: [{ pathParts: ['folder with spaces', 'main.tf'], content: 'resource "azurerm_storage_account" "fixture" {\n}\n' }]
};
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
const success = () => [11, 0, 1, 1, 0, 0, 0, 1, [0], [[0, 3, 0, 1, 2, 0, 3]], 1, 0, 1, 1, 1, 1, 1, 1, [], [Array(14).fill(0), [], Array(12).fill(0), [], Array(4).fill(0), [[], [], [], []], Array(4).fill(0), [[], [], [], []]], []];

describe('registered Checkov scope projection', () => {
  it('binds complete native parsing and check results without emitting resource values or excerpts', () => {
    expect(parseCheckovScopeOutput(encode(success()), 0, scope)).toMatchObject({
      framework: 'terraform', analysisComplete: true, resources: 1, passed: 1, failed: 0,
      results: [{ rule: 'CKV_AZURE_3', fileIndex: 0, line: 1, endLine: 2, status: 'passed' }],
      files: [{ pathParts: ['folder with spaces', 'main.tf'] }], skipped: 0, parsingErrors: 0
    });
  });

  it('retains a native failed rule separately from successful complete parsing', () => {
    const value = success();
    value[3] = 0; value[4] = 1; value[9] = [[1, 1, 0, 1, 2, 1, 3]]; value[11] = 1;
    expect(parseCheckovScopeOutput(encode(value), 1, scope)).toMatchObject({
      analysisComplete: true, passed: 0, failed: 1,
      results: [{ rule: 'CKV2_AZURE_1', status: 'failed' }]
    });

  });

  it.each([
    ['old schema', 10, [Array(14).fill(0), [], Array(12).fill(0), [], Array(4).fill(0), [[], [], [], []]]],
    ['missing default facts', 11, [Array(14).fill(0), [], Array(12).fill(0), [], Array(4).fill(0), [[], [], [], []], [], [[], [], [], []]]],
    ['invented defaults', 11, [Array(14).fill(0), [], Array(12).fill(0), [], Array(4).fill(0), [[], [], [], []], [2, 0, 0, 0], [[], [], [], []]]],
    ['unbound provider', 11, [Array(14).fill(0), [], Array(12).fill(0), [], Array(4).fill(0), [[], [], [], []], [1, 0, 0, 0], [[], [], [], []]]],
    ['wrong rule index', 11, [Array(14).fill(0), [], Array(12).fill(0), [], Array(4).fill(0), [[], [], [], []], Array(4).fill(0), [[0], [], [], []]]],
    ['duplicate rule index', 11, [Array(14).fill(0), [], Array(12).fill(0), [], Array(4).fill(0), [[], [], [], []], Array(4).fill(0), [[0, 0], [], [], []]]]
  ])('rejects %s as provider-default evidence', (_name, schema, roles) => {
    const value: unknown[] = success();
    value[0] = schema; value[19] = roles;
    expect(() => parseCheckovScopeOutput(encode(value), 0, scope)).toThrow();
  });

  it.each([
    ['missing parse coverage', 8, []],
    ['duplicate parse coverage', 8, [0, 0]],
    ['unknown file', 8, [1]],
    ['skipped inline policy', 5, 1],
    ['parse error', 6, 1],
    ['native error', 7, 0],
    ['no applicable resource checks', 9, []],
    ['unregistered rule namespace', 9, [[3, 3, 0, 1, 2, 0]]],
    ['framework rule mismatch', 9, [[2, 3, 0, 1, 2, 0]]],
    ['outside location', 9, [[0, 3, 1, 1, 2, 0]]],
    ['outside line', 9, [[0, 3, 0, 1, 999, 0]]],
    ['suppressed native result', 9, [[0, 3, 0, 1, 2, 2]]],
    ['wrong result accounting', 9, [[0, 3, 0, 1, 2, 1]]],
    ['unsafe metadata', 9, [[0, 'NONFUNCTIONAL_CHECKOV_SCOPE_SENTINEL', 0, 1, 2, 0]]],
    ['unregistered write', 14, 101],
    ['extra grammar cache', 13, 2],
    ['forged resource coverage', 10, 2],
    ['missing resource coverage', 10, 0],
    ['invented closure proof', 18, [0, 1, []]],
    ['untrusted role text', 19, ['telemetry-approved']],
    ['missing role predicates', 19, []]
  ])('rejects %s without a success-shaped fallback', (_label, index, replacement) => {
    const value: unknown[] = success();
    value[Number(index)] = index === 9 && Array.isArray(replacement)
      ? replacement.map(row => Array.isArray(row) ? [...row, 3] : row)
      : replacement;
    expect(() => parseCheckovScopeOutput(encode(value), 0, scope)).toThrow();
  });

  it('does not confuse parsed resource-free configuration with resource security coverage', () => {
    const value = success();
    value[2] = 0; value[3] = 0; value[9] = []; value[10] = 0;
    expect(parseCheckovScopeOutput(encode(value), 0, scope)).toMatchObject({
      analysisComplete: true, resources: 0, passed: 0, failed: 0, results: []
    });
    value[8] = [];
    expect(() => parseCheckovScopeOutput(encode(value), 0, scope)).toThrow('incomplete-analysis');
  });

  it('classifies only the exact catalogue provider-support bytes as resource-inapplicable', async () => {
    const parts = ['assets', 'locks', 'opentofu-azure', 'versions.tf'];
    const support: CheckovInputScope = { framework: 'terraform',
      files: [{ pathParts: parts, content: await readFile(path.join(process.cwd(), ...parts), 'utf8') }] };
    const output = success();
    output[2] = 0; output[3] = 0; output[9] = []; output[10] = 0;
    expect(parseCheckovScopeOutput(encode(output), 0, support)).toMatchObject({
      resources: 0, checkedResources: 0, resourceApplicabilityQualified: true,
      resourceApplicabilityBasis: 'inapplicable-catalogue-provider-support-only'
    });
    support.files[0]!.content = '\n';
    expect(parseCheckovScopeOutput(encode(output), 0, support).resourceApplicabilityQualified).toBe(false);
    support.files[0]!.pathParts = ['not-a-catalogue-file.tf'];
    expect(parseCheckovScopeOutput(encode(output), 0, support).resourceApplicabilityQualified).toBe(false);
  });

  it('requires the explicit pinned Dockerfile rule inventory, not resource counts alone', () => {
    const docker: CheckovInputScope = {
      framework: 'dockerfile', files: [{ pathParts: ['fixture', 'Dockerfile'], content: 'FROM scratch\nUSER 1000\n' }]
    };
    const output = success();
    output[1] = 1; output[3] = 9;
    output[9] = [1, 2, 3, 5, 7, 8, 9, 10, 11].map(rule => [2, rule, 0, 1, 2, 0, 3]);
    expect(parseCheckovScopeOutput(encode(output), 0, docker)).toMatchObject({
      resourceApplicabilityQualified: true, resourceApplicabilityBasis: 'pinned-native-dockerfile-rule-inventory'
    });
    output[3] = 8; output[9] = (output[9] as number[][]).slice(0, 8);
    expect(parseCheckovScopeOutput(encode(output), 0, docker).resourceApplicabilityQualified).toBe(false);
  });

  it('does not equate complete file parsing with checks for every resource', () => {
    const value = success(); value[2] = 10;
    expect(parseCheckovScopeOutput(encode(value), 0, scope)).toMatchObject({
      analysisComplete: true, resources: 10, checkedResources: 1,
      uncheckedResources: 9, resourceApplicabilityQualified: false
    });
  });

  it('preserves the exact catalogue-owned comment example without inventing a resource AST', () => {
    const example: CheckovInputScope = { ...scope, files: [...scope.files, {
      pathParts: ['infrastructure', 'opentofu', 'azure', 'environments', 'dev', 'backend.remote.example.tf'],
      content: '# Explicit non-executable backend example.\n', supportingOnly: true
    }] };
    expect(parseCheckovScopeOutput(encode(success()), 0, example)).toMatchObject({
      parsedFileIndexes: [0], files: [{ supportingOnly: false }, { supportingOnly: true }]
    });
    example.files[1]!.content += 'terraform {}\n';
    expect(() => parseCheckovScopeOutput(encode(success()), 0, example)).toThrow('invalid-input');
    example.files[1]!.content = '# Comment only\n';
    example.files[1]!.pathParts = ['arbitrary.tf'];
    expect(() => parseCheckovScopeOutput(encode(success()), 0, example)).toThrow('invalid-input');
  });

  it('separates Dockerfile parsing and native rule namespaces', () => {
    const docker: CheckovInputScope = {
      framework: 'dockerfile', files: [{ pathParts: ['Dockerfile'], content: 'FROM scratch\nUSER 1000\n' }]
    };
    const value = success(); value[1] = 1; value[9] = [[2, 3, 0, 1, 2, 0, 3]];
    expect(parseCheckovScopeOutput(encode(value), 0, docker).results[0]!.rule).toBe('CKV_DOCKER_3');
  });

  it.each([
    { ...scope, files: [] },
    { ...scope, files: [scope.files[0]!, scope.files[0]!] },
    { ...scope, files: [{ pathParts: ['..', 'outside.tf'], content: 'x' }] },
    { ...scope, files: [{ pathParts: ['C:\\outside.tf'], content: 'x' }] },
    { ...scope, files: [{ pathParts: ['.checkov.yaml'], content: 'skip-check: CKV_AZURE_3' }] },
    { ...scope, files: [{ pathParts: ['main.tf'], content: '' }] }
  ])('rejects unsafe or unsupported input registration %#', invalid => {
    expect(() => parseCheckovScopeOutput(encode(success()), 0, invalid)).toThrow();
  });

  it.each([
    '{"excerpt":"NONFUNCTIONAL_CHECKOV_SCOPE_SENTINEL',
    'NONFUNCTIONAL_CHECKOV_SCOPE_SENTINEL',
    JSON.stringify({ error: 'NONFUNCTIONAL_CHECKOV_SCOPE_SENTINEL' })
  ])('never includes raw scanner or parser contents in errors %#', raw => {
    try { parseCheckovScopeOutput(Buffer.from(raw), 0, scope); }
    catch (error) {
      expect(String(error)).not.toContain('NONFUNCTIONAL_CHECKOV_SCOPE_SENTINEL');
      expect(error).not.toHaveProperty('cause');
      return;
    }
    throw new Error('Untrusted output was accepted.');
  });
});

it.runIf(process.env.LIFTOFF_REAL_CHECKOV_SCOPE === '1')(
  'assesses exact harmless IaC with native all-rule parsing and rejects inline skips',
  async () => {
    const input: CheckovInputScope = { framework: 'terraform', files: [{
      pathParts: ['scope with spaces', 'main.tf'], content: [
        'resource "azurerm_storage_account" "fixture" {',
        '  name = "liftofffixture000"',
        '  resource_group_name = "nonfunctional-fixture-group"',
        '  location = "West Europe"',
        '  account_tier = "Standard"',
        '  account_replication_type = "LRS"',
        '  enable_https_traffic_only = false',
        '}'
      ].join('\n')
    }] };
    const parent = process.env.LIFTOFF_SECURITY_WORKSPACE_PARENT;
    if (!parent) throw new Error('Explicit registered external workspace parent required.');
    const result = await assessCheckovScope(process.cwd(), '/opt/homebrew/bin/checkov', input, parent);
    expect(result.analysisComplete).toBe(true);
    expect(result.results).toContainEqual({
      rule: 'CKV_AZURE_3', fileIndex: 0, line: 1, endLine: 8, status: 'failed', applicability: 'native-selected'
    });
    expect(result).toMatchObject({ policyVerdict: 'not-evaluated', hostedQualification: false, cleanup: 'completed' });
    input.files[0]!.content = input.files[0]!.content.replace(
      '  name', '  #checkov:skip=CKV_AZURE_3:NONFUNCTIONAL_SCOPE_SUPPRESSION\n  name'
    );

    await expect(assessCheckovScope(process.cwd(), '/opt/homebrew/bin/checkov', input, parent))
      .rejects.toThrow('incomplete-analysis');
  }, 180_000
);

it.runIf(process.env.LIFTOFF_REAL_CHECKOV_AZAPI === '1')(
  'qualifies exact AzAPI HTTPS policy applicability, a real block and unknown-version denial',
  async () => {
    const parent = process.env.LIFTOFF_SECURITY_WORKSPACE_PARENT;
    if (!parent) throw new Error('Explicit registered external workspace parent required.');
    const content = await readFile(path.join(process.cwd(), 'security', 'checkov', 'azapi-storage-https.yaml'), 'utf8');
    for (const [apiType, https, applicability] of [
      ['Microsoft.Storage/storageAccounts@2023-05-01', true, 'applicable'],
      ['Microsoft.Storage/storageAccounts@2023-05-01', false, 'applicable'],
      ['Microsoft.Storage/storageAccounts@2023-05-01', null, 'applicable'],
      ['Microsoft.Storage/storageAccounts@2099-01-01', true, 'unsupported-api-version'],
      ['Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01', false, 'outside-resource-role']
    ] as const) {
      const input: CheckovInputScope = {
        framework: 'terraform',
        customPolicies: [{ id: 1, filename: 'azapi-storage-https.yaml', content }],
        files: [{ pathParts: ['scope with spaces', 'main.tf'], content: [
          'resource "azapi_resource" "fixture" {',
          `  type = "${apiType}"`,
          '  name = "nonfunctional-fixture"',
          '  body = { properties = {',
          https === null ? '' : `    supportsHttpsTrafficOnly = ${https}`,
          '  } }',
          '}'
        ].join('\n') }]
      };
      const expectedPass = applicability === 'outside-resource-role' || applicability === 'applicable' && https === true;
      const result = await assessCheckovScope(process.cwd(), '/opt/homebrew/bin/checkov', input, parent);
      expect(result).toMatchObject({
        analysisComplete: true, resources: 1, checkedResources: applicability === 'applicable' ? 1 : 0,
        uncheckedResources: applicability === 'applicable' ? 0 : 1,
        passed: expectedPass ? 1 : 0, failed: expectedPass ? 0 : 1,
        resourceApplicabilityQualified: false,
        customPolicies: [{ rule: 'CKV2_LIFTOFF_1', filename: 'azapi-storage-https.yaml' }]
      });
      expect(result.results).toEqual([{
        rule: 'CKV2_LIFTOFF_1', fileIndex: 0, line: 1, endLine: 7, status: expectedPass ? 'passed' : 'failed',
        applicability
      }]);
    }
  }, 180_000
);
