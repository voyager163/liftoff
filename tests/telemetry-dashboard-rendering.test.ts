import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sync as spawnSync } from 'cross-spawn';
import { parse as parseHcl } from '@cdktf/hcl2json';
import { describe, expect, it } from 'vitest';

const sourceRoot = path.resolve('infrastructure/opentofu/telemetry');
const tofuAvailable = spawnSync('tofu', ['version'], { encoding: 'utf8', timeout: 10_000 }).status === 0;

describe('Offline OpenTofu dashboard expression rendering (no providers or Azure observations)', () => {
  it.runIf(tofuAvailable)('renders all real panel/variable bindings deterministically in a literal spaced directory', async () => {
    const root = path.resolve(`tests/.dashboard expression 'literal' ${randomUUID()}`);
    await mkdir(root);
    try {
      const source = await readFile(path.join(sourceRoot, 'dashboard.tf'), 'utf8');
      const parsed = await parseHcl('dashboard.tf', source);
      const locals = { ...parsed.locals[0] };
      // Substitute only the external workspace observation; evaluate the source expression in OpenTofu.
      locals.dashboard_definition_json = locals.dashboard_definition_json.replace(
        'azurerm_log_analytics_workspace.telemetry.id', 'var.workspace_id'
      );
      const workspace = '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/fixture/providers/Microsoft.OperationalInsights/workspaces/fixture';
      await writeFile(path.join(root, 'main.tf.json'), JSON.stringify({
        variable: {
          workspace_id: { type: 'string', default: workspace },
          resource_suffix: { type: 'string', default: 'fixture' },
          dashboard_name: { type: 'string', default: '' }
        },
        locals
      }));
      const model = await readFile(path.join(sourceRoot, 'dashboard.json'), 'utf8');
      await writeFile(path.join(root, 'dashboard.json'), model);
      await writeFile(path.join(root, 'empty.tofurc'), '');
      const invoke = (expression: string) => {
        const result = spawnSync('tofu', ['console', '-no-color'], {
          cwd: root, encoding: 'utf8', input: `${expression}\n`, timeout: 20_000,
          env: {
            PATH: process.env.PATH,
            ...process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {},
            HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
            TF_CLI_CONFIG_FILE: path.join(root, 'empty.tofurc'),
            CHECKPOINT_DISABLE: '1', TF_IN_AUTOMATION: 'true'
          }
        });
        expect(result.error).toBeFalsy();
        expect(result.status, result.stderr).toBe(0);
        return JSON.parse(result.stdout);
      };
      const first = invoke('local.dashboard_definition_json') as string;
      expect(invoke('local.dashboard_definition_json')).toBe(first);
      expect(first).not.toMatch(/__(?:WORKSPACE_ID|DASHBOARD_TITLE)__/);
      const rendered = JSON.parse(first);
      expect(rendered).toEqual(JSON.parse(model.replaceAll('__WORKSPACE_ID__', workspace)
        .replaceAll('__DASHBOARD_TITLE__', 'Liftoff Telemetry (fixture)')));
      expect(invoke('local.dashboard_name')).toBe('liftoff-telemetry-fixture');
      expect(invoke('join(",", jsondecode(local.dashboard_definition_json).tags)')).toBe('liftoff,telemetry,azure-monitor');
      expect(rendered.panels).toHaveLength(6);
      expect(rendered.templating.list).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
