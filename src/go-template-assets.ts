import { readFileSync } from 'node:fs';

const moduleTemplate = readFileSync(
  new URL('../assets/locks/go-backend/go.mod', import.meta.url),
  'utf8'
);
const checksumTemplate = readFileSync(
  new URL('../assets/locks/go-backend/go.sum', import.meta.url),
  'utf8'
);
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
