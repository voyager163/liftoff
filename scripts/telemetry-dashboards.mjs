import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../infrastructure/opentofu/telemetry/dashboards/', import.meta.url));
const datasource = { type: 'grafana-azure-monitor-datasource', uid: 'liftoff-azure-logs' };

export async function buildTelemetryDashboard() {
  const common = await readFile(path.join(root, 'queries', 'projects.kql'), 'utf8');
  const measurementPanel = {
    id: 1, type: 'text', title: 'Measurement and availability',
    gridPos: { x: 0, y: 0, w: 24, h: 6 },
    options: {
      mode: 'markdown',
      content: '**Opted-in observed projects, not a census.** One random ID per root/manifest; clones/worktrees share it, independent monorepo roots differ. Forgeable IDs are not authentication or compliance proof.\n\n**Operator-configured project reporting: @reporting_configuration@.** Display/expectation only; does not change clients or ingestion. Query/permission/table errors are **unavailable**, never zero. Successful empty queries mean no retained events; history may have expired. Silence cannot establish individual disablement or abandonment.\n\n**180-day retained history.** First-observed is earliest retained observation, not lifetime enrollment. Distinct counts are approximate (`dcount(..., 2)`, nominal 0.4% standard error). Latest-observed dimensions are not conformance; equal-time ties are unspecified. Source counts overlap. Monthly grace is **31 + 9 = 40 days**, not daily activity.'
    }
  };
  const panels = [];
  /** @type {Array<[string, string, number, number, number, number, boolean]>} */
  const definitions = [
    ['status', 'Retained project data status', 0, 6, 24, 4, false],
    ['counts', 'Opted-in projects - 30 / 90 / 180 days (approximate)', 0, 10, 24, 5, false],
    ['timeline', 'Daily observations by source (approximate, not active developers)', 0, 15, 24, 8, true],
    ['versions', 'Latest observed CLI version per project (approximate)', 0, 23, 12, 7, false],
    ['policies', 'Latest observed policy per project (approximate, not conformance)', 12, 23, 12, 7, false],
    ['templates', 'Latest observed complete registry digest (approximate)', 0, 30, 24, 7, false],
    ['sources', 'CLI / CI-heartbeat observations (overlapping project counts)', 0, 37, 12, 7, false],
    ['freshness', 'Explicit expected monthly reporting - freshness / unknown', 12, 37, 12, 7, false],
    ['command-status', 'Command data availability - legacy / semantic presence', 0, 44, 24, 4, false],
    ['semantic-outcomes', 'Schema 2 - semantic command outcomes', 0, 48, 12, 8, false],
    ['legacy-outcomes', 'Schema 1 - zero / nonzero exits (legacy)', 12, 48, 12, 8, false]
  ];
  for (const [key, title, x, y, w, h, series] of definitions) {
    let query = await readFile(path.join(root, 'queries', `${key}.kql`), 'utf8');
    if (!['semantic-outcomes', 'legacy-outcomes', 'command-status'].includes(key)) query = `${common}\n${query}`;
    if (key === 'freshness') query += '\n| summarize ExpectedProjects = count(), OverdueExpectations = countif(Overdue) by Freshness\n| order by Freshness asc';
    panels.push({
      id: panels.length + 2, type: series ? 'timeseries' : 'table', title,
      description: key === 'freshness'
        ? 'Only operator-registered expectations. Empty inventory is unconfigured, not healthy. Never infer disablement or abandonment from silence.'
        : ['semantic-outcomes', 'legacy-outcomes', 'command-status'].includes(key)
          ? 'A native query error means unavailable. Anonymous command events contain no project identifier: not project counts and no per-project synthetic classification.'
          : 'A native query error means unavailable. Empty dimensions are no observations, not a query-success fallback. Project counts exclude registered synthetic IDs.',
      gridPos: { x, y, w, h }, datasource,
      fieldConfig: {
        defaults: { noValue: 'Unavailable / no retained value', decimals: 0, custom: {} },
        overrides: []
      },
      options: series
        ? { legend: { displayMode: 'list', placement: 'bottom', showLegend: true }, tooltip: { mode: 'multi', sort: 'none' } }
        : { showHeader: true, cellHeight: 'sm' },
      targets: [{
        refId: 'A', datasource, queryType: 'Azure Log Analytics',
        azureLogAnalytics: {
          resources: ['@workspace_resource_id@'], query,
          resultFormat: series ? 'time_series' : 'table', dashboardTime: false, mode: 'raw'
        }
      }]
    });
  }
  return {
    uid: 'liftoff-observed-adoption', title: 'Liftoff - opted-in observed adoption',
    description: 'Directional, retained observations and reporting availability; not a census, lifetime adoption, developer activity or deployment health.',
    schemaVersion: 39, version: 1, editable: false, timezone: 'utc',
    tags: ['liftoff', 'opted-in', 'retained-observations'], refresh: '',
    time: { from: 'now-180d', to: 'now' },
    timepicker: { hidden: true },
    templating: { list: [{
      name: 'window_days', label: 'Distribution window (days)', type: 'custom',
      query: '30,90,180', multi: false, includeAll: false,
      current: { text: '30', value: '30' },
      options: [30, 90, 180].map((days) => ({ text: String(days), value: String(days), selected: days === 30 }))
    }] },
    annotations: { list: [] }, links: [], panels: [measurementPanel, ...panels]
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (!['--check', '--write'].includes(mode) || process.argv.length !== 3) {
    throw new Error('Usage: node scripts/telemetry-dashboards.mjs --check|--write');
  }
  const content = `${JSON.stringify(await buildTelemetryDashboard(), null, 2)}\n`;
  const destination = path.join(root, 'adoption.json');
  if (mode === '--write') await writeFile(destination, content);
  else if (await readFile(destination, 'utf8') !== content) throw new Error('Dashboard source drift: regenerate with --write and review the diff.');
}
