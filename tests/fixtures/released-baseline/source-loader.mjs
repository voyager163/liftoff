import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformSync } from 'rolldown/utils';

export function loadReleasedSource(directory) {
  const root = pathToFileURL(`${path.resolve(directory)}${path.sep}`);
  const loaded = new Set(['package.json']);
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL?.startsWith(root.href) && specifier.startsWith('.') && specifier.endsWith('.js')) {
        return nextResolve(new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL).href, context);
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url.startsWith(root.href) && url.endsWith('.ts')) {
        loaded.add(path.relative(directory, fileURLToPath(url)).split(path.sep).join('/'));
        return {
          format: 'module',
          shortCircuit: true,
          source: transformSync(url, readFileSync(new URL(url), 'utf8'), { lang: 'ts' }).code
        };
      }
      return nextLoad(url, context);
    }
  });
  return {
    loaded,
    import: (relative) => import(new URL(relative, root).href)
  };
}
