import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTelemetryDashboard } from '../scripts/telemetry-dashboards.mjs';

const require = createRequire(import.meta.url);
require('@kusto/language-service-next/bridge.js');
require('@kusto/language-service-next');

const root = path.join(process.cwd(), 'infrastructure', 'opentofu', 'telemetry');
const queries = path.join(root, 'dashboards', 'queries');
const now = Date.parse('2026-10-13T00:00:00Z');
const day = 86_400_000;
const ids = {
  rootA: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  rootB: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  expired: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  older: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  synthetic: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  never: 'ffffffff-ffff-4fff-8fff-ffffffffffff'
};

interface Observation {
  TimeGenerated: number;
  EventName: string;
  SchemaVersion: number;
  ProjectId: string;
  CliVersion: string;
  PolicyProfile: string;
  PolicyVersion: string;
  TemplateSetDigest: string;
  Source: string;
}

function observation(daysAgo: number, id: string, overrides: Partial<Observation> = {}): Observation {
  return {
    TimeGenerated: now - daysAgo * day, EventName: 'project_observed', SchemaVersion: 2,
    ProjectId: id, CliVersion: '0.12.3', PolicyProfile: 'none', PolicyVersion: 'none',
    TemplateSetDigest: `sha256:${'a'.repeat(64)}`, Source: 'cli', ...overrides
  };
}

const dataset = [
  observation(100, ids.rootA), observation(43, ids.rootA, { Source: 'ci-heartbeat' }),
  observation(1, ids.rootA, { CliVersion: '0.13.0', PolicyProfile: 'team-gitflow', PolicyVersion: '1' }),
  observation(1, ids.rootA, { CliVersion: '0.13.0', PolicyProfile: 'team-gitflow', PolicyVersion: '1' }),
  observation(20, ids.rootB), observation(181, ids.expired),
  observation(179, ids.older), observation(10, ids.older),
  observation(2, ids.synthetic), observation(-1, ids.never),
  observation(1, ids.never, { SchemaVersion: 1 }), observation(1, ids.never, { EventName: 'forged' })
];

function retained(rows: Observation[]) {
  return rows.filter((row) => row.TimeGenerated >= now - 180 * day && row.TimeGenerated <= now &&
    row.EventName === 'project_observed' && row.SchemaVersion === 2 &&
    ['cli', 'ci-heartbeat'].includes(row.Source) && row.ProjectId !== ids.synthetic);
}

function counts(rows: Observation[], days: number) {
  const first = new Map<string, number>();
  for (const row of retained(rows)) first.set(row.ProjectId, Math.min(first.get(row.ProjectId) ?? Infinity, row.TimeGenerated));
  return {
    observed: new Set(retained(rows).filter((row) => row.TimeGenerated >= now - days * day).map((row) => row.ProjectId)).size,
    firstObserved: [...first.values()].filter((time) => time >= now - days * day).length
  };
}

function latest(rows: Observation[], days: number) {
  const values = new Map<string, Observation>();
  for (const row of retained(rows).filter((row) => row.TimeGenerated >= now - days * day)) {
    if (row.TimeGenerated > (values.get(row.ProjectId)?.TimeGenerated ?? -Infinity)) values.set(row.ProjectId, row);
  }
  return [...values.values()];
}

function freshness(id: string, expectedSince: number, rows: Observation[], at = now) {
  const heartbeats = retained(rows).filter((row) => row.ProjectId === id && row.Source === 'ci-heartbeat');
  const last = heartbeats.length ? Math.max(...heartbeats.map((row) => row.TimeGenerated)) : null;
  const due = Math.max(expectedSince, last ?? expectedSince) + 40 * day;
  const overdue = expectedSince <= at && at > due;
  const state = expectedSince > at ? 'pending' : last === null ? 'unknown' : overdue ? 'stale' : 'within grace';
  return { last, due, overdue, state };
}

