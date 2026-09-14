import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { requestRepairApproval } from '../src/application/repair/approval.js';
import type { RepairRequest } from '../src/application/repair/request.js';
import { PresentationSession } from '../src/terminal.js';
import { CaptureStream, scriptedTtyInput, ttyCaptureStream } from './helpers.js';

const fingerprint = 'a'.repeat(64);
const request: RepairRequest = { check: false, live: false, json: false, recover: false };
function context() {
  const stdout = new CaptureStream(), stderr = ttyCaptureStream();
  const stdin = scriptedTtyInput('');
  return { cwd: process.cwd(), stdin, stdout, stderr,
    presentation: new PresentationSession({ stdout, stderr }), approveRepairPlan: vi.fn(async () => true) };
}

describe('action-specific repair consent', () => {
  it('binds readable default-No consent without requiring hash entry', async () => {
    const selected = context();
    const message = 'Apply the displayed exact application file changes?';
    expect(await requestRepairApproval(request, fingerprint, message, selected))
      .toEqual({ status: 'approved', fingerprint, method: 'interactive' });
    expect(selected.approveRepairPlan).toHaveBeenCalledExactlyOnceWith(
      { message, default: false }, { input: selected.stdin, output: selected.stderr }
    );
    expect(message).not.toContain(fingerprint);
  });

  it.each([
    { check: true }, { json: true }, { capabilities: true }, { inspectLayout: true }, { recover: true }
  ])('never prompts or consumes approval in read-only mode %j', async (mode) => {
    const selected = context();
    expect(await requestRepairApproval({ ...request, ...mode }, fingerprint, 'Do not ask', selected))
      .toEqual({ status: 'required', fingerprint });
    expect(selected.approveRepairPlan).not.toHaveBeenCalled();
  });

  it('does not accept piped yes or a generic request field as authority', async () => {
    const selected = context();
    const stdin = Readable.from(['yes\n']);
    const read = vi.spyOn(stdin, 'read');
    const supplied = { ...request, yes: true, force: true, autopilot: true };
    expect(await requestRepairApproval(supplied, fingerprint, 'Apply?', { ...selected, stdin }))
      .toEqual({ status: 'required', fingerprint });
    expect(read).not.toHaveBeenCalled();
    expect(selected.approveRepairPlan).not.toHaveBeenCalled();
  });

  it.each(['ExitPromptError', 'AbortPromptError', 'InteractiveCancelledError'])('cancels %s without approval', async (name) => {
    const selected = context();
    selected.approveRepairPlan.mockRejectedValue(Object.assign(new Error('cancelled'), { name }));
    expect(await requestRepairApproval(request, fingerprint, 'Apply?', selected))
      .toEqual({ status: 'declined', fingerprint, reason: 'cancelled' });
  });

  it('declines No and does not consume EOF or redirected stderr', async () => {
    const selected = context();
    selected.approveRepairPlan.mockResolvedValue(false);
    expect(await requestRepairApproval(request, fingerprint, 'Apply?', selected))
      .toEqual({ status: 'declined', fingerprint, reason: 'declined' });
    selected.approveRepairPlan.mockClear();
    for await (const _chunk of selected.stdin) { /* Drain terminal EOF. */ }
    expect(await requestRepairApproval(request, fingerprint, 'Apply?', selected))
      .toEqual({ status: 'required', fingerprint });
    expect(await requestRepairApproval(request, fingerprint, 'Apply?', { ...context(), stderr: new CaptureStream() }))
      .toEqual({ status: 'required', fingerprint });
    expect(selected.approveRepairPlan).not.toHaveBeenCalled();
  });
});
