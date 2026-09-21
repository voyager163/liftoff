import { describe, expect, it } from 'vitest';
import { assessCheckovScope, CheckovFixtureError, parseCheckovScopeOutput, type CheckovInputScope } from '../scripts/repository-security/checkov.ts';
import { composeImageInventory } from '../scripts/repository-security/checkov-driver.ts';

const reference = `example/fixture:1.0@sha256:${'a'.repeat(64)}`;
function fixture(image = reference): CheckovInputScope {
  return {
    framework: 'yaml', compose: { images: [reference], localBuilds: [['.', 'Dockerfile']] },
    files: [{ pathParts: ['docker-compose.yml'], content: [
      'services:', '  backend:', '    build:', '      context: .', '      dockerfile: Dockerfile',
      '  database:', `    image: ${image}`, ''
    ].join('\n') }]
  };
}

describe('declared Compose security inputs', () => {
  it('refuses unqualified image inventories and remote/unregistered local builds', () => {
    for (const input of [
      { ...fixture(), compose: undefined },
      { ...fixture(), compose: { images: ['example:latest'], localBuilds: [['.', 'Dockerfile']] } },
      { ...fixture(), compose: { images: [reference], localBuilds: [['../outside', 'Dockerfile']] } }
    ]) expect(() => parseCheckovScopeOutput(Buffer.from('[]'), 0, input as CheckovInputScope)).toThrow('invalid-input');
    expect(() => composeImageInventory({ containers: {} })).toThrow('image-inventory');
    expect(() => composeImageInventory({ containers: { fixture: { image: 'example', tag: 'latest', digest: `sha256:${'a'.repeat(64)}` } } }))
      .toThrow('image-inventory');
  });
});

it.runIf(process.env.LIFTOFF_REAL_CHECKOV_COMPOSE === '1')(
  'executes native Checkov YAML policy over every Compose service without starting any service',
  async () => {
    const parent = process.env.LIFTOFF_SECURITY_WORKSPACE_PARENT;
    if (!parent) throw new Error('Explicit registered external workspace parent required.');
    for (const [image, failed] of [[reference, 0], ['example/fixture:latest', 1]] as const) {
      const result = await assessCheckovScope(process.cwd(), '/opt/homebrew/bin/checkov', fixture(image), parent).catch(error => {
        if (error instanceof CheckovFixtureError) console.log(JSON.stringify(error.scopeDiagnostic));
        throw error;
      });
      expect(result).toMatchObject({
        framework: 'yaml', analysisComplete: true, passed: 2 - failed, failed,
        compose: { declaredServices: 2, localBuildServices: 1, nativeResourceCount: 0 }
      });
      expect(result.results).toHaveLength(2);
      expect(result.results.every(item => item.rule === 'CKV2_LIFTOFF_6')).toBe(true);
      expect(result.results.filter(item => item.applicability === 'outside-resource-role')).toHaveLength(1);
    }
    const remote = fixture();
    remote.files[0]!.content = remote.files[0]!.content.replace('context: .', 'context: https://example.invalid/not-contacted');
    const blocked = await assessCheckovScope(process.cwd(), '/opt/homebrew/bin/checkov', remote, parent);
    expect(blocked.failed).toBe(1);
    const ignored = fixture();
    ignored.files[0]!.content = ignored.files[0]!.content.replace('  database:', '  database: #checkov:skip=CKV2_LIFTOFF_6:NONFUNCTIONAL_SKIP');
    await expect(assessCheckovScope(process.cwd(), '/opt/homebrew/bin/checkov', ignored, parent))
      .rejects.toThrow('incomplete-analysis');
  }, 240_000
);
