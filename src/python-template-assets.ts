import { packagedTemplateAssets } from './adapters/packaged-assets/template-assets.js';

export type PythonTemplateId = 'genai' | 'standard';

const templateNames: Record<PythonTemplateId, string> = {
  genai: 'liftoff-template-python-genai',
  standard: 'liftoff-template-python-standard'
};

const pyprojectTemplates: Record<PythonTemplateId, string> = {
  genai: packagedTemplateAssets.python.genai.pyproject,
  standard: packagedTemplateAssets.python.standard.pyproject
};

const lockTemplates: Record<PythonTemplateId, string> = {
  genai: packagedTemplateAssets.python.genai.lock,
  standard: packagedTemplateAssets.python.standard.lock
};
const functionRequirements = packagedTemplateAssets.functionRequirements;

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
