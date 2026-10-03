import path from 'node:path';
import type { ExternalCommand } from '../../src/domain/project/contracts.js';
import type { CommandResult, CommandRunner, RunCommandOptions } from '../../src/process-runner.js';
import {
  workstationRequirementCatalog, type LinuxFamily, type SupportedPlatform, type WorkstationRequirementId
} from '../../src/workstation-catalog.js';
import type {
  ExecutableIdentity, ExecutableObserver, InstallResult, NoProgressRemediationAttempt, RemediationAttempt,
  RequirementProbeResult, SelectedRequirement, WorkstationNoProgressStore, WorkstationProbeOptions
} from '../../src/workstation.js';
import { CaptureStream } from '../helpers.js';

export type EngineTraceEvent =
  | { run: { command: string; cwd: string | null; env: Array<[string, string | null]>; timeoutMs: number | null;
      maxOutputBytes: number | null; stream: boolean | null; stdout: string | null; stderr: string | null } }
  | { observer: 'resolve' | 'inspect'; target: string; platform: string; cwd: string; path: string | null; definition: string }
  | { store: 'find'; recipeId: string; inputFingerprint: string }
  | { store: 'record'; attempt: NoProgressRemediationAttempt };

export type ToolScriptEntry = Partial<CommandResult> | Error | string;
export type ToolScript = Record<string, ToolScriptEntry | ToolScriptEntry[]>;

/** Every location variable read by remediation fingerprints is pinned, so no ambient HOME, PATH or credential leaks in. */
const locationVariables = [
  'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'HOMEBREW_PREFIX', 'HOMEBREW_CELLAR', 'HOMEBREW_CASKROOM',
  'npm_config_prefix', 'NPM_CONFIG_PREFIX', 'NPM_CONFIG_USERCONFIG', 'npm_config_userconfig',
  'UV_TOOL_DIR', 'UV_TOOL_BIN_DIR', 'UV_PYTHON_INSTALL_DIR'
] as const;

export function fixtureRoot(platform: SupportedPlatform): string {
  return platform === 'win32' ? 'C:\\fixture' : path.posix.join('/', 'fixture');
}

export function fixedEnvironment(platform: SupportedPlatform): NodeJS.ProcessEnv {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const root = fixtureRoot(platform);
  const env: NodeJS.ProcessEnv = Object.fromEntries(locationVariables.map((name) => [name, undefined]));
  env.PATH = api.join(root, 'bin');
  env.HOME = api.join(root, 'home');
  if (platform === 'win32') {
    // Neutralize a host-cased Windows alias so the case-insensitive lookup sees only the fixture value.
    env.Path = undefined;
    env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
    env.USERPROFILE = api.join(root, 'home');
    env.APPDATA = api.join(root, 'home', 'AppData', 'Roaming');
    env.LOCALAPPDATA = api.join(root, 'home', 'AppData', 'Local');
  }
  return env;
}

export function requirementFor(id: WorkstationRequirementId, overrides: Partial<SelectedRequirement> = {}): SelectedRequirement {
  const definition = workstationRequirementCatalog[id];
  return {
    id, definition, severity: definition.severity, reasons: ['characterization'],
    ...(definition.minimumVersion ? { minimumVersion: definition.minimumVersion } : {}),
    ...(definition.exactVersion ? { exactVersion: definition.exactVersion } : {}),
    ...(definition.releaseLine ? { releaseLine: definition.releaseLine } : {}),
    allowPrerelease: definition.allowPrerelease ?? false,
    ...overrides
  };
}

export const missingIdentity = (executable: string): ExecutableIdentity =>
  ({ executable, resolution: 'missing', origin: 'unknown', evidence: 'unavailable' });

export function resolvedIdentity(
  executable: string, resolvedPath: string, origin: ExecutableIdentity['origin'] = 'unknown', realPath = resolvedPath
): ExecutableIdentity {
  return { executable, resolution: 'resolved', resolvedPath, realPath, kind: 'executable', origin, evidence: 'path-search' };
}

export class EngineHarness {
  readonly events: EngineTraceEvent[] = [];
  readonly stdout = new CaptureStream();
  readonly stderr = new CaptureStream();
  readonly resolutions: Record<string, ExecutableIdentity> = {};
  readonly inspections: Record<string, ExecutableIdentity> = {};
  storeFind: 'empty' | 'match' | 'throw-error' | 'throw-value' = 'empty';
  storeRecord: 'ok' | 'throw' = 'ok';
  recording = true;