interface Diagnostic { Severity: string; Message: string }
interface LanguageApi {
  Language: {
    Symbols: {
      TableSymbol: { $ctor7: new (name: string, schema: string, description: string) => object };
      DatabaseSymbol: { ctor: new (name: string, tables: object[]) => object };
    };
    GlobalState: { Default: { WithDatabase: (database: object) => object } };
    KustoCode: { ParseAndAnalyze: (query: string, globals: object) => { GetDiagnostics: () => object } };
  };
}
const runtime = globalThis as typeof globalThis & {
  Kusto: LanguageApi; Bridge: { toArray: (list: object) => Diagnostic[] };
};
const language = runtime.Kusto.Language;
const tables = [
  new language.Symbols.TableSymbol.$ctor7('LiftoffProjectEvents_CL',
    '(TimeGenerated:datetime, EventName:string, SchemaVersion:int, ProjectId:string, CliVersion:string, PolicyProfile:string, PolicyVersion:string, TemplateSetDigest:string, Source:string)', ''),
  new language.Symbols.TableSymbol.$ctor7('LiftoffCommandEvents_CL',
    '(TimeGenerated:datetime, EventName:string, SchemaVersion:int, Command:string, CliVersion:string, Outcome:string)', '')
];
const globals = language.GlobalState.Default.WithDatabase(new language.Symbols.DatabaseSymbol.ctor('telemetry', tables));

function diagnostics(query: string) {
  return runtime.Bridge.toArray(language.KustoCode.ParseAndAnalyze(query, globals).GetDiagnostics())
    .filter((diagnostic) => diagnostic.Severity === 'Error').map((diagnostic) => diagnostic.Message);
}

function renderQuery(query: string, days: number, expectations = '', configuration = 'unknown') {
  return query.replaceAll('@synthetic_ids@', JSON.stringify([ids.synthetic]))
    .replaceAll('@expected_heartbeats@', expectations).replaceAll('@reporting_configuration@', configuration)
    .replaceAll('${window_days}', String(days));
}

