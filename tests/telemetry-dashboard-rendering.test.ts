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
      const variables = await parseHcl('variables.tf', await readFile(path.join(sourceRoot, 'variables.tf'), 'utf8'));
      expect(variables.variable.dashboard_datasource_uid[0].type).toBe('${string}');
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
          dashboard_name: { type: 'string', default: '' },
          dashboard_datasource_uid: {
            ...variables.variable.dashboard_datasource_uid[0], type: 'string', default: 'observed-monitor-source'
          }
        },
        locals,
        output: { rendered_dashboard: { value: '${local.dashboard_definition_json}' } }
      }));
      const model = await readFile(path.join(sourceRoot, 'dashboard.json'), 'utf8');
      await writeFile(path.join(root, 'dashboard.json'), model);
      await writeFile(path.join(root, 'empty.tofurc'), '');
      const command = (args: string[], input?: string) => spawnSync('tofu', args, {
        cwd: root, encoding: 'utf8', input, timeout: 20_000,
        env: {
          PATH: process.env.PATH,
          ...process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {},
          HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
          TF_CLI_CONFIG_FILE: path.join(root, 'empty.tofurc'),
          CHECKPOINT_DISABLE: '1', TF_IN_AUTOMATION: 'true'
        }
      });
      const invoke = (expression: string, args: string[] = []) => {
        const result = command(['console', '-no-color', ...args], `${expression}\n`);
        expect(result.error).toBeFalsy();
        expect(result.status, result.stderr).toBe(0);
        return JSON.parse(result.stdout);
      };
      const first = invoke('local.dashboard_definition_json') as string;
      expect(invoke('local.dashboard_definition_json')).toBe(first);
      expect(first).not.toMatch(/__(?:WORKSPACE_ID|DASHBOARD_TITLE|AZURE_MONITOR_DATASOURCE_UID)__/);
      const rendered = JSON.parse(first);
      expect(rendered).toEqual(JSON.parse(model.replaceAll('__WORKSPACE_ID__', workspace)
        .replaceAll('__DASHBOARD_TITLE__', 'Liftoff Telemetry (fixture)')
        .replaceAll('__AZURE_MONITOR_DATASOURCE_UID__', 'observed-monitor-source')));
      const rebound = JSON.parse(invoke('local.dashboard_definition_json', ['-var=dashboard_datasource_uid=Other_Source-2']));
      expect([...rebound.panels, ...rebound.templating.list].every((entry) => entry.datasource.uid === 'Other_Source-2')).toBe(true);
      for (const invalid of ['', 'with spaces', '"quoted"', '${injection}', 'x'.repeat(41)]) {
        const result = command(['plan', '-refresh=false', '-input=false', '-no-color', `-var=dashboard_datasource_uid=${invalid}`]);
        expect(result.error).toBeFalsy();
        expect(result.status, result.stderr).not.toBe(0);
        expect(result.stderr).toContain('dashboard_datasource_uid must be the observed');
      }
      expect(invoke('local.dashboard_name')).toBe('liftoff-telemetry-fixture');
      expect(invoke('join(",", jsondecode(local.dashboard_definition_json).tags)')).toBe('liftoff,telemetry,azure-monitor');
      expect(rendered.panels).toHaveLength(6);
      expect(rendered.templating.list).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