  constructor(readonly platform: SupportedPlatform, readonly linuxFamily: LinuxFamily = 'unknown') {}

  get cwd(): string {
    return (this.platform === 'win32' ? path.win32 : path.posix).join(fixtureRoot(this.platform), 'project');
  }

  readonly observer: ExecutableObserver = {
    resolve: async (executable, context) => {
      this.observe('resolve', executable, context);
      return structuredClone(this.resolutions[executable] ?? missingIdentity(executable));
    },
    inspect: async (candidate, context) => {
      this.observe('inspect', candidate, context);
      return structuredClone(this.inspections[candidate] ?? missingIdentity(candidate));
    }
  };

  readonly store: WorkstationNoProgressStore = {
    find: async (recipeId, inputFingerprint): Promise<RemediationAttempt | null> => {
      if (this.recording) this.events.push({ store: 'find', recipeId, inputFingerprint });
      if (this.storeFind === 'throw-error') throw new Error('fixture no-progress store unavailable');
      if (this.storeFind === 'throw-value') throw 'fixture non-error store failure';
      return this.storeFind === 'match'
        ? { recipeId, inputFingerprint, outputFingerprint: inputFingerprint, outcome: 'unchanged' }
        : null;
    },
    record: async (attempt) => {
      if (this.recording) this.events.push({ store: 'record', attempt: structuredClone(attempt) });
      if (this.storeRecord === 'throw') throw new Error('fixture receipt write failure');
    }
  };

  options(overrides: Partial<WorkstationProbeOptions> = {}): WorkstationProbeOptions {
    return {
      cwd: this.cwd, env: fixedEnvironment(this.platform), host: { platform: this.platform, linuxFamily: this.linuxFamily },
      executableObserver: this.observer, ...overrides
    };
  }

  runner(script: ToolScript): CommandRunner {
    const counts = new Map<string, number>();
    return {
      run: async (command, options) => {
        const key = [command.executable, ...command.args].join(' ');
        if (this.recording) this.events.push({ run: this.record(key, options) });
        const configured = script[key];
        const index = counts.get(key) ?? 0;
        counts.set(key, index + 1);
        const entry = Array.isArray(configured) ? configured[Math.min(index, configured.length - 1)] : configured;
        if (entry instanceof Error) throw entry;
        const base: CommandResult = { command, displayCommand: key, status: 0, signal: null, stdout: '', stderr: '', timedOut: false };
        if (entry === undefined) {
          return { ...base, status: null, errorCode: 'ENOENT', errorMessage: `spawn ${command.executable} ENOENT` };
        }
        return typeof entry === 'string' ? { ...base, stdout: entry } : { ...base, ...entry };
      }
    };
  }

  private observe(kind: 'resolve' | 'inspect', target: string, context: Parameters<ExecutableObserver['resolve']>[1]): void {
    if (!this.recording) return;
    this.events.push({
      observer: kind, target, platform: context.platform, cwd: context.cwd,
      path: context.env.PATH ?? null, definition: context.definition.id
    });
  }

  private record(key: string, options?: RunCommandOptions): Extract<EngineTraceEvent, { run: unknown }>['run'] {
    const stream = (value: unknown) => value === undefined ? null : value === this.stdout ? 'harness.stdout'
      : value === this.stderr ? 'harness.stderr' : 'unexpected-stream';
    return {
      command: key,
      cwd: options?.cwd ?? null,
      env: Object.entries(options?.env ?? {}).filter(([, value]) => value !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([name, value]) => [name, value ?? null]),
      timeoutMs: options?.timeoutMs ?? null,
      maxOutputBytes: options?.maxOutputBytes ?? null,
      stream: options?.stream ?? null,
      stdout: stream(options?.stdout),
      stderr: stream(options?.stderr)
    };
  }
}

/** Snapshot form: the catalog definition is referenced by id so unrelated catalog fields do not bloat parity records. */
export function probeRecord(result: RequirementProbeResult) {
  const { requirement, ...rest } = result;
  const { definition, ...selected } = requirement;
  return { requirement: { ...selected, definition: definition.id }, ...rest };
}

export function installRecord(result: InstallResult) {
  const { requirement, probe, recipe, ...rest } = result;
  return { requirement: requirement.id, recipe: recipe?.id ?? null, ...rest, probe: probeRecord(probe) };
}

export function commandKey(command: ExternalCommand): string {
  return [command.executable, ...command.args].join(' ');
}
