import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unlink } from 'node:fs/promises';
import {
  createScopedUserLocalRecordStore, nodeUpdatePreviewFileSystem, ScopedMetadataEnumerationError
} from '../../src/adapters/filesystem/update-previews.js';

const [projectRoot, home, key, recordPath] = process.argv.slice(2);
if (!projectRoot || !home || !key || !recordPath) throw new Error('Exact owned FIFO fixture arguments are required.');
let swapped = false;
const store = createScopedUserLocalRecordStore(projectRoot, 'governance-operation', {
  homedir: home, env: {}, repositoryRoot: projectRoot,
  fileSystem: {
    ...nodeUpdatePreviewFileSystem,
    async openFile(path, access, mode) {
      if (path === recordPath && access === 'read' && !swapped) {
        swapped = true;
        await unlink(path);
        await promisify(execFile)('/usr/bin/mkfifo', ['-m', '600', path], { timeout: 1000, killSignal: 'SIGKILL' });
      }
      return nodeUpdatePreviewFileSystem.openFile(path, access, mode);
    }
  }
});
try {
  await store.readAll({ timeoutMs: 1000 });
  throw new Error('FIFO substitution was accepted.');
} catch (error) {
  if (!(error instanceof ScopedMetadataEnumerationError) || !swapped || error.reason === 'timeout') throw error;
  process.stdout.write(JSON.stringify({ blocked: true, reason: error.reason, substituted: 'owned-fifo' }));
}