describe('native Grafana source and exact KQL schema', () => {
  it('matches the generated JSON byte-for-byte and uses only native authenticated datasource controls', async () => {
    const dashboard = await buildTelemetryDashboard();
    expect(await readFile(path.join(root, 'dashboards', 'adoption.json'), 'utf8')).toBe(`${JSON.stringify(dashboard, null, 2)}\n`);
    expect(dashboard.editable).toBe(false);
    expect(dashboard.time).toEqual({ from: 'now-180d', to: 'now' });
    expect(dashboard.timepicker.hidden).toBe(true);
    expect(dashboard.templating.list[0].options.map((entry: { value: string }) => entry.value)).toEqual(['30', '90', '180']);
    for (const panel of dashboard.panels) {
      expect(['text', 'table', 'timeseries']).toContain(panel.type);
      expect(panel.gridPos.x + panel.gridPos.w).toBeLessThanOrEqual(24);
      if ('targets' in panel) {
        expect(panel.datasource.type).toBe('grafana-azure-monitor-datasource');
        expect(panel.targets[0].azureLogAnalytics.dashboardTime).toBe(false);
        expect(panel.fieldConfig.defaults.noValue).not.toBe('0');
      }
    }
    expect(JSON.stringify(dashboard)).not.toMatch(/publicDashboard|clientSecret|Authorization|password|secureJsonData|<script/);
  });

  it.each([30, 90, 180])('analyzes actual provisioned queries for %i days with empty and populated expectation inventories', async (days) => {
    const dashboard = await buildTelemetryDashboard();
    for (const expectations of ['', `"${ids.rootA}", datetime(2026-08-01T00:00:00Z), "${ids.rootB}", datetime(2026-09-20T00:00:00Z)`]) {
      for (const panel of dashboard.panels) {
        if ('targets' in panel) {
          const query = renderQuery(panel.targets[0].azureLogAnalytics.query, days, expectations);
          expect(diagnostics(query), panel.title).toEqual([]);
        }
      }
    }
    const common = await readFile(path.join(queries, 'projects.kql'), 'utf8');
    const fresh = await readFile(path.join(queries, 'freshness.kql'), 'utf8');
    expect(diagnostics(renderQuery(`${common}\n${fresh}\n| summarize Value=countif(Overdue)\n| project TimeGenerated=now(), Value`, days))).toEqual([]);
    expect(diagnostics(await readFile(path.join(queries, 'query-availability.kql'), 'utf8'))).toEqual([]);
  });

  it('rejects broken syntax, absent tables and unapproved fields rather than interpreting them as zero', () => {
    expect(diagnostics('LiftoffProjectEvents_CL | where )')).not.toEqual([]);
    expect(diagnostics('AbsentProjectEvents_CL | count')).not.toEqual([]);
    expect(diagnostics('LiftoffProjectEvents_CL | project ClientTimestamp, IP')).toHaveLength(2);
  });

  it('shares strict schema/server-time/synthetic filtering across every project query, without optional-table fallback', async () => {
    const common = await readFile(path.join(queries, 'projects.kql'), 'utf8');
    expect(common).toContain('TimeGenerated >= ago(180d) and TimeGenerated <= now()');
    expect(common).toContain('SchemaVersion == 2 and EventName == "project_observed"');
    expect(common).toContain('ProjectId !in (syntheticIds)');
    const dashboard = await buildTelemetryDashboard();
    for (const panel of dashboard.panels) {
      if ('targets' in panel && panel.targets[0].azureLogAnalytics.query.includes('LiftoffProjectEvents_CL')) {
        expect(panel.targets[0].azureLogAnalytics.query).toContain(common);
      }
    }
    const catalog = await Promise.all((await readdir(queries)).map((file) => readFile(path.join(queries, file), 'utf8')));
    expect(catalog.join('\n')).not.toMatch(/isfuzzy|column_ifexists|ClientTimestamp|client_timestamp|Request|IPAddress/);
  });

  it('renders explicit monthly configuration and empty/future-only expectation states instead of an ambiguous missing row', async () => {
    const query = await readFile(path.join(queries, 'freshness.kql'), 'utf8');
    expect(query).toContain('let reportingConfiguration = "@reporting_configuration@";');
    expect(query).toContain('let evaluated = expected');
    expect(query).toContain('unconfigured - no eligible expected reporting');
    expect(query).toContain('ExpectedSince > now(), "pending - monitoring starts in the future"');
    expect(query).toContain('where toscalar(expected | count) == 0');
    const dashboard = await buildTelemetryDashboard();
    const panel = dashboard.panels.find((entry: { title: string }) => entry.title.startsWith('Explicit expected monthly'));
    if (!panel || !('targets' in panel)) throw new Error('Monthly expectation query panel is missing.');
    expect(panel.targets[0].azureLogAnalytics.query).toContain('ExpectedProjects = countif(isnotempty(ProjectId))');
    expect(panel.targets[0].azureLogAnalytics.query).toContain('by ReportingConfiguration, Freshness');
  });

  it.each(['unknown', 'enabled', 'disabled'])('analyzes explicit %s monthly state with empty, excluded and future expectations', async configuration => {
    const common = await readFile(path.join(queries, 'projects.kql'), 'utf8');
    const fresh = await readFile(path.join(queries, 'freshness.kql'), 'utf8');
    const inventories = ['', `"${ids.synthetic}", datetime(2026-08-01T00:00:00Z)`,
      `"${ids.rootA}", datetime(2099-01-01T00:00:00Z)`];
    for (const expectations of inventories) {
      const query = renderQuery(`${common}\n${fresh}`, 30, expectations, configuration);
      expect(diagnostics(query)).toEqual([]);
      expect(query).not.toContain('@reporting_configuration@');
      expect(diagnostics(`${query}\n| summarize Value=countif(Overdue)\n| project TimeGenerated=now(), Value`)).toEqual([]);
    }
  });
});

