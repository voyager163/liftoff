import assert from 'node:assert/strict';
import { types } from 'node:util';

const programAssemblies = new WeakMap();

export async function buildNativeProgram(options) {
  assert.ok(typeof options === 'object' && options !== null && !types.isProxy(options) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(options)), 'Original assembly options must be ordinary data.');
  const allowed = ['output', 'runtimeArchive', 'windowsLauncher', 'npmCli'];
  const fields = Object.getOwnPropertyDescriptors(options);
  assert.ok(Reflect.ownKeys(options).every(key => typeof key === 'string' && allowed.includes(key)) &&
    Object.values(fields).every(field => field.enumerable && Object.hasOwn(field, 'value') &&
      typeof field.value === 'string' && field.value.length > 0),
  'Original assembly accepts only literal build paths, not receipts, callbacks or authority fields.');
  assert.ok(Object.hasOwn(fields, 'output') && Object.hasOwn(fields, 'runtimeArchive'),
    'Original assembly needs its explicit output and runtime archive.');
  const captured = Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.value]));
  captured.npmCli ??= process.env.npm_execpath;
  const producerUrl = new URL('../../scripts/native-bundle.mjs', import.meta.url);
  // Only creation needs the first-party build checkout; installed readers do not load its tooling.
  const { createNativeProgramReader } = await import(producerUrl.href);
  const read = await createNativeProgramReader(captured);
  const reference = Object.freeze({ kind: 'liftoff-original-native-program-assembly' });
  programAssemblies.set(reference, read);
  return reference;
}

export async function readNativeProgramAssembly(reference) {
  assert.ok(typeof reference === 'object' && reference !== null,
    'Only the original in-process assembly reference may be read.');
  const read = programAssemblies.get(reference);
  assert.ok(read, 'Copied, serialized and caller-created assembly references are not original invocations.');
  return read();
}
