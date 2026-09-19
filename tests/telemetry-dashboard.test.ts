import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parse as parseHcl } from "@cdktf/hcl2json";
import { describe, expect, it } from "vitest";

const infrastructureRoot = path.join(
  process.cwd(),
  "infrastructure",
  "opentofu",
  "telemetry"
);

interface DashboardTarget {
  azureLogAnalytics: {
    query: string;
    resources: string[];
    resultFormat: string;
  };
  queryType: string;
  refId: string;
}

interface DashboardPanel {
  id: number;
  title: string;
  type: string;
  description: string;
  datasource: { type: string; uid: string };
  gridPos: { h: number; w: number; x: number; y: number };
  targets: DashboardTarget[];
  options: { reduceOptions?: { calcs: string[]; fields: string; values: boolean } };
  fieldConfig: {
    defaults: {
      noValue?: string;
      unit?: string;
    };
    overrides: Array<{
      matcher: { id: string; options: string };
      properties: Array<{ id: string; value: string }>;
    }>;
  };
}

interface DashboardQueryVariable {
  name: string;
  label: string;
  type: string;
  datasource: {
    type: string;
    uid: string;
  };
  current: {
    selected: boolean;
    text: string;
    value: string;
  };
  query: {
    queryType: string;
    rawQuery: string;
    azureLogAnalytics: {
      query: string;
      resources: string[];
      resultFormat: string;
    };
  };
  includeAll: boolean;
  allValue: string | null;
  refresh: number;
}

interface DashboardModel {
  schemaVersion: number;
  title: string;
  uid: string;
  tags: string[];
  timezone: string;
  editable: boolean;
  time: { from: string; to: string };
  refresh: string;
  panels: DashboardPanel[];
  templating: {
    list: DashboardQueryVariable[];
  };
}

const APPROVED_COLUMNS_AND_ALIASES = new Set([
  "LiftoffCommandEvents_CL",
  "TimeGenerated",
  "EventName",
  "SchemaVersion",
  "Command",
  "CliVersion",
  "Outcome",
  "TotalEvents",
  "EventCount",
  "OutcomeCategory",
  "LatestEventTime",
  "EventAgeMinutes",
  "QueryObservedAt",
  "Observation"
]);