describe('fixed-dataset semantic oracle (not Azure query execution)', () => {
  it('deduplicates clones/worktrees, distinguishes monorepo roots, and bounds first observations to retained data', async () => {
    expect(counts(dataset, 30)).toEqual({ observed: 3, firstObserved: 1 });
    expect(counts(dataset, 90)).toEqual({ observed: 3, firstObserved: 1 });
    expect(counts(dataset, 180)).toEqual({ observed: 3, firstObserved: 3 });
    expect(counts([observation(181, ids.expired), observation(1, ids.expired)], 30)).toEqual({ observed: 1, firstObserved: 1 });
    const query = await readFile(path.join(queries, 'counts.kql'), 'utf8');
    expect(query).toContain('FirstSeen = min(TimeGenerated) by ProjectId');
    expect(query).toContain('dcount(ProjectId, 2)');
    expect(query).toContain('union windowCounts(30), windowCounts(90), windowCounts(180)');
  });

  it.each([30, 90, 180])('includes the exact %i-day boundary but excludes earlier/future/synthetic data', (days) => {
    expect(counts([observation(days, ids.rootA), observation(days + 0.001, ids.rootB),
      observation(-1, ids.never), observation(1, ids.synthetic)], days)).toEqual({ observed: 1, firstObserved: 1 });
    expect(counts([], days)).toEqual({ observed: 0, firstObserved: 0 });
  });

  it('uses latest per-project dimensions and keeps source counts overlapping', async () => {
    expect(latest(dataset, 30)).toHaveLength(3);
    expect(latest(dataset, 30).find((row) => row.ProjectId === ids.rootA)).toMatchObject({
      CliVersion: '0.13.0', PolicyProfile: 'team-gitflow', PolicyVersion: '1'
    });
    expect(new Set(retained(dataset).filter((row) => row.Source === 'cli').map((row) => row.ProjectId)).size).toBe(3);
    expect(new Set(retained(dataset).filter((row) => row.Source === 'ci-heartbeat').map((row) => row.ProjectId)).size).toBe(1);
    for (const [file, dimension] of [['versions', 'CliVersion'], ['policies', 'PolicyProfile, PolicyVersion'], ['templates', 'TemplateSetDigest']]) {
      expect(await readFile(path.join(queries, `${file}.kql`), 'utf8')).toContain(`arg_max(TimeGenerated, ${dimension}) by ProjectId`);
    }
  });

  it('does not refresh expected heartbeat deadlines from daily CLI activity and discloses exact monthly grace', async () => {
    expect(freshness(ids.rootA, now - 73 * day, dataset).overdue).toBe(true);
    expect(freshness(ids.rootB, now - 23 * day, dataset)).toMatchObject({ last: null, overdue: false });
    expect(freshness(ids.never, now - 73 * day, dataset)).toMatchObject({ last: null, overdue: true });
    const boundary = freshness(ids.rootB, now - 40 * day, []);
    expect(boundary.overdue).toBe(false);
    expect(freshness(ids.rootB, now - 40 * day, [], now + 1).overdue).toBe(true);
    const query = await readFile(path.join(queries, 'freshness.kql'), 'utf8');
    expect(query).toContain('Source == "ci-heartbeat"');
    expect(query).toContain('+ 40d');
    expect(query).toContain('now() > Due');
    expect(query).toContain('unknown - no retained heartbeat; never received or expired');
  });

  it('keeps future starts pending alongside overdue and unknown expectations, without inventing heartbeat events', async () => {
    const expectations = [
      { id: ids.rootA, since: now - 73 * day }, { id: ids.rootB, since: now + day },
      { id: ids.never, since: now - 73 * day }, { id: ids.synthetic, since: now - 73 * day }
    ].filter(entry => entry.id !== ids.synthetic);
    const states = expectations.map(entry => freshness(entry.id, entry.since, dataset));
    expect(states.map(entry => entry.state)).toEqual(['stale', 'pending', 'unknown']);
    expect(states.filter(entry => entry.overdue)).toHaveLength(2);
    expect(states[1]).toMatchObject({ last: null, overdue: false, due: now + 41 * day });
    expect(freshness(ids.expired, now - 190 * day, [observation(181, ids.expired)]))
      .toMatchObject({ last: null, overdue: true, state: 'unknown' });
    const query = await readFile(path.join(queries, 'freshness.kql'), 'utf8');
    expect(query).toContain('ExpectedSince <= now() and now() > Due');
    expect(query).not.toContain('where ExpectedSince <= now()');
  });

  it('separates schema-2 expected attention/cancellation/failure from legacy nonzero semantics', async () => {
    const outcomes = [
      { schema: 2, outcome: 'success' }, { schema: 2, outcome: 'attention-required' },
      { schema: 2, outcome: 'cancelled' }, { schema: 2, outcome: 'failure' },
      { schema: 1, outcome: 'success' }, { schema: 1, outcome: 'failure' }
    ];
    expect(outcomes.filter((row) => row.schema === 2).map((row) => row.outcome))
      .toEqual(['success', 'attention-required', 'cancelled', 'failure']);
    expect(outcomes.filter((row) => row.schema === 1).map((row) => row.outcome === 'success' ? 'zero exit' : 'nonzero exit'))
      .toEqual(['zero exit', 'nonzero exit']);
    const semantic = await readFile(path.join(queries, 'semantic-outcomes.kql'), 'utf8');
    const legacy = await readFile(path.join(queries, 'legacy-outcomes.kql'), 'utf8');
    expect(semantic).toContain('SchemaVersion == 2');
    expect(semantic).toContain('"success", "attention-required", "cancelled", "failure"');
    expect(legacy).toContain('SchemaVersion == 1');
    expect(legacy).toContain('nonzero exit - not semantic failure');
    expect(legacy).not.toMatch(/attention-required|cancelled/);
    const status = await readFile(path.join(queries, 'command-status.kql'), 'utf8');
    expect(status).not.toContain('LiftoffProjectEvents_CL');
    expect(status).toContain('LegacyEvents = countif(SchemaVersion == 1)');
    expect(status).toContain('SemanticEvents = countif(SchemaVersion == 2)');
  });
});

