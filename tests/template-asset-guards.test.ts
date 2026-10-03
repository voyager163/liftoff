import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createGeneratorContext, type GeneratorTemplateSources } from '../src/generators/context.js';
import { buildProjectPlan } from '../src/planner.js';
import { builtinAssets } from '../src/plugins/builtin/assets.js';
import { supportedStack } from '../src/supported-stack.js';

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function assetText(id: string): string {
  const asset = builtinAssets.find((candidate) => candidate.id === id);
  if (!asset) throw new Error(`Unknown declared asset ${id}`);
  return readFileSync(path.join(repositoryRoot, ...asset.pathParts), 'utf8');
}

// Checkout texts are injected directly into the generator context. The registry and its integrity
// checks are deliberately not involved: these tests cover only the renderer-side placeholder guards.
function templateSources(): GeneratorTemplateSources {
  return {
    npm: {
      'node-backend': {
        packageJson: assetText('node-backend-package-manifest'),
        packageLock: assetText('node-backend-package-lock')
      },
      frontend: {
        packageJson: assetText('frontend-package-manifest'),
        packageLock: assetText('frontend-package-lock')
      }
    },
    python: {
      genai: { pyproject: assetText('python-genai-project'), lock: assetText('python-genai-lock') },
      standard: { pyproject: assetText('python-standard-project'), lock: assetText('python-standard-lock') }
    },
    functionRequirements: assetText('python-genai-function-requirements'),
    go: { module: assetText('go-backend-module'), checksum: assetText('go-backend-checksums') },
    opentofu: {
      versions: assetText('opentofu-azure-versions'),
      providerLock: assetText('opentofu-azure-provider-lock')
    }
  };
}

const plan = buildProjectPlan({
  projectName: 'Guard Fixture', cloud: 'azure', region: 'eastus', projectType: 'standard', apiStack: 'go'
}, { requireProjectName: true });
const goPlaceholder = 'module example.com/liftoff-template-go\n';

describe('packaged template placeholder guards', () => {
  it('renames both Python projects and the Go module from valid packaged texts', () => {
    const sources = templateSources();
    const context = createGeneratorContext(plan, sources, supportedStack);
    const backend = `${plan.safeProjectName}-backend`;

    for (const id of ['genai', 'standard'] as const) {
      expect(context.python[id].project, id).toContain(`name = "${backend}"`);
      expect(context.python[id].lock, id).toContain(`name = "${backend}"`);
      expect(context.python[id].project, id).not.toContain(`liftoff-template-python-${id}`);
      expect(context.python[id].lock, id).not.toContain(`liftoff-template-python-${id}`);
    }
    expect(context.go.module.startsWith(`module example.com/${plan.packageName}/backend\n`)).toBe(true);
    expect(context.go.module).not.toContain(goPlaceholder);
    expect(context.go.checksums).toBe(sources.go.checksum);
    expect(context.functionsRequirements).toBe(sources.functionRequirements);
  });

  it('refuses a Python project or lock without its project-name placeholder', () => {
    for (const id of ['genai', 'standard'] as const) {
      for (const field of ['pyproject', 'lock'] as const) {
        const sources = templateSources();
        const placeholder = `liftoff-template-python-${id}`;
        expect(sources.python[id][field], `${id} ${field}`).toContain(placeholder);
        sources.python[id][field] = sources.python[id][field].replaceAll(placeholder, 'renamed-elsewhere');
        expect(() => createGeneratorContext(plan, sources, supportedStack), `${id} ${field}`)
          .toThrow(`Packaged ${id} Python template is missing its project-name placeholder.`);
      }
    }
  });

  it('refuses a Go module without its exact LF placeholder line, including CRLF text', () => {
    const missing = templateSources();
    expect(missing.go.module).toContain(goPlaceholder);
    missing.go.module = missing.go.module.replace(goPlaceholder, 'module example.com/other\n');
    expect(() => createGeneratorContext(plan, missing, supportedStack))
      .toThrow('Packaged Go module template is missing its module placeholder.');

    const crlf = templateSources();
    crlf.go.module = crlf.go.module.replaceAll('\n', '\r\n');
    expect(() => createGeneratorContext(plan, crlf, supportedStack))
      .toThrow('Packaged Go module template is missing its module placeholder.');
  });
});