describe("OpenSpec modernization task 17: Azure Monitor Grafana telemetry dashboard", () => {
  async function loadDashboardJson(): Promise<DashboardModel> {
    const content = await readFile(path.join(infrastructureRoot, "dashboard.json"), "utf8");
    return JSON.parse(content) as DashboardModel;
  }

  async function loadTofuFile(name: string): Promise<string> {
    return readFile(path.join(infrastructureRoot, name), "utf8");
  }

  describe("17.1 & 17.7: Resource bindings, least privilege, and no hard-coded secrets", () => {
    it("binds to approved Log Analytics workspace and table without hard-coded subscription or customer GUIDs", async () => {
      const [dashboardTf, dashboardJsonRaw] = await Promise.all([
        loadTofuFile("dashboard.tf"),
        readFile(path.join(infrastructureRoot, "dashboard.json"), "utf8")
      ]);

      expect(dashboardTf).toContain("azurerm_log_analytics_workspace.telemetry.id");
      expect(dashboardTf).toContain("azurerm_resource_group.telemetry.id");
      expect(dashboardTf).toMatch(/Microsoft\.Dashboard\/dashboards@2025-08-01/);
      expect(dashboardTf).toMatch(/Microsoft\.Dashboard\/dashboards\/dashboardDefinitions@2025-09-01-preview/);

      const guidPattern = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
      expect(dashboardTf).not.toMatch(guidPattern);
      expect(dashboardJsonRaw).not.toMatch(guidPattern);

      expect(dashboardJsonRaw).toContain("__WORKSPACE_ID__");
      expect(dashboardJsonRaw).toContain("__DASHBOARD_TITLE__");
      expect(dashboardJsonRaw).toContain("__AZURE_MONITOR_DATASOURCE_UID__");
    });

    it("proposes no duplicate ingestion store, pipeline, or Managed Grafana service", async () => {
      const files = await readdir(infrastructureRoot);
      const tfFiles = files.filter((f) => f.endsWith(".tf"));
      const allTf = (
        await Promise.all(tfFiles.map((f) => readFile(path.join(infrastructureRoot, f), "utf8")))
      ).join("\n");

      expect(allTf).not.toMatch(/Microsoft\.Dashboard\/grafana\b/);
      expect(allTf).not.toMatch(/Microsoft\.Insights\/workbooks\b/);
      expect(allTf).not.toMatch(/azurerm_dashboard_grafana\b/);
      expect(allTf).not.toMatch(/azurerm_storage_queue|azurerm_eventhub|azurerm_servicebus/i);

      expect(allTf).toContain('name                    = "LiftoffCommandEvents_CL"');
      expect(allTf).toContain("retention_in_days       = 180");
    });

    it("exposes stable resource and portal outputs", async () => {
      const outputs = await loadTofuFile("outputs.tf");
      expect(outputs).toContain('output "telemetry_dashboard_id"');
      expect(outputs).toContain('output "telemetry_dashboard_portal_url"');
      expect(outputs).toContain("azapi_resource.telemetry_dashboard.id");
      expect(outputs).toContain("https://portal.azure.com/#@/resource");
      expect(outputs).not.toMatch(/key|secret|token|credential/i);
    });
  });

  describe("17.2: Canonical version-controlled dashboard model, schema, and qualification status", () => {
    it("declares schemaVersion 39 and stable dashboard metadata in source", async () => {
      const dashboard = await loadDashboardJson();
      expect(dashboard.schemaVersion).toBe(39);
      expect(dashboard.uid).toBe("liftoff-telemetry");
      expect(dashboard.tags).toEqual(["liftoff", "telemetry", "azure-monitor"]);
      expect(dashboard.timezone).toBe("browser");
      expect(dashboard.editable).toBe(false);
      expect(dashboard.time).toEqual({ from: "now-7d", to: "now" });
      expect(dashboard.refresh).toBe("");
    });

    it("uses canonical JSON serialization in the actual OpenTofu definition binding", async () => {
      const parsed = await parseHcl("dashboard.tf", await loadTofuFile("dashboard.tf"));
      expect(parsed.locals).toEqual([{
        dashboard_name: '${var.dashboard_name != "" ? var.dashboard_name : "liftoff-telemetry-${var.resource_suffix}"}',
        dashboard_title: "Liftoff Telemetry (${var.resource_suffix})",
        dashboard_definition_json: '${jsonencode(jsondecode(replace(replace(replace(file("${path.module}/dashboard.json"), "__WORKSPACE_ID__", azurerm_log_analytics_workspace.telemetry.id), "__DASHBOARD_TITLE__", local.dashboard_title), "__AZURE_MONITOR_DATASOURCE_UID__", var.dashboard_datasource_uid)))}'
      }]);
    });

    it("replaces all placeholders cleanly across both panels and variable queries", async () => {
      const dashboardJsonRaw = await readFile(path.join(infrastructureRoot, "dashboard.json"), "utf8");
      const testWsId = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-liftoff-prod/providers/Microsoft.OperationalInsights/workspaces/log-liftoff-telemetry-prod01";
      const rendered = dashboardJsonRaw
        .replace(/__WORKSPACE_ID__/g, testWsId)
        .replace(/__DASHBOARD_TITLE__/g, "Liftoff Telemetry (prod01)")
        .replace(/__AZURE_MONITOR_DATASOURCE_UID__/g, "observed-monitor-source");

      expect(rendered).not.toContain("__WORKSPACE_ID__");
      expect(rendered).not.toContain("__DASHBOARD_TITLE__");
      expect(rendered).not.toContain("__AZURE_MONITOR_DATASOURCE_UID__");

      const parsed = JSON.parse(rendered) as DashboardModel;
      expect(parsed.title).toBe("Liftoff Telemetry (prod01)");
      for (const panel of parsed.panels) {
        expect(panel.datasource).toEqual({ type: "grafana-azure-monitor-datasource", uid: "observed-monitor-source" });
        for (const target of panel.targets) {
          expect(target.azureLogAnalytics.resources[0]).toBe(testWsId);
        }
      }
      for (const variable of parsed.templating.list) {
        expect(variable.datasource).toEqual({ type: "grafana-azure-monitor-datasource", uid: "observed-monitor-source" });
        expect(variable.query.azureLogAnalytics.resources[0]).toBe(testWsId);
      }
    });

    it("requires an observed data-source instance identity instead of guessing it from the plugin type", async () => {
      const variables = await parseHcl("variables.tf", await loadTofuFile("variables.tf"));
      const input = variables.variable.dashboard_datasource_uid[0];
      expect(input).not.toHaveProperty("default");
      expect(input.validation[0].condition).toContain("^[a-zA-Z0-9_-]{1,40}$");
      const dashboard = await loadDashboardJson();
      const bindings = [...dashboard.panels, ...dashboard.templating.list].map((entry) => entry.datasource);
      expect(bindings).toHaveLength(8);
      for (const binding of bindings) {
        expect(binding.type).toBe("grafana-azure-monitor-datasource");
        expect(binding.uid).toBe("__AZURE_MONITOR_DATASOURCE_UID__");
        expect(binding.uid).not.toBe(binding.type);
      }
    });

  });

  describe("17.3: Six panels and truthful interpretations", () => {
    it("contains exactly six native accessible panels with stable IDs", async () => {
      const dashboard = await loadDashboardJson();
      expect(dashboard.panels).toHaveLength(6);

      const panelIds = dashboard.panels.map((p) => p.id).sort((a, b) => a - b);
      expect(panelIds).toEqual([1, 2, 3, 4, 5, 6]);

      const expectedPanels = [
        { id: 1, type: "stat", title: "Recorded Command Events" },
        { id: 2, type: "timeseries", title: "Event Volume Over Time" },
        { id: 3, type: "barchart", title: "Events by Command" },
        { id: 4, type: "table", title: "Events by CLI Version" },
        { id: 5, type: "piechart", title: "Nonzero Exit Outcomes" },
        { id: 6, type: "stat", title: "Latest Matching Event" }
      ];

      for (const expected of expectedPanels) {
        const found = dashboard.panels.find((p) => p.id === expected.id);
        expect(found, `panel id ${expected.id} exists`).toBeDefined();
        expect(found?.type).toBe(expected.type);
        expect(found?.title).toBe(expected.title);
      }
    });

    it("does not make unique-user, installation-count, crash-rate, or outage claims", async () => {
      const dashboard = await loadDashboardJson();
      const disallowedAffirmativeClaims = /\b(unique users?|installation count|crash rate|outage proof|service outage confirmed)\b/i;

      for (const panel of dashboard.panels) {
        expect(panel.title).not.toMatch(disallowedAffirmativeClaims);
      }

      const p1 = dashboard.panels.find((p) => p.id === 1)!;
      expect(p1.description).toContain("not people or installations");

      const p4 = dashboard.panels.find((p) => p.id === 4)!;
      expect(p4.description).toContain("not an installation inventory");

      const p5 = dashboard.panels.find((p) => p.id === 5)!;
      expect(p5.description).toContain("expected exit-2");
      expect(p5.description).toContain("not a crash/error rate");

      const p6 = dashboard.panels.find((p) => p.id === 6)!;
      expect(p6.description).toContain("absence of events alone is not proof of service outage");
    });

    it("accurately categorizes outcomes without mislabeling unknown or empty outcomes as success", async () => {
      const dashboard = await loadDashboardJson();
      const p5 = dashboard.panels.find((p) => p.id === 5)!;
      const query = p5.targets[0].azureLogAnalytics.query;

      expect(query).toContain('case(Outcome == "success", "Zero exit (success)", Outcome == "failure", "Nonzero exit (failure / exit-2)", "Unknown outcome")');
      expect(query).toContain("| summarize EventCount = count() by OutcomeCategory");
      expect(query).not.toContain("count() by Outcome\n");
      expect(p5.options.reduceOptions).toMatchObject({ values: true, calcs: [] });
    });

    it("formats event timestamps independently of age at the last manual query", async () => {
      const panel = (await loadDashboardJson()).panels.find((item) => item.id === 6)!;
      expect(panel.description).toContain("Refresh manually to recalculate age");
      expect(panel.fieldConfig.overrides).toEqual([
        {
          matcher: { id: "byName", options: "LatestEventTime" },
          properties: [
            { id: "unit", value: "dateTimeAsIso" },
            { id: "displayName", value: "Latest event timestamp" }
          ]
        },
        {
          matcher: { id: "byName", options: "EventAgeMinutes" },
          properties: [
            { id: "unit", value: "suffix: min" },
            { id: "displayName", value: "Age at last query" }
          ]
        },
        {
          matcher: { id: "byName", options: "QueryObservedAt" },
          properties: [
            { id: "unit", value: "dateTimeAsIso" },
            { id: "displayName", value: "Query observed at" },
            { id: "noValue", value: "Observation unavailable" }
          ]
        }
      ]);
    });

    it("selects time and string fields explicitly instead of silently displaying only numeric stats", async () => {
      const dashboard = await loadDashboardJson();
      const frames = [
        {
          panelId: 1,
          columns: ["TotalEvents", "Observation"],
          rows: [[4, "Matching recorded events"], [0, "No recorded events in selected time range"],
            [0, "No events matching selected filters"]]
        },
        {
          panelId: 6,
          columns: ["LatestEventTime", "EventAgeMinutes", "QueryObservedAt"],
          rows: [
            ["2026-09-17T00:00:00Z", 120, "2026-09-17T02:00:00Z"],
            [null, null, "2026-09-17T02:00:00Z"]
          ]
        }
      ];
      for (const frame of frames) {
        const panel = dashboard.panels.find((item) => item.id === frame.panelId)!;
        const selector = panel.options.reduceOptions!.fields;
        expect(selector).toMatch(/^\/\^\(.+\)\$\/$/);
        const selected = frame.columns.filter((name) => new RegExp(selector.slice(1, -1)).test(name));
        expect(selected).toEqual(frame.columns);
        for (const row of frame.rows) expect(selected.map((name) => row[frame.columns.indexOf(name)])).toEqual(row);
      }
      const query = dashboard.panels.find((item) => item.id === 6)!.targets[0].azureLogAnalytics.query;
      expect(query).toContain("QueryObservedAt = now()");
      expect(query).toContain("| project LatestEventTime, EventAgeMinutes, QueryObservedAt");
      expect(query).not.toMatch(/coalesce|datetime\(0\)|iff\(isnull/);
    });

    it("distinguishes successful empty scopes without swallowing errors or manufacturing zero denominators", async () => {
      const dashboard = await loadDashboardJson();
      const total = dashboard.panels.find((panel) => panel.id === 1)!;
      expect(total.targets[0].azureLogAnalytics.query).toContain(
        '| extend Observation = case(TotalEvents > 0, "Matching recorded events", set_has_element(command_values, "All") and set_has_element(version_values, "All"), "No recorded events in selected time range", "No events matching selected filters")'
      );
      expect(total.fieldConfig.defaults.noValue).toBe("Observation unavailable");
      for (const panel of dashboard.panels) {
        const query = panel.targets[0].azureLogAnalytics.query;
        expect(query).not.toMatch(/isfuzzy|best_effort|coalesce|union\s+.*datatable|try\s*\(/);
        expect(panel).not.toHaveProperty("transformations");
      }
      const outcomes = dashboard.panels.find((panel) => panel.id === 5)!;
      expect(outcomes.targets[0].azureLogAnalytics.query).toContain('"Unknown outcome"');
      expect(outcomes.targets[0].azureLogAnalytics.query).not.toMatch(/\/\s*(TotalEvents|count\()/);
    });

    it("uses non-overlapping native layout space for visible observations and labelled outcomes", async () => {
      const { panels } = await loadDashboardJson();
      for (const panel of panels) {
        const a = panel.gridPos;
        expect(a.x).toBeGreaterThanOrEqual(0);
        expect(a.y).toBeGreaterThanOrEqual(0);
        expect(a.x + a.w).toBeLessThanOrEqual(24);
        expect(a.h).toBeGreaterThanOrEqual(6);
        for (const other of panels.filter((item) => item.id !== panel.id)) {
          const b = other.gridPos;
          expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
        }
      }
    });
  });

  describe("17.4 & 17.8: Query-backed variables, 180-day retention cap, and safe variable binding", () => {
    it("implements bounded time-filtered query-backed variable choices avoiding unescaped custom All injection", async () => {
      const dashboard = await loadDashboardJson();
      expect(dashboard.templating.list).toHaveLength(2);

      const commandVar = dashboard.templating.list.find((v) => v.name === "command")!;
      const versionVar = dashboard.templating.list.find((v) => v.name === "cliVersion")!;

      expect(commandVar).toBeDefined();
      expect(commandVar.type).toBe("query");
      expect(commandVar.datasource.type).toBe("grafana-azure-monitor-datasource");
      expect(commandVar.query.queryType).toBe("Azure Log Analytics");
      expect(commandVar.query.azureLogAnalytics.resources[0]).toBe("__WORKSPACE_ID__");

      expect(commandVar.query.azureLogAnalytics.query).toContain("LiftoffCommandEvents_CL");
      expect(commandVar.query.azureLogAnalytics.query).toContain("| where TimeGenerated >= ago(180d)");
      expect(commandVar.query.azureLogAnalytics.query).toContain("| where $__timeFilter(TimeGenerated)");
      expect(commandVar.query.azureLogAnalytics.query).toContain("| distinct Command");
      expect(commandVar.query.azureLogAnalytics.query).toContain("| top 100 by Command asc");

      expect(commandVar.query.azureLogAnalytics.query).toMatch(/^union \(print Command = "All"\), \(LiftoffCommandEvents_CL/);
      expect(commandVar.includeAll).toBe(false);
      expect(commandVar.allValue).toBeNull();
      expect(commandVar.current.value).toBe("All");
      expect(commandVar.current.text).toBe("All");
      expect(commandVar.refresh).toBe(2);
      expect(commandVar.query.rawQuery).toBe(commandVar.query.azureLogAnalytics.query);

      expect(versionVar).toBeDefined();
      expect(versionVar.type).toBe("query");
      expect(versionVar.datasource.type).toBe("grafana-azure-monitor-datasource");
      expect(versionVar.query.queryType).toBe("Azure Log Analytics");
      expect(versionVar.query.azureLogAnalytics.resources[0]).toBe("__WORKSPACE_ID__");

      expect(versionVar.query.azureLogAnalytics.query).toContain("LiftoffCommandEvents_CL");
      expect(versionVar.query.azureLogAnalytics.query).toContain("| where TimeGenerated >= ago(180d)");
      expect(versionVar.query.azureLogAnalytics.query).toContain("| where $__timeFilter(TimeGenerated)");
      expect(versionVar.query.azureLogAnalytics.query).toContain("| distinct CliVersion");
      expect(versionVar.query.azureLogAnalytics.query).toContain("| top 100 by CliVersion desc");

      expect(versionVar.query.azureLogAnalytics.query).toMatch(/^union \(print CliVersion = "All"\), \(LiftoffCommandEvents_CL/);
      expect(versionVar.includeAll).toBe(false);
      expect(versionVar.allValue).toBeNull();
      expect(versionVar.current.value).toBe("All");
      expect(versionVar.current.text).toBe("All");
      expect(versionVar.refresh).toBe(2);
      expect(versionVar.query.rawQuery).toBe(versionVar.query.azureLogAnalytics.query);
    });

    it("enforces the actual 180-day retention bound in EVERY committed panel query", async () => {
      const dashboard = await loadDashboardJson();

      for (const panel of dashboard.panels) {
        for (const target of panel.targets) {
          const query = target.azureLogAnalytics.query;
          expect(
            query,
            `Panel ${panel.id} (${panel.title}) must enforce 180-day retention bound`
          ).toContain("| where TimeGenerated >= ago(180d)");
        }
      }
    });

    it("uses injection-safe dynamic bindings dynamic(${var:json}) and never raw quoted strings", async () => {
      const dashboard = await loadDashboardJson();

      for (const panel of dashboard.panels) {
        for (const target of panel.targets) {
          const query = target.azureLogAnalytics.query;

          expect(query).toContain("let selected_command = dynamic(${command:json});");
          expect(query).toContain("let selected_version = dynamic(${cliVersion:json});");
          expect(query).toContain('let command_values = iff(gettype(selected_command) == "array", selected_command, pack_array(tostring(selected_command)));');
          expect(query).toContain('let version_values = iff(gettype(selected_version) == "array", selected_version, pack_array(tostring(selected_version)));');
          expect(query).toContain('| where (set_has_element(command_values, "All") or Command in (command_values))');
          expect(query).toContain('| where (set_has_element(version_values, "All") or CliVersion in (version_values))');
          expect(query).not.toMatch(/\bhas\b|\$__all/);

          expect(query).not.toContain("'$command'");
          expect(query).not.toContain("'$cliVersion'");
          expect(query).not.toContain('"$command"');
          expect(query).not.toContain('"$cliVersion"');
        }
      }
    });

    it("keeps JSON-formatted URL variable values inside the actual committed query literals", async () => {
      const values: Array<string | string[]> = [
        "All", "infra:plan", ["infra:plan", "init"], "prefix All suffix",
        '"); union OtherTable; //', "' or 1==1", "line\nbreak\\end"
      ];
      const dashboard = await loadDashboardJson();
      for (const panel of dashboard.panels) {
        const query = panel.targets[0].azureLogAnalytics.query;
        for (const value of values) {
          const rendered = query
            .replace("${command:json}", JSON.stringify(value))
            .replace("${cliVersion:json}", JSON.stringify("0.13.0"));
          const binding = /^let selected_command = dynamic\((.+)\);\n/.exec(rendered);
          expect(binding, `Panel ${panel.id} keeps one JSON literal`).not.toBeNull();
          expect(JSON.parse(binding![1])).toEqual(value);
          expect(rendered.slice(rendered.indexOf("\nlet command_values")))
            .toBe(query.slice(query.indexOf("\nlet command_values")));
        }
      }
    });

    it("references only the six Liftoff-defined telemetry columns across all committed queries", async () => {
      const dashboard = await loadDashboardJson();

      for (const panel of dashboard.panels) {
        for (const target of panel.targets) {
          const rawQuery = target.azureLogAnalytics.query;
          expect(rawQuery).toContain("LiftoffCommandEvents_CL");

          const queryWithoutStrings = rawQuery.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
          const identifiers = queryWithoutStrings.match(/\b([A-Z][a-zA-Z0-9_]+)\b/g) || [];
          for (const ident of identifiers) {
            expect(
              APPROVED_COLUMNS_AND_ALIASES.has(ident),
              `Query identifier '${ident}' in panel ${panel.id} is an approved column or alias`
            ).toBe(true);
          }
        }
      }
    });

    it("ensures all committed panel queries have bounded aggregations", async () => {
      const dashboard = await loadDashboardJson();

      for (const panel of dashboard.panels) {
        for (const target of panel.targets) {
          const query = target.azureLogAnalytics.query;
          const hasBounding =
            query.includes("summarize TotalEvents = count()") ||
            query.includes("summarize EventCount = count()") ||
            query.includes("summarize LatestEventTime = max(TimeGenerated)") ||
            query.includes("top 50 by EventCount desc");
          expect(hasBounding, `Panel ${panel.id} query must bound results`).toBe(true);
        }
      }
    });
  });

  describe("17.6: Current-user authorization and access independence", () => {
    it("requires no shared credentials, client secrets, or ingestion-identity reuse", async () => {
      const dashboardTf = await loadTofuFile("dashboard.tf");
      const outputs = await loadTofuFile("outputs.tf");

      expect(dashboardTf).not.toMatch(/client_secret|api_key|shared_key|connection_string/i);
      expect(dashboardTf).not.toMatch(/azurerm_user_assigned_identity\.telemetry\.client_id/);
      expect(dashboardTf).not.toMatch(/azurerm_user_assigned_identity\.telemetry\.principal_id/);
      expect(outputs).not.toMatch(/client_secret|api_key|password/i);
    });
  });

  describe("17.10: Repeat no-op provisioning, drift detection, and rollback safety", () => {
    it("manages only the documented dashboard pair without ignoring definition drift or adding effects", async () => {
      const parsed = await parseHcl("dashboard.tf", await loadTofuFile("dashboard.tf"));
      expect(Object.keys(parsed).sort()).toEqual(["locals", "resource"]);
      expect(Object.keys(parsed.resource)).toEqual(["azapi_resource"]);
      const resources = parsed.resource.azapi_resource;
      expect(Object.keys(resources).sort()).toEqual(["telemetry_dashboard", "telemetry_dashboard_definition"]);
      expect(resources.telemetry_dashboard_definition).toEqual([{
        type: "Microsoft.Dashboard/dashboards/dashboardDefinitions@2025-09-01-preview",
        name: "default",
        parent_id: "${azapi_resource.telemetry_dashboard.id}",
        body: { properties: { serializedData: "${local.dashboard_definition_json}" } }
      }]);
      expect(resources.telemetry_dashboard).toEqual([{
        type: "Microsoft.Dashboard/dashboards@2025-08-01",
        name: "${local.dashboard_name}",
        parent_id: "${azurerm_resource_group.telemetry.id}",
        location: "${var.location}",
        tags: '${merge(local.common_tags, {\n    GrafanaDashboardTags = join(",", jsondecode(local.dashboard_definition_json).tags)\n  })}',
        body: { properties: {} }
      }]);
    });

    it("verifies that dashboard configuration can be rolled back without affecting data or storage perimeter", async () => {
      const [mainTf, containerAppTf] = await Promise.all([
        loadTofuFile("main.tf"),
        loadTofuFile("container-app.tf")
      ]);

      expect(mainTf).not.toContain("azapi_resource.telemetry_dashboard");
      expect(mainTf).not.toContain("telemetry_dashboard_definition");
      expect(containerAppTf).not.toContain("azapi_resource.telemetry_dashboard");
      expect(mainTf).toContain("prevent_destroy = true");
    });

    it("declares ARM naming preconditions consistently in dashboard_name input", async () => {
      const variables = await parseHcl("variables.tf", await loadTofuFile("variables.tf"));
      const validation = variables.variable.dashboard_name[0].validation[0];
      const dashboardNamePattern = /^[a-zA-Z][a-z0-9A-Z-]{0,28}[a-z0-9A-Z]$/;
      expect(validation.condition).toContain(dashboardNamePattern.source);
      expect(validation.error_message).toContain("2-30 characters");
      expect(validation.error_message).toContain("starting with a letter");

      expect(dashboardNamePattern.test("liftoff-telemetry")).toBe(true);
      expect(dashboardNamePattern.test("telemetry-prod01")).toBe(true);
      expect(dashboardNamePattern.test("ab")).toBe(true);
      expect(dashboardNamePattern.test("a")).toBe(false);
      expect(dashboardNamePattern.test("1dashboard")).toBe(false);
      expect(dashboardNamePattern.test("-leading-hyphen")).toBe(false);
      expect(dashboardNamePattern.test("trailing-hyphen-")).toBe(false);
      expect(dashboardNamePattern.test("has_underscore")).toBe(false);
      expect(dashboardNamePattern.test("a".repeat(31))).toBe(false);
    });
  });

});
