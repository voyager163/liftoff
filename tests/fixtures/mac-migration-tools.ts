import { chmod, copyFile, cp, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';

export async function copyMacMigrationTools(root: string, npmCli: string, runtime = process.execPath,
  nodeDestination = path.join(root, 'actual tools/bin/node')) {
  const originals = { npm: await realpath(npmCli), node: await realpath(runtime) };
  const tools = path.join(root, 'actual tools');
  await mkdir(path.join(tools, 'bin'), { recursive: true, mode: 0o700 });
  await cp(path.dirname(path.dirname(originals.npm)), path.join(tools, 'npm'), {
    recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false
  });
  const selected = { npm: path.join(tools, 'npm/bin/npm-cli.js'), node: nodeDestination };
  await copyFile(originals.node, selected.node);
  await chmod(selected.node, 0o755);
  await chmod(path.join(tools, 'npm'), 0o700);
  await chmod(path.dirname(selected.npm), 0o700);
  return { ...selected, originals };
}
