import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOsvWorkspace, extractOsvGoGraphs } from './osv-fixture.ts';
import { linuxOsvNetworkProbe } from './osv-transport.ts';
import { osvDigest, runOsvBoundary, type OsvGraph } from './osv.ts';
import { SecurityEvidenceError } from './evidence.ts';

export async function qualifyLinuxOsvFixture(options: { repository: string; workspaceParent: string; python: string }) {
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch) ||
      !path.isAbsolute(options.python)) throw new SecurityEvidenceError('osv-linux-fixture-platform');
  const guard = fileURLToPath(new URL('./osv-linux-sandbox.py', import.meta.url));
  const source = await readFile(guard, 'utf8'), workspace = await createOsvWorkspace(options.repository, options.workspaceParent);
  try {
    const environment = { HOME: workspace.root, TMPDIR: workspace.root, PATH: '' };
    await runOsvBoundary({
      executable: options.python, args: ['-I', '-S', '--version'], cwd: workspace.root, env: environment,
      project: value => {
        if (value.trim() !== 'Python 3.14.7') throw new SecurityEvidenceError('osv-linux-fixture-python');
      }
    });
    const denial = await runOsvBoundary({
      ...linuxOsvNetworkProbe(options.python), cwd: workspace.root, env: environment,
      project: value => {
        if (value.trim() !== '{"ipv4":true,"ipv6":true,"unix":true,"ioUring":true,"seccomp":true,"noNewPrivileges":true}') {
          throw new SecurityEvidenceError('osv-network-denial-unproven');
        }
        return { ipv4: true, ipv6: true, unix: true, ioUring: true, seccomp: true, noNewPrivileges: true };
      }
    });
    const graph: OsvGraph = {
      id: 'linux-network-fixture', pathParts: ['fixture.cdx.json'], inputDigest: osvDigest('inert-coordinate-only-fixture'),
      components: [{ name: 'github.com/google/uuid', version: 'v1.6.0', ecosystem: 'Go',
        chains: [['fixture', 'github.com/google/uuid']] }]
    };
    const extraction = await extractOsvGoGraphs(workspace, { fixture: graph }, 'linux-offline-fixture', undefined, options.python);
    if (await readFile(guard, 'utf8') !== source) throw new SecurityEvidenceError('osv-linux-fixture-guard-drift');
    return {
      kind: 'native-linux-osv-network-fixture', platform: `${process.platform}-${process.arch}`,
      guardDigest: osvDigest(source), denial, toolVersion: extraction.version, toolDigest: extraction.binaryDigest,
      extraction: extraction.scopes, cleanup: 'completed',
      advisoryQueries: false, repositoryFindingVerdict: 'not-produced', releaseQualified: false
    };
  } finally { await workspace.cleanup(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== '--python' || args[2] !== '--workspace-parent') {
      throw new SecurityEvidenceError('osv-linux-fixture-arguments');
    }
    console.log(JSON.stringify(await qualifyLinuxOsvFixture({
      repository: process.cwd(), python: args[1]!, workspaceParent: args[3]!
    })));
  } catch (error) {
    console.error(JSON.stringify({
      kind: 'native-linux-osv-network-fixture', qualified: false,
      code: error instanceof SecurityEvidenceError ? error.code : 'osv-linux-fixture-failed'
    }));
    process.exitCode = 1;
  }
}
