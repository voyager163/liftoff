import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const moduleUrl = new URL('../scripts/standard-node-template-runtime.mjs', import.meta.url).href;
const nodePath = process.execPath;
const npmCliPath = path.join(path.dirname(nodePath), 'npm', 'bin', 'npm-cli.js');

function resolve(env: Record<string, string | undefined>) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { resolveTemplateRuntime } from ${JSON.stringify(moduleUrl)};
    process.stdout.write(JSON.stringify(resolveTemplateRuntime(${JSON.stringify(env)})));
  `], { encoding: 'utf8', timeout: 15_000 });
}

describe('generated-template runtime boundary', () => {
  it('defaults project execution to the real generator runtime and caller npm CLI', () => {
    const result = resolve({ npm_execpath: npmCliPath });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ nodePath, npmCliPath });
  });

  it('retains both explicitly selected absolute project paths instead of ambient npm', () => {
    const selectedNode = path.join(path.dirname(nodePath), 'node-22');
    const selectedNpm = path.join(path.dirname(nodePath), 'npm-10', 'npm-cli.js');
    const result = resolve({
      npm_execpath: npmCliPath,
      LIFTOFF_TEMPLATE_PROJECT_NODE: selectedNode,
      LIFTOFF_TEMPLATE_PROJECT_NPM: selectedNpm
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ nodePath: selectedNode, npmCliPath: selectedNpm });
  });

  it('propagates the selected project runtime to npm lifecycle scripts rather than ambient generator Node', () => {
    const env = { PATH: 'ambient-generator-bin', RETAINED: 'kept' };
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { templateRuntimeEnvironment } from ${JSON.stringify(moduleUrl)};
      process.stdout.write(JSON.stringify(templateRuntimeEnvironment(
        ${JSON.stringify({ nodePath, npmCliPath })}, ${JSON.stringify(env)}
      )));
    `], { encoding: 'utf8', timeout: 15_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      PATH: `${path.dirname(nodePath)}${path.delimiter}${env.PATH}`, RETAINED: 'kept',
      npm_node_execpath: nodePath, npm_execpath: npmCliPath
    });
  });

  it.each(['LIFTOFF_TEMPLATE_PROJECT_NODE', 'LIFTOFF_TEMPLATE_PROJECT_NPM'])(
    'refuses a partially configured %s pair rather than silently using ambient paths', field => {
      const result = resolve({ npm_execpath: npmCliPath, [field]: nodePath });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Select both');
      expect(result.stdout).toBe('');
    }
  );

  it.each(['', 'relative/node', `${nodePath}\nunsafe`, `${nodePath}\runsafe`])(
    'rejects invalid project Node path %j', selected => {
      const result = resolve({
        LIFTOFF_TEMPLATE_PROJECT_NODE: selected, LIFTOFF_TEMPLATE_PROJECT_NPM: npmCliPath
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('absolute, single-line Node executable');
      expect(result.stdout).toBe('');
    }
  );

  it.each([undefined, '', 'relative/npm-cli.js', `${npmCliPath}\nunsafe`])(
    'rejects an unavailable or malformed default npm CLI %j', selected => {
      const result = resolve({ npm_execpath: selected });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('absolute, single-line npm CLI');
      expect(result.stdout).toBe('');
    }
  );
});
