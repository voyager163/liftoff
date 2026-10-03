import {
  isProjectTelemetryEvent,
  isTelemetryCommandEvent,
  type ProjectTelemetryEvent,
  type TelemetryCommandEvent
} from './contract.js';

export const maximumTelemetryDeliveryMs = 1_000;
export const maximumTelemetryPayloadBytes = 1_024;

export type TelemetryFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type StopReason = 'budget-expired' | 'closed' | 'invalid-budget';
export type TelemetryDeliveryResult =
  | { readonly status: 'delivered'; readonly attempted: true }
  | { readonly status: 'disabled'; readonly attempted: false; readonly reason: 'global-opt-out' | 'ordinary-ci' }
  | { readonly status: 'failed'; readonly attempted: boolean; readonly reason:
      StopReason | 'invalid-payload' | 'invalid-endpoint' | 'http-rejected' | 'network' | 'duplicate-channel' };

export type TelemetryBudgetResult<T> =
  | { readonly status: 'completed'; readonly value: T }
  | { readonly status: 'failed'; readonly reason: StopReason | 'operation-failed' };

interface PreparedDelivery<T> {
  readonly endpoint: string;
  readonly event: T;
}

// These inputs are not consent or release-ownership proofs. No production project caller exists yet.
export interface PreparedTelemetrySlots {
  readonly command?: PreparedDelivery<TelemetryCommandEvent>;
  readonly project?: PreparedDelivery<ProjectTelemetryEvent>;
}

export interface TelemetryDeliveryResults {
  readonly command?: TelemetryDeliveryResult;
  readonly project?: TelemetryDeliveryResult;
}

export interface TelemetryDeliveryOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: TelemetryFetch;
  timeoutMs?: number;
  now?: () => number;
}

export interface TelemetryDelivery {
  readonly deadline: number;
  readonly signal: AbortSignal;
  withinBudget<T>(action: () => Promise<T>): Promise<TelemetryBudgetResult<T>>;
  deliver(slots: PreparedTelemetrySlots): Promise<TelemetryDeliveryResults>;
  close(): void;
}

export function isTelemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LIFTOFF_TELEMETRY !== '0' && env.DO_NOT_TRACK !== '1' && env.CI !== 'true';
}

