import { describe, expect, it } from 'vitest';
import { assessCheckovScope, parseCheckovScopeOutput, type CheckovInputScope } from '../scripts/repository-security/checkov.ts';

function fixture(https = true): CheckovInputScope {
  return {
    framework: 'terraform',
    files: [
      { pathParts: ['root with spaces', 'main.tf'], content: [
        'variable "https" { type = bool }',
        'module "storage" {',
        '  source = "../modules/storage"',
        '  https = var.https',
        '}'
      ].join('\n') },
      { pathParts: ['modules', 'storage', 'main.tf'], content: [
        'variable "https" { type = bool }',
        'resource "azurerm_storage_account" "fixture" {',
        '  name = "liftofffixture000"',
        '  resource_group_name = "nonfunctional-fixture-group"',
        '  location = "West Europe"',
        '  account_tier = "Standard"',
        '  account_replication_type = "LRS"',
        '  enable_https_traffic_only = var.https',
        '}'
      ].join('\n') }
    ],
    terraformContext: {
      rootDirectory: ['root with spaces'],
      moduleDirectories: [['modules', 'storage']],
      variableFiles: [{ pathParts: ['root with spaces', 'fixture.tfvars'], content: `https = ${https}\n` }]
    }
  };
}
const native = () => [10, 0, 1, 1, 0, 0, 0, 1, [0, 1], [[0, 3, 1, 2, 9, 0, 3]], 1, 0, 1, 1, 1, 1, 1, 1, [1, 1, [0]], [Array(14).fill(0), [], Array(12).fill(0), [], Array(4).fill(0), [[], [], [], []]], []];
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));

describe('explicit Terraform closure evidence', () => {
  it('requires actual variable-file reads alongside the complete declared module files', () => {
    expect(parseCheckovScopeOutput(encode(native()), 0, fixture())).toMatchObject({
      terraformContext: {
        moduleEdges: 1, requiredRootVariables: 1, variableFileReadIndexes: [0], productionValues: false
      }
    });
    for (const proof of [[], [0, 1, [0]], [1, 1, []], [1, 1, [1]], [1, 1, [0, 0]]]) {
      const value: unknown[] = native(); value[18] = proof;
      expect(() => parseCheckovScopeOutput(encode(value), 0, fixture())).toThrow();
    }
  });

  it.each(['outside-root', 'module-alias', 'missing-module', 'variable-alias', 'wrong-variable-root', 'wrong-variable-type'])(
    'rejects unsafe %s declarations',
    variant => {
      const scope = fixture(), context = scope.terraformContext!;
      if (variant === 'outside-root') context.rootDirectory = ['..', 'outside'];
      if (variant === 'module-alias') context.moduleDirectories.push(['MODULES', 'storage']);
      if (variant === 'missing-module') context.moduleDirectories = [];
      if (variant === 'variable-alias') context.variableFiles.push(context.variableFiles[0]!);
      if (variant === 'wrong-variable-root') context.variableFiles[0]!.pathParts = ['modules', 'storage', 'fixture.tfvars'];
      if (variant === 'wrong-variable-type') context.variableFiles[0]!.pathParts = ['root with spaces', '.checkov.yaml'];
      expect(() => parseCheckovScopeOutput(encode(native()), 0, scope)).toThrow();
    }
  );

  it.each([
    [7, 'unresolved-variables'], [8, 'unregistered-module'], [9, 'invalid-local-closure']
  ])('retains bounded preflight failure %s without content', (code, reason) => {
    expect(() => parseCheckovScopeOutput(encode([0, code]), 2, fixture())).toThrow(String(reason));
  });
});

it.runIf(process.env.LIFTOFF_REAL_CHECKOV_CLOSURE === '1')(
  'qualifies real local-module/tfvars evaluation and denies unresolved or external inputs',
  async () => {
    const parent = process.env.LIFTOFF_SECURITY_WORKSPACE_PARENT;
    if (!parent) throw new Error('Explicit registered external workspace parent required.');
    for (const secure of [true, false]) {
      const result = await assessCheckovScope(process.cwd(), '/opt/homebrew/bin/checkov', fixture(secure), parent);
      expect(result.analysisComplete).toBe(true);
      expect(result.results.find(item => item.rule === 'CKV_AZURE_3')?.status).toBe(secure ? 'passed' : 'failed');
      expect(result.terraformContext).toMatchObject({
        moduleEdges: 1, requiredRootVariables: 1, variableFileReadIndexes: [0], productionValues: false
      });
    }
    const missing = fixture();
    missing.terraformContext!.variableFiles[0]!.content = '# Explicitly missing nonfunctional binding.\n';
    await expect(assessCheckovScope(process.cwd(), '/opt/homebrew/bin/checkov', missing, parent))
      .rejects.toThrow('unresolved-variables');
    const external = fixture();
    external.files[0]!.content = external.files[0]!.content.replace('../modules/storage', 'https://example.invalid/not-contacted');
    await expect(assessCheckovScope(process.cwd(), '/opt/homebrew/bin/checkov', external, parent))
      .rejects.toThrow('unregistered-module');
  }, 180_000
);
