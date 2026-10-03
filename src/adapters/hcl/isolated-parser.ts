import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { types } from 'node:util';
import {
  hclComputationPolicy as policy, hclFailure, hclRawDigest, makeHclRequest, validateHclReply, validateHclTransport,
  type HclExpression, type HclRequest
} from './parser-child.js';

export { hclComputationPolicy, IsolatedHclError } from './parser-child.js';
export type { HclExpression } from './parser-child.js';
export interface IsolatedHclResult {
  readonly parsed: Record<string, unknown>;
  readonly expressions: ReadonlyMap<string, HclExpression>;
}
let occupied = false;
let unavailable = false;

export function scheduleIsolatedHcl(input: readonly string[]): readonly (readonly string[])[] {
  if (!Array.isArray(input) || types.isProxy(input) || Object.getPrototypeOf(input) !== Array.prototype ||
      input.length > policy.derivationDocuments || Reflect.ownKeys(input).length !== input.length + 1) {
    hclFailure('Isolated HCL requires a bounded dense source array.');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input), captured: string[] = [];
  let total = 0;
  for (let index = 0; index < input.length; index++) {
    const descriptor = descriptors[index];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') hclFailure('Isolated HCL source must be own text data.');
    const text: string = descriptor.value, bytes = Buffer.byteLength(text);
    if (bytes > policy.sourceFileBytes || Buffer.from(text).toString('utf8') !== text) hclFailure('Isolated HCL source exceeds the file limit or is not UTF-8.');
    total += bytes;
    if (total > policy.derivationSourceBytes) hclFailure('Isolated HCL source total exceeds its limit.');
    captured.push(text);
  }
  const batches: string[][] = []; let batch: string[] = [], bytes = 0;
  for (const text of captured) {
    const size = Buffer.byteLength(text);
    if (batch.length && (batch.length === policy.batchDocuments || bytes + size > policy.batchTargetBytes)) {
      batches.push(batch); batch = []; bytes = 0;
    }
    batch.push(text); bytes += size;
  }
  if (batch.length) batches.push(batch);
  if (batches.length > policy.derivationChildren) hclFailure('Isolated HCL computation exceeds the child-count budget.');
  return batches;
}
export function isolatedHclRemaining(elapsed: number, replies: number, expressions: number) {
  if (![elapsed, replies, expressions].every(value => Number.isFinite(value) && value >= 0) ||
      !Number.isSafeInteger(replies) || !Number.isSafeInteger(expressions) ||
      elapsed >= policy.derivationDeadlineMs || replies >= policy.derivationReplyBytes ||
      expressions > policy.expressionRequests) hclFailure('Isolated HCL derivation budget is exhausted.');
  return {
    deadline: Math.min(policy.childDeadlineMs, policy.derivationDeadlineMs - elapsed),
    reply: Math.min(policy.stdoutBytes, policy.derivationReplyBytes - replies),
    expressions: policy.expressionRequests - expressions
  };
}
function runtimeAvailable(): void {
  if (process.platform !== policy.qualifiedRuntime.platform || process.arch !== policy.qualifiedRuntime.arch ||
      process.versions.node !== policy.qualifiedRuntime.node) {
    hclFailure('Isolated HCL computation is unavailable: this runtime is not the qualified darwin/arm64 Node24.21.0 tuple.');
  }
}
interface Workspace {
  readonly root: string;
  readonly identities: ReadonlyMap<string, { dev: number; ino: number; uid: number; mode: number }>;
}
const directoryNames = ['home', 'tmp', 'config', 'cache', 'data', 'state', 'appdata', 'localappdata', 'cwd'] as const;
function workspace(): Workspace {
  const system = realpathSync('/private/tmp'), parent = lstatSync(system);
  if (system !== '/private/tmp' || !parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0 ||
      (parent.mode & 0o1000) === 0) hclFailure('The qualified system parser workspace is unavailable.');
  const root = mkdtempSync(path.join(system, 'liftoff-hcl-'));
  const identities = new Map<string, { dev: number; ino: number; uid: number; mode: number }>();
  function remember(target: string) {
    const stat = lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o700) {
      hclFailure('Parser workspace ownership or mode is invalid.');
    }
    identities.set(target, { dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode });
  }
  remember(root);
  for (const name of directoryNames) { const target = path.join(root, name); mkdirSync(target, { mode: 0o700 }); remember(target); }
  return { root, identities };
}
function cleanup(owned: Workspace): void {
  const names = readdirSync(owned.root).sort();
  if (names.join('\0') !== [...directoryNames].sort().join('\0')) hclFailure('Unexpected parser workspace entries; owned workspace retained.');
  for (const [target, identity] of owned.identities) {
    const stat = lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino ||
        stat.uid !== identity.uid || stat.mode !== identity.mode) hclFailure('Parser workspace identity changed; workspace retained.');
    if (target !== owned.root && readdirSync(target).length) hclFailure('Unexpected parser workspace contents; workspace retained.');
  }
  for (const name of directoryNames) rmdirSync(path.join(owned.root, name));
  rmdirSync(owned.root);
}
function environment(owned: Workspace): NodeJS.ProcessEnv {
  return {
    HOME: path.join(owned.root, 'home'), USERPROFILE: path.join(owned.root, 'home'),
    TMPDIR: path.join(owned.root, 'tmp'), TMP: path.join(owned.root, 'tmp'), TEMP: path.join(owned.root, 'tmp'),
    XDG_CONFIG_HOME: path.join(owned.root, 'config'), XDG_CACHE_HOME: path.join(owned.root, 'cache'),
    XDG_DATA_HOME: path.join(owned.root, 'data'), XDG_STATE_HOME: path.join(owned.root, 'state'),
    APPDATA: path.join(owned.root, 'appdata'), LOCALAPPDATA: path.join(owned.root, 'localappdata'),
    npm_config_userconfig: path.join(owned.root, 'config', 'empty-user.npmrc'),
    npm_config_globalconfig: path.join(owned.root, 'config', 'empty-global.npmrc'),
    npm_config_cache: path.join(owned.root, 'cache'), npm_config_offline: 'true',
    npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false',
    NO_UPDATE_NOTIFIER: '1', NODE_DISABLE_COMPILE_CACHE: '1', LIFTOFF_TELEMETRY: '0',
    DO_NOT_TRACK: '1', NO_COLOR: '1', LANG: 'C', LC_ALL: 'C', TZ: 'UTC'
  };
}
interface ChildOutcome { settled: boolean; success: boolean; bytes: Buffer }
async function runChild(request: HclRequest, owned: Workspace, deadline: number): Promise<ChildOutcome> {
  const input = Buffer.from(JSON.stringify(request));
  if (input.length > policy.requestBytes) hclFailure('Isolated HCL request framing limit.');
  const helper = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './parser-child.ts' : './parser-child.js', import.meta.url));
  const args = [`--wasm-max-mem-pages=${policy.wasmPages}`, `--max-old-space-size=${policy.v8OldSpaceMiB}`,
    `--max-semi-space-size=${policy.v8SemiSpaceMiB}`, helper];
  return new Promise(resolve => {
    let child: ChildProcessWithoutNullStreams;
    let timer: ReturnType<typeof setTimeout> | undefined, stopping: ReturnType<typeof setTimeout> | undefined;
    let exited = false, closed = false, startupFailed = false, transportFailed = false, forced = false, finished = false;
    let outputBytes = 0, diagnosticBytes = 0;
    const output: Buffer[] = [];
    function finish(code: number | null, signal: NodeJS.Signals | null, unsettled = false): void {
      if (finished) return;
      finished = true; clearTimeout(timer); clearTimeout(stopping);
      let absent = child?.pid === undefined;
      if (child?.pid !== undefined) {
        try { process.kill(child.pid, 0); }
        catch (error) { absent = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      }
      const settled = !unsettled && closed && absent && (exited || startupFailed && child?.pid === undefined);
      resolve({ settled, success: settled && code === 0 && signal === null && !forced && !transportFailed &&
        !startupFailed && diagnosticBytes === 0, bytes: Buffer.concat(output) });
    }
    function terminate(): void {
      if (forced || finished) return;
      forced = true;
      if (!exited && child.pid !== undefined) {
        try { child.kill('SIGKILL'); } catch { transportFailed = true; }
      }
      stopping = setTimeout(() => finish(null, null, true), policy.terminationGraceMs);
    }
    try {
      child = spawn(process.execPath, args, { cwd: path.join(owned.root, 'cwd'), env: environment(owned),
        shell: false, detached: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      resolve({ settled: true, success: false, bytes: Buffer.alloc(0) }); return;
    }
    timer = setTimeout(terminate, deadline);
    child.on('error', () => { startupFailed = true; });
    child.stdin.on('error', () => { transportFailed = true; });
    child.stdout.on('error', () => { transportFailed = true; terminate(); });
    child.stderr.on('error', () => { transportFailed = true; terminate(); });
    child.stdout.on('data', (chunk: Buffer) => {
      if (finished || forced) return;
      if (outputBytes + chunk.length > request.replyAllowance) { terminate(); return; }
      outputBytes += chunk.length; output.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      diagnosticBytes += chunk.length;
      if (diagnosticBytes > policy.stderrBytes) terminate();
    });
    child.once('exit', () => { exited = true; });
    child.once('close', (code, signal) => { closed = true; finish(code, signal); });
    try { child.stdin.end(input); } catch { transportFailed = true; terminate(); }
  });
}

/** Fixed CLI computation only; no caller-provided helper, process policy or project filesystem access. */
export async function parseIsolatedHcl(input: readonly string[]): Promise<readonly IsolatedHclResult[]> {
  const batches = scheduleIsolatedHcl(input);
  if (!batches.length) return [];
  runtimeAvailable();
  if (unavailable) hclFailure('Isolated HCL shutdown is unconfirmed; this CLI process cannot admit more parser work.');
  if (occupied) hclFailure('Isolated HCL computation is busy; concurrent derivations are not queued.');
  occupied = true;
  const start = performance.now();
  let replyBytes = 0, expressionCalls = 0;
  const results: IsolatedHclResult[] = [];
  try {
    for (const batch of batches) {
      const remaining = isolatedHclRemaining(performance.now() - start, replyBytes, expressionCalls);
      const request = makeHclRequest(batch.map((text, index) => ({ id: String(index), text, sourceSha256: hclRawDigest(text) })),
        remaining.expressions, remaining.reply);
      let owned: Workspace;
      try { owned = workspace(); } catch { unavailable = true; hclFailure('Cannot establish a verified neutral parser workspace; further computation is unavailable.'); }
      let outcome: ChildOutcome;
      try { outcome = await runChild(request, owned, isolatedHclRemaining(performance.now() - start, replyBytes, expressionCalls).deadline); }
      catch {
        try { cleanup(owned); } catch { unavailable = true; }
        hclFailure('Isolated HCL could not admit the bounded child request.');
      }
      if (!outcome.settled) {
        unavailable = true;
        hclFailure('Isolated HCL child shutdown could not be verified; workspace retained and further computation blocked.');
      }
      try { cleanup(owned); } catch { unavailable = true; hclFailure('Isolated HCL workspace cleanup failed; further computation blocked.'); }
      if (!outcome.success) hclFailure('Isolated HCL computation is unavailable within the admitted resource or transport policy.');
      const raw = outcome.bytes.toString('utf8');
      if (!Buffer.from(raw).equals(outcome.bytes)) hclFailure('Isolated HCL reply is not valid UTF-8.');
      let decoded: unknown;
      try { decoded = JSON.parse(raw); } catch { hclFailure('Isolated HCL reply is malformed or incomplete.'); }
      validateHclTransport(decoded);
      if (JSON.stringify(decoded) !== raw) hclFailure('Isolated HCL reply is not one exact JSON frame.');
      const reply = validateHclReply(decoded, request);
      replyBytes += outcome.bytes.length; expressionCalls += reply.expressionCalls;
      if (performance.now() - start >= policy.derivationDeadlineMs) hclFailure('Isolated HCL derivation deadline exhausted.');
      const expressions = new Map(reply.expressions.map(expression => [expression.value, expression.ast]));
      results.push(...reply.results.map(result => ({ parsed: result.parsed, expressions })));
    }
    return results;
  } finally {
    if (!unavailable) occupied = false;
  }
}