export function createTelemetryDelivery(options: TelemetryDeliveryOptions = {}): TelemetryDelivery {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => performance.now());
  const start = now();
  const timeout = options.timeoutMs ?? maximumTelemetryDeliveryMs;
  const validBudget = Number.isFinite(start) && typeof timeout === 'number' && Number.isFinite(timeout) && timeout >= 0;
  const deadline = start + (validBudget ? Math.min(timeout, maximumTelemetryDeliveryMs) : 0);
  const controller = new AbortController();
  const claimed = { command: false, project: false };
  let state: StopReason | undefined = validBudget ? undefined : 'invalid-budget';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveStopped!: (reason: StopReason) => void;
  const stopped = new Promise<StopReason>((resolve) => { resolveStopped = resolve; });

  function disabledResult(): TelemetryDeliveryResult | undefined {
    if (env.LIFTOFF_TELEMETRY === '0' || env.DO_NOT_TRACK === '1') {
      return { status: 'disabled', reason: 'global-opt-out', attempted: false };
    }
    return env.CI === 'true' ? { status: 'disabled', reason: 'ordinary-ci', attempted: false } : undefined;
  }

  function stop(reason: StopReason): void {
    if (state !== undefined) return;
    state = reason;
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
    resolveStopped(reason);
  }

  function currentStop(): StopReason | undefined {
    if (state === undefined && now() >= deadline) stop('budget-expired');
    return state;
  }

  async function withinBudget<T>(action: () => Promise<T>): Promise<TelemetryBudgetResult<T>> {
    const reason = currentStop();
    if (reason) return { status: 'failed', reason };
    timer ??= setTimeout(() => stop('budget-expired'), Math.max(0, deadline - now()));
    const operation = Promise.resolve().then(async (): Promise<TelemetryBudgetResult<T>> => {
      const before = currentStop();
      if (before) return { status: 'failed', reason: before };
      try {
        const value = await action();
        const after = currentStop();
        return after ? { status: 'failed', reason: after } : { status: 'completed', value };
      } catch {
        return { status: 'failed', reason: currentStop() ?? 'operation-failed' };
      }
    });
    return Promise.race([
      operation,
      stopped.then((reason): TelemetryBudgetResult<T> => ({ status: 'failed', reason }))
    ]);
  }

  async function send(
    channel: 'command' | 'project',
    prepared: PreparedDelivery<TelemetryCommandEvent | ProjectTelemetryEvent>
  ): Promise<TelemetryDeliveryResult> {
    const disabled = disabledResult();
    if (disabled) return disabled;
    if (claimed[channel]) return { status: 'failed', reason: 'duplicate-channel', attempted: false };
    claimed[channel] = true;
    const reason = currentStop();
    if (reason) return { status: 'failed', reason, attempted: false };

    let body: string;
    try {
      const event = prepared.event;
      if (!(channel === 'command' ? isTelemetryCommandEvent(event) : isProjectTelemetryEvent(event))) {
        return { status: 'failed', reason: 'invalid-payload', attempted: false };
      }
      body = JSON.stringify(event);
      if (Buffer.byteLength(body, 'utf8') > maximumTelemetryPayloadBytes) {
        return { status: 'failed', reason: 'invalid-payload', attempted: false };
      }
    } catch {
      return { status: 'failed', reason: 'invalid-payload', attempted: false };
    }
    let url: URL;
    try {
      if (typeof prepared.endpoint !== 'string') throw new TypeError('Invalid telemetry endpoint.');
      url = new URL(prepared.endpoint);
      if (url.protocol !== 'https:' || url.username || url.password) throw new TypeError('Invalid telemetry endpoint.');
    } catch {
      return { status: 'failed', reason: 'invalid-endpoint', attempted: false };
    }
    let attempted = false;
    const outcome = await withinBudget(async (): Promise<TelemetryDeliveryResult> => {
      const disabled = disabledResult();
      if (disabled) return disabled;
      const before = currentStop();
      if (before) return { status: 'failed', reason: before, attempted: false };
      attempted = true;
      try {
        const response = await (options.fetch ?? globalThis.fetch.bind(globalThis))(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          redirect: 'error',
          signal: controller.signal
        });
        return response.ok === true
          ? { status: 'delivered', attempted: true }
          : { status: 'failed', reason: 'http-rejected', attempted: true };
      } catch {
        return { status: 'failed', reason: 'network', attempted: true };
      }
    });
    return outcome.status === 'completed' ? outcome.value : {
      status: 'failed', reason: outcome.reason === 'operation-failed' ? 'network' : outcome.reason, attempted
    };
  }

  return Object.freeze({
    deadline,
    signal: controller.signal,
    withinBudget,
    async deliver(slots: PreparedTelemetrySlots): Promise<TelemetryDeliveryResults> {
      if (!slots || typeof slots !== 'object' || Array.isArray(slots) ||
          Reflect.ownKeys(slots).some((key) => key !== 'command' && key !== 'project')) {
        throw new TypeError('Telemetry delivery accepts only command and project slots.');
      }
      const { command: preparedCommand, project: preparedProject } = slots;
      const [command, project] = await Promise.all([
        preparedCommand === undefined ? undefined : send('command', preparedCommand),
        preparedProject === undefined ? undefined : send('project', preparedProject)
      ]);
      return Object.freeze({
        ...(command ? { command: Object.freeze(command) } : {}),
        ...(project ? { project: Object.freeze(project) } : {})
      });
    },
    close: () => stop('closed')
  });
}

export async function deliverPreparedTelemetry(
  slots: PreparedTelemetrySlots,
  options: TelemetryDeliveryOptions = {}
): Promise<TelemetryDeliveryResults> {
  const delivery = createTelemetryDelivery(options);
  try {
    return await delivery.deliver(slots);
  } finally {
    delivery.close();
  }
}
