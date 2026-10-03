import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { transformSync } from 'rolldown/utils';

const sourceRoot = new URL('../../src/', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(sourceRoot) && specifier.endsWith('.js')) {
      return nextResolve(new URL(specifier.slice(0, -3) + '.ts', context.parentURL).href, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) {
      return {
        format: 'module', shortCircuit: true,
        source: transformSync(url, readFileSync(new URL(url), 'utf8'), { lang: 'ts' }).code
      };
    }
    return nextLoad(url, context);
  }
});
