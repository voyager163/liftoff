import path from 'node:path';
import { BuildFailure } from './build-tools.mjs';

/** Linux Meson values: admit only the exact declared private-prefix leaves. */
export function validateGnomePrivatePrefixOptions(options, prefix, requirements) {
  const selected = {};
  for (const [name, relative] of Object.entries(requirements)) {
    const expected = path.posix.join(prefix, relative);
    if (options.find((option) => option.name === name)?.value !== expected)
      throw new BuildFailure('gnome-private-pkcs11-path-required');
    selected[name] = expected;
  }
  return selected;
}
