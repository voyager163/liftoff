import type { SupportedStackBaseline } from '../domain/project/supported-stack.js';
import type { ApiProjectPlan } from '../domain/project/contracts.js';

export interface GeneratorTemplateSources {
  npm: Record<'node-backend' | 'frontend', { packageJson: string; packageLock: string }>;
  python: Record<'genai' | 'standard', { pyproject: string; lock: string }>;
  functionRequirements: string;
  go: { module: string; checksum: string };
  opentofu: { versions: string; providerLock: string };
}

export interface GeneratorContext {
  stack: SupportedStackBaseline;
  npm: Record<'node-backend' | 'frontend', { package: string; lock: string }>;
  python: Record<'genai' | 'standard', { project: string; lock: string }>;
  functionsRequirements: string;
  go: { module: string; checksums: string };
  opentofu: { versions: string; providerLock: string };
}

export function createGeneratorContext(
  plan: ApiProjectPlan,
  assets: GeneratorTemplateSources,
  stack: SupportedStackBaseline
): GeneratorContext {
  const backend = `${plan.safeProjectName}-backend`;
  const npm = (id: 'node-backend' | 'frontend', name: string) => {
    const packageTemplate = JSON.parse(assets.npm[id].packageJson);
    const lock = JSON.parse(assets.npm[id].packageLock);
    return {
      package: JSON.stringify({ ...packageTemplate, name }, null, 2),
      lock: JSON.stringify({
        ...lock, name, packages: { ...lock.packages, '': { ...lock.packages[''], name } }
      }, null, 2)
    };
  };
  const python = (id: 'genai' | 'standard') => {
    const placeholder = `liftoff-template-python-${id}`;
    const rename = (content: string) => {
      if (!content.includes(placeholder)) throw new Error(`Packaged ${id} Python template is missing its project-name placeholder.`);
      return content.replaceAll(placeholder, backend);
    };
    return { project: rename(assets.python[id].pyproject), lock: rename(assets.python[id].lock) };
  };
  const goPlaceholder = 'module example.com/liftoff-template-go\n';
  if (!assets.go.module.includes(goPlaceholder)) {
    throw new Error('Packaged Go module template is missing its module placeholder.');
  }
  return {
    stack,
    npm: { 'node-backend': npm('node-backend', backend), frontend: npm('frontend', `${plan.safeProjectName}-frontend`) },
    python: { genai: python('genai'), standard: python('standard') },
    functionsRequirements: assets.functionRequirements,
    go: {
      module: assets.go.module.replace(goPlaceholder, `module example.com/${plan.packageName}/backend\n`),
      checksums: assets.go.checksum
    },
    opentofu: assets.opentofu
  };
}
