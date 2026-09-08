import { packagedTemplateAssets } from './adapters/packaged-assets/template-assets.js';

const moduleTemplate = packagedTemplateAssets.go.module;
const checksumTemplate = packagedTemplateAssets.go.checksum;
const modulePlaceholder = 'example.com/liftoff-template-go';

export function renderGoModuleAsset(moduleName: string): string {
  if (!moduleTemplate.includes(`module ${modulePlaceholder}\n`)) {
    throw new Error('Packaged Go module template is missing its module placeholder.');
  }
  return moduleTemplate.replace(`module ${modulePlaceholder}\n`, `module ${moduleName}\n`);
}

export function renderGoChecksumAsset(): string {
  return checksumTemplate;
}
