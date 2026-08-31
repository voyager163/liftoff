import { readFileSync } from 'node:fs';

export type PythonTemplateId = 'genai' | 'standard';

const templateNames: Record<PythonTemplateId, string> = {
  genai: 'liftoff-template-python-genai',
  standard: 'liftoff-template-python-standard'
};

function readAsset(template: PythonTemplateId, file: string): string {
  return readFileSync(
    new URL(`../assets/locks/python-${template}/${file}`, import.meta.url),
    'utf8'
  );
}

const pyprojectTemplates: Record<PythonTemplateId, string> = {
  genai: readAsset('genai', 'pyproject.toml'),
  standard: readAsset('standard', 'pyproject.toml')
};

const lockTemplates: Record<PythonTemplateId, string> = {
  genai: readAsset('genai', 'uv.lock'),
  standard: readAsset('standard', 'uv.lock')
};
const functionRequirements = readAsset('genai', 'function-requirements.txt');

function render(template: PythonTemplateId, content: string, name: string): string {
  const placeholder = templateNames[template];
  if (!content.includes(placeholder)) {
    throw new Error(`Packaged ${template} Python template is missing its project-name placeholder.`);
  }
  return content.replaceAll(placeholder, name);
}

export function renderPythonPyprojectAsset(
  template: PythonTemplateId,
  name: string
): string {
  return render(template, pyprojectTemplates[template], name);
}

export function renderPythonLock(template: PythonTemplateId, name: string): string {
  return render(template, lockTemplates[template], name);
}

export function renderFunctionRequirementsAsset(): string {
  return functionRequirements;
}