describe('operator, privacy and non-destructive boundaries', () => {
  it('reads workspace metadata without the shared-key-capable workspace datasource', async () => {
    const source = await readFile(path.join(root, 'grafana', 'main.tf'), 'utf8');
    expect(source).toContain('data "azurerm_resources" "telemetry_workspace"');
    expect(source).toContain('type                = "Microsoft.OperationalInsights/workspaces"');
    expect(source).toContain('length(self.resources) == 1');
    expect(source).toContain('lower(resource.id)');
    expect(source).toContain('lower(resource.resource_group_name)');
    expect(source).toContain('lower(resource.type)');
    expect(source).toContain('lower(resource.name)');
    expect(source).toMatch(/scope\s*=\s*one\(data\.azurerm_resources\.telemetry_workspace\.resources\)\.id/);
    expect(source).not.toMatch(/azurerm_log_analytics_workspace|shared_key|sharedKeys|listKeys/);
  });

  it('pins providers, avoids resource-group/workspace/state ownership and scopes Logs and DCR metrics identity', async () => {
    const [resource, resourceVersions, dashboard, dashboardVersions] = await Promise.all([
      readFile(path.join(root, 'grafana', 'main.tf'), 'utf8'),
      readFile(path.join(root, 'grafana', 'versions.tf'), 'utf8'),
      readFile(path.join(root, 'dashboards', 'main.tf'), 'utf8'),
      readFile(path.join(root, 'dashboards', 'versions.tf'), 'utf8')
    ]);
    expect(resourceVersions).toContain('version = "5.3.0"');
    expect(resourceVersions).toMatch(/resource_provider_registrations\s*=\s*"none"/);
    expect(dashboardVersions).toContain('version = "4.49.0"');
    expect(resource).toMatch(/scope\s*=\s*one\(data\.azurerm_resources\.telemetry_workspace\.resources\)\.id/);
    expect(resource).toContain('"Log Analytics Reader"');
    expect(resource).toMatch(/scope\s*=\s*data\.azurerm_monitor_data_collection_rule\.telemetry\.id/);
    expect(resource).toContain('"Monitoring Reader"');
    expect(resource).toContain('"dcr-liftoff-telemetry-f5be1618"');
    expect(resource).toContain('data.azurerm_monitor_data_collection_rule.telemetry.location == "koreacentral"');
    expect(resource).not.toMatch(/scope\s*=\s*data\.azurerm_resource_group\.telemetry\.id/);
    expect(resource).toContain('prevent_destroy = true');
    expect(resource).toMatch(/api_key_enabled\s*=\s*false/);
    expect(resource).toMatch(/location\s*=\s*"koreacentral"/);
    expect(resource + dashboard).not.toMatch(/resource "azurerm_(?:resource_group|log_analytics_workspace|storage|monitor_data_collection)|terraform_remote_state|secure_json|client_secret|public_dashboard|prometheus|loki|kubernetes/i);
    expect(dashboard).toContain('azureAuthType');
    expect(dashboard).toContain('"msi"');
    expect(dashboard).toMatch(/overwrite\s*=\s*false/);
  });

  it('preserves native unavailable/NoData and paused rules, never alerts on low command counts', async () => {
    const [source, vars, probe] = await Promise.all([
      readFile(path.join(root, 'dashboards', 'main.tf'), 'utf8'),
      readFile(path.join(root, 'dashboards', 'variables.tf'), 'utf8'),
      readFile(path.join(queries, 'query-availability.kql'), 'utf8')
    ]);
    expect(source).toMatch(/interval_seconds\s*=\s*900/);
    expect(source).toMatch(/for\s*=\s*"15m"/);
    expect(source).toMatch(/no_data_state\s*=\s*"NoData"/);
    expect(source).toMatch(/exec_err_state\s*=\s*"Error"/);
    expect(source).toContain('var.reporting_configuration != "enabled"');
    expect(vars).toMatch(/variable "alerts_enabled"[\s\S]*?default\s*=\s*false/);
    expect(probe).toContain('Value = 0');
    expect(probe).not.toMatch(/count\(\)\s*[<>=]|iff|failure|fault/i);
    expect(source).not.toMatch(/grafana_contact_point|notification_policy|email|webhook/i);
  });

  it('defines only the observed DCR transform metric with a bounded window and independent enablement', async () => {
    const [source, vars] = await Promise.all([
      readFile(path.join(root, 'dashboards', 'ingestion-faults.tf'), 'utf8'),
      readFile(path.join(root, 'dashboards', 'variables.tf'), 'utf8')
    ]);
    expect(source).toContain('grafana_rule_group" "ingestion_faults"');
    expect(source).toMatch(/interval_seconds\s*=\s*60/);
    expect(source).toMatch(/for\s*=\s*"5m"/);
    expect(source).toMatch(/from\s*=\s*900/);
    expect(source).toMatch(/queryType\s*=\s*"Azure Monitor"/);
    expect(source).toMatch(/aggregation\s*=\s*"Count"/);
    expect(source).toMatch(/timeGrain\s*=\s*"PT1M"/);
    expect(source).toMatch(/metricName\s*=\s*"TransformationErrors_Count"/);
    expect(source).toMatch(/resourceName\s*=\s*"dcr-liftoff-telemetry-f5be1618"/);
    expect(source).toMatch(/metricNamespace\s*=\s*"Microsoft\.Insights\/dataCollectionRules"/);
    expect(source).toContain('!var.alerts_enabled || !var.ingestion_fault_alerts_enabled');
    expect(vars).toMatch(/variable "ingestion_fault_alerts_enabled"[\s\S]*?default\s*=\s*false/);
    expect(source).toMatch(/no_data_state\s*=\s*"NoData"/);
    expect(source).toMatch(/exec_err_state\s*=\s*"Error"/);
    expect(source).toContain('type = "sum"');
    expect(source).toContain('type = "gt", params = [0]');
    expect(source).not.toMatch(/ApiCallReceived|LiftoffCommandEvents|LiftoffProjectEvents|fill|coalesce|dimensionFilters|grafana_contact_point|notification_policy|email|webhook/i);
    expect(source).toContain('does not verify gateway/auth/network health or project activity');
  });

  it('documents real blockers, no deployment, retention states, cost and safe rollback across related READMEs', async () => {
    const [operator, bootstrap, privacy, tasks] = await Promise.all([
      readFile(path.join(root, 'README.md'), 'utf8'),
      readFile(path.join(root, '..', 'bootstrap', 'README.md'), 'utf8'),
      readFile(path.join(process.cwd(), 'docs', 'telemetry.md'), 'utf8'),
      readFile(path.join(process.cwd(), 'openspec', 'changes', 'modernize-liftoff-platform', 'tasks.md'), 'utf8')
    ]);
    for (const term of ['NotRegistered', '$0.04617/hour', '$6/month', 'not an X1/X2', '180 days', 'Verified ingestion-fault',
      'NoData', '40 days', 'not execution', 'GRAFANA_AUTH', 'https://dashboard.azure.com', 'does **not stop', 'distinct backend keys']) {
      expect(operator).toContain(term);
    }
    for (const term of ['TransformationErrors_Count', 'DCR-scoped', '5-minute pending', '15-minute window',
      'ingestion_fault_alerts_enabled', 'empty timeseries', 'not end-to-end ingestion health', 'sensitive']) {
      expect(operator.replace(/\s+/g, ' ')).toContain(term);
    }
    for (const term of ['2 Standard Units', '4 Standard Units', 'USD 67.41', 'USD 73.41',
      'USD 134.82', 'USD 140.82', 'one unit', 'not a subscription quote or approved budget']) {
      expect(operator.replace(/\s+/g, ' ')).toContain(term);
    }
    expect(bootstrap).toContain('Grafana does not own the state boundary');
    for (const term of ['unavailable', 'expired', 'disabled', 'stale/unknown', 'forge', 'not a census', 'Schema-1', 'synthetic']) expect(privacy).toContain(term);
    expect(tasks.match(/- \[x\] 17\./g)).toBeNull();
    expect(tasks.match(/- \[ \] 17\./g)).toHaveLength(8);
    const [vars, example] = await Promise.all([
      readFile(path.join(root, 'variables.tf'), 'utf8'), readFile(path.join(root, 'production.tfvars.example'), 'utf8')
    ]);
    expect(vars).not.toContain('eastus');
    expect(example).toContain('koreacentral');
  });
});
