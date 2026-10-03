import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTelemetryDelivery, deliverPreparedTelemetry, maximumTelemetryDeliveryMs,
  type TelemetryDelivery, type TelemetryDeliveryOptions, type TelemetryFetch
} from '../src/telemetry/delivery.js';
import {
  createSemanticTelemetryEvent, createTelemetryEvent, isProjectTelemetryEvent, isTelemetryCommandEvent,
  type ProjectTelemetryEvent
} from '../src/telemetry/contract.js';

const commandEndpoint = 'https://telemetry.example.test/api/events';
const projectEndpoint = 'https://telemetry.example.test/api/projects';
const command = { endpoint: commandEndpoint, event: createTelemetryEvent('update', '0.12.3', 2) };
const projectEvent: ProjectTelemetryEvent = {
  schemaVersion: 2, event: 'project_observed', projectId: '550e8400-e29b-41d4-a716-446655440000',
  cliVersion: '0.12.3', policyProfile: 'none', policyVersion: 'none',
  templateSetDigest: `sha256:${'a'.repeat(64)}`, source: 'cli'
};
const project = { endpoint: projectEndpoint, event: projectEvent };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let now = 0;
const sessions: TelemetryDelivery[] = [];
function session(options: TelemetryDeliveryOptions = {}) {
  const value = createTelemetryDelivery({ env: {}, now: () => now, ...options });
  sessions.push(value);
  return value;
}
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(0);
  now += ms;
  await vi.advanceTimersByTimeAsync(ms);
}
beforeEach(() => { now = 0; vi.useFakeTimers(); });
afterEach(() => { for (const value of sessions.splice(0)) value.close(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('private telemetry delivery foundation', () => {
  it.each([
    createTelemetryEvent('update', '0.12.3', 2),
    createSemanticTelemetryEvent('update', '0.12.3', 'attention-required')
  ])('sends one exact command payload without reinterpreting schema $schemaVersion', async event => {
    const fetch = vi.fn<TelemetryFetch>().mockResolvedValue(new Response(null, { status: 204 }));
    expect(await deliverPreparedTelemetry({ command: { endpoint: commandEndpoint, event } }, { env: {}, fetch, now: () => now }))
      .toEqual({ command: { status: 'delivered', attempted: true } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual(event);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts both ready slots concurrently and does not inspect response bodies', async () => {
    const first = deferred<Response>(), second = deferred<Response>();
    const fetch = vi.fn<TelemetryFetch>().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const result = deliverPreparedTelemetry({ command, project }, { env: {}, fetch, now: () => now });
    await advance(0);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([commandEndpoint, projectEndpoint]);
    expect(fetch.mock.calls[0][1]?.signal).toBe(fetch.mock.calls[1][1]?.signal);
    const response = new Response(null, { status: 204 });
    const body = vi.spyOn(response, 'text');
    const json = vi.spyOn(response, 'json');
    first.resolve(response); second.resolve(response);
    expect(await result).toEqual({
      command: { status: 'delivered', attempted: true }, project: { status: 'delivered', attempted: true }
    });
    expect(body).not.toHaveBeenCalled(); expect(json).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['command', 'project'] as const)('does not give slow %s a second independent budget', async slow => {
    const fetch = vi.fn<TelemetryFetch>().mockImplementation(input =>
      String(input) === (slow === 'command' ? commandEndpoint : projectEndpoint)
        ? new Promise<Response>(() => {}) : Promise.resolve(new Response(null, { status: 204 })));
    let settled = false;
    const result = deliverPreparedTelemetry({ command, project }, { env: {}, fetch, now: () => now }).then(value => { settled = true; return value; });
    await advance(999);
    expect(settled).toBe(false); expect(fetch).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(1);
    await advance(1);
    expect(await result).toEqual({
      command: slow === 'command' ? { status: 'failed', reason: 'budget-expired', attempted: true } : { status: 'delivered', attempted: true },
      project: slow === 'project' ? { status: 'failed', reason: 'budget-expired', attempted: true } : { status: 'delivered', attempted: true }
    });
    expect(fetch.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(now).toBe(maximumTelemetryDeliveryMs); expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds both ignored-abort transports and contains a late resolution and rejection', async () => {
    const first = deferred<Response>(), second = deferred<Response>();
    const fetch = vi.fn<TelemetryFetch>().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const result = deliverPreparedTelemetry({ command, project }, { env: {}, fetch, now: () => now });
    await advance(1_000);
    const stopped = await result;
    expect(stopped).toEqual({
      command: { status: 'failed', reason: 'budget-expired', attempted: true },
      project: { status: 'failed', reason: 'budget-expired', attempted: true }
    });
    first.resolve(new Response(null, { status: 204 })); second.reject(new Error('late rejection'));
    await advance(1);
    expect(await result).toBe(stopped); expect(fetch).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });

  it('includes pending observation preparation and prevents its expired continuation from sending', async () => {
    const prepared = deferred<void>();
    const fetch = vi.fn<TelemetryFetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const delivery = session({ fetch });
    const result = delivery.withinBudget(async () => { await prepared.promise; return delivery.deliver({ project }); });
    await advance(1_000);
    expect(await result).toEqual({ status: 'failed', reason: 'budget-expired' });
    prepared.resolve();
    await advance(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(await delivery.deliver({ command })).toEqual({ command: { status: 'failed', reason: 'budget-expired', attempted: false } });
  });

  it('uses remaining time after an earlier completed hook, not a fresh timeout per await', async () => {
    const hook = deferred<void>();
    const delivery = session({ fetch: () => new Promise<Response>(() => {}) });
    const first = delivery.withinBudget(() => hook.promise);
    await advance(750); hook.resolve(); await first;
    const result = delivery.deliver({ project });
    await advance(249);
    expect(delivery.signal.aborted).toBe(false);
    await advance(1);
    expect(await result).toEqual({ project: { status: 'failed', reason: 'budget-expired', attempted: true } });
  });

  it('checks the absolute deadline even before its timer callback can run', async () => {
    const response = deferred<Response>(), fetch = vi.fn<TelemetryFetch>().mockReturnValue(response.promise);
    const delivery = session({ fetch }), result = delivery.deliver({ command });
    await advance(0);
    now = 1_000;
    response.resolve(new Response(null, { status: 204 }));
    expect(await result).toEqual({ command: { status: 'failed', reason: 'budget-expired', attempted: true } });
    expect(delivery.signal.aborted).toBe(true);
    const unused = vi.fn(async () => {});
    expect(await delivery.withinBudget(unused)).toEqual({ status: 'failed', reason: 'budget-expired' });
    expect(unused).not.toHaveBeenCalled();
  });

  it('accepts a response just inside the same deadline', async () => {
    const response = deferred<Response>(), delivery = session({ fetch: () => response.promise });
    const result = delivery.deliver({ command });
    await advance(999); response.resolve(new Response(null, { status: 204 }));
    expect(await result).toEqual({ command: { status: 'delivered', attempted: true } });
    delivery.close(); expect(vi.getTimerCount()).toBe(0);
  });

  it.each([10, 5_000])('limits a requested timeout of %s without extending the maximum', async timeoutMs => {
    const fetch = vi.fn<TelemetryFetch>(() => new Promise<Response>(() => {}));
    const result = deliverPreparedTelemetry({ command }, { env: {}, fetch, timeoutMs, now: () => now });
    const limit = Math.min(timeoutMs, 1_000);
    await advance(limit - 1);
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await advance(1);
    expect(await result).toEqual({ command: { status: 'failed', reason: 'budget-expired', attempted: true } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, NaN, Infinity])('never dispatches with exhausted or invalid budget %s', async timeoutMs => {
    const fetch = vi.fn<TelemetryFetch>();
    expect(await deliverPreparedTelemetry({ command }, { env: {}, fetch, timeoutMs, now: () => now })).toEqual({
      command: { status: 'failed', reason: timeoutMs === 0 ? 'budget-expired' : 'invalid-budget', attempted: false }
    });
    expect(fetch).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('claims a slot once before fetch, including a synchronous transport throw', async () => {
    const fetch = vi.fn<TelemetryFetch>(() => { throw new Error('sync failure'); });
    const delivery = session({ fetch });
    expect(await delivery.deliver({ command })).toEqual({ command: { status: 'failed', reason: 'network', attempted: true } });
    expect(await delivery.deliver({ command: { ...command, event: createSemanticTelemetryEvent('update', '0.12.3', 'attention-required') } }))
      .toEqual({ command: { status: 'failed', reason: 'duplicate-channel', attempted: false } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('prevents concurrent duplicate submissions while the first is pending', async () => {
    const response = deferred<Response>(), fetch = vi.fn<TelemetryFetch>().mockReturnValue(response.promise);
    const delivery = session({ fetch }), first = delivery.deliver({ command });
    expect(await delivery.deliver({ command })).toEqual({ command: { status: 'failed', reason: 'duplicate-channel', attempted: false } });
    response.resolve(new Response(null, { status: 204 })); await first;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps failures independent across the two fixed channels with no retry or recursion', async () => {
    const fetch = vi.fn<TelemetryFetch>().mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response(null, { status: 204 })).mockRejectedValueOnce(new Error('still offline'));
    expect(await deliverPreparedTelemetry({ command, project }, { env: {}, fetch, now: () => now })).toEqual({
      command: { status: 'failed', reason: 'network', attempted: true }, project: { status: 'delivered', attempted: true }
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await deliverPreparedTelemetry({ project }, { env: {}, fetch, now: () => now }))
      .toEqual({ project: { status: 'failed', reason: 'network', attempted: true } });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([302, 400, 503])('reports HTTP %s without following redirects or consuming the body', async status => {
    const response = new Response('untrusted body', { status }), text = vi.spyOn(response, 'text');
    const fetch = vi.fn<TelemetryFetch>().mockResolvedValue(response);
    expect(await deliverPreparedTelemetry({ project }, { env: {}, fetch, now: () => now }))
      .toEqual({ project: { status: 'failed', reason: 'http-rejected', attempted: true } });
    expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0][1]?.redirect).toBe('error'); expect(text).not.toHaveBeenCalled();
  });

  it.each(['', 'not a URL', 'http://telemetry.example.test', 'https://user:secret@telemetry.example.test'])('rejects invalid endpoint %s without dispatch', async endpoint => {
    const fetch = vi.fn<TelemetryFetch>();
    expect(await deliverPreparedTelemetry({ project: { ...project, endpoint } }, { env: {}, fetch, now: () => now }))
      .toEqual({ project: { status: 'failed', reason: 'invalid-endpoint', attempted: false } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { env: { DO_NOT_TRACK: '1' }, reason: 'global-opt-out' },
    { env: { LIFTOFF_TELEMETRY: '0' }, reason: 'global-opt-out' },
    { env: { CI: 'true' }, reason: 'ordinary-ci' },
    { env: { CI: 'true', DO_NOT_TRACK: '1', LIFTOFF_TELEMETRY: '1' }, reason: 'global-opt-out' }
  ])('disables both prepared slots before transport for $env', async ({ env, reason }) => {
    const fetch = vi.fn<TelemetryFetch>();
    expect(await deliverPreparedTelemetry({ command, project: { ...project, event: { ...projectEvent, source: 'ci-heartbeat' } } }, { env, fetch, now: () => now }))
      .toEqual({ command: { status: 'disabled', reason, attempted: false }, project: { status: 'disabled', reason, attempted: false } });
    expect(fetch).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it('has no implicit project slot, enrollment, discovery, or aggregate emission', async () => {
    const fetch = vi.fn<TelemetryFetch>().mockResolvedValue(new Response(null, { status: 204 }));
    expect(await deliverPreparedTelemetry({}, { env: {}, fetch, now: () => now })).toEqual({});
    expect(fetch).not.toHaveBeenCalled();
    expect(await deliverPreparedTelemetry({ project }, { env: {}, fetch, now: () => now }))
      .toEqual({ project: { status: 'delivered', attempted: true } });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([projectEndpoint]);
  });

  it('rechecks opt-outs before a scheduled request can dispatch', async () => {
    const env: NodeJS.ProcessEnv = {};
    const fetch = vi.fn<TelemetryFetch>(), delivery = session({ env, fetch });
    const result = delivery.deliver({ command });
    env.DO_NOT_TRACK = '1';
    expect(await result).toEqual({ command: { status: 'disabled', reason: 'global-opt-out', attempted: false } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    null, [], { ...command.event, schemaVersion: 3 }, { ...command.event, outcome: 'attention-required' },
    { ...command.event, command: 'governance:assess' }, { ...command.event, cliVersion: '0.12.3+private' },
    { ...command.event, projectId: projectEvent.projectId }, { ...command.event, error: 'x'.repeat(2_000) }
  ])('rejects malformed or oversized command payload %#', async event => {
    const fetch = vi.fn<TelemetryFetch>(), delivery = session({ fetch });
    expect(isTelemetryCommandEvent(event)).toBe(false);
    expect(await Reflect.apply(delivery.deliver, undefined, [{ command: { endpoint: commandEndpoint, event } }]))
      .toEqual({ command: { status: 'failed', reason: 'invalid-payload', attempted: false } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { ...projectEvent, projectId: ['550e8400-e29b-41d4-a716-446655440000'] },
    { ...projectEvent, projectId: 'x'.repeat(2_000) }, { ...projectEvent, source: 'background' },
    { ...projectEvent, policyProfile: 'none', policyVersion: 7 }, { ...projectEvent, templateSetDigest: 'raw project identity' },
    { ...projectEvent, timestamp: '2026-10-03' }, { ...projectEvent, schemaVersion: 1 }, command.event
  ])('rejects malformed or mixed project payload %#', async event => {
    const fetch = vi.fn<TelemetryFetch>(), delivery = session({ fetch });
    expect(isProjectTelemetryEvent(event)).toBe(false);
    expect(await Reflect.apply(delivery.deliver, undefined, [{ project: { endpoint: projectEndpoint, event } }]))
      .toEqual({ project: { status: 'failed', reason: 'invalid-payload', attempted: false } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects accessor and inherited-serializer payloads without invoking them', async () => {
    const fetch = vi.fn<TelemetryFetch>(), getter = vi.fn(() => 'update'), serializer = vi.fn(() => ({ secret: 'private' }));
    const event = { ...command.event };
    Object.defineProperty(event, 'command', { get: getter, enumerable: true });
    const inherited = Object.setPrototypeOf({ ...command.event }, { toJSON: serializer });
    for (const value of [event, inherited]) {
      expect(await deliverPreparedTelemetry({ command: { endpoint: commandEndpoint, event: value } }, { env: {}, fetch, now: () => now }))
        .toEqual({ command: { status: 'failed', reason: 'invalid-payload', attempted: false } });
    }
    expect(getter).not.toHaveBeenCalled(); expect(serializer).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it('snapshots valid payload bytes before caller mutation can change the request', async () => {
    const fetch = vi.fn<TelemetryFetch>().mockResolvedValue(new Response(null, { status: 204 })), event = createTelemetryEvent('help', '0.12.3', 0);
    const delivery = session({ fetch }), result = delivery.deliver({ command: { endpoint: commandEndpoint, event } });
    event.command = 'update';
    await result;
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).command).toBe('help');
  });

  it('rejects arbitrary channels and never dispatches beyond the fixed slots', async () => {
    const fetch = vi.fn<TelemetryFetch>(), delivery = session({ fetch });
    await expect(Reflect.apply(delivery.deliver, undefined, [{ command, third: project }])).rejects.toThrow(/only command and project/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('closes pending work without allowing new continuations and clears its timer', async () => {
    const fetch = vi.fn<TelemetryFetch>(() => new Promise<Response>(() => {})), delivery = session({ fetch });
    const result = delivery.deliver({ command });
    await advance(0); delivery.close();
    expect(await result).toEqual({ command: { status: 'failed', reason: 'closed', attempted: true } });
    expect(await delivery.deliver({ project })).toEqual({ project: { status: 'failed', reason: 'closed', attempted: false } });
    expect(fetch).toHaveBeenCalledTimes(1); expect(delivery.signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });

  it('contains preparation failures and isolates concurrent invocation deadlines', async () => {
    const first = session({ timeoutMs: 10 }), second = session({ timeoutMs: 100 });
    expect(await first.withinBudget(async () => { throw new Error('private details'); }))
      .toEqual({ status: 'failed', reason: 'operation-failed' });
    const waiting = second.withinBudget(() => new Promise<void>(() => {}));
    await advance(10);
    expect(first.signal.aborted).toBe(true); expect(second.signal.aborted).toBe(false);
    await advance(90);
    expect(await waiting).toEqual({ status: 'failed', reason: 'budget-expired' });
  });
});
