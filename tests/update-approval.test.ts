import { PassThrough, Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  InvalidUpdateApprovalError,
  isUpdatePlanFingerprint,
  requestUpdateApproval,
  type UpdateApprovalContext,
  type UpdateApprovalPrompt
} from '../src/application/update/approval.js';
import { updateProject } from '../src/application/update/use-case.js';
import { parseArgs, UsageError } from '../src/args.js';
import { updateCommand } from '../src/cli/commands/update.js';
import { PresentationSession } from '../src/terminal.js';
import { CaptureStream, scriptedTtyInput, ttyCaptureStream } from './helpers.js';

vi.mock('../src/application/update/use-case.js', () => ({
  updateProject: vi.fn(async () => 0)
}));

const fingerprint = 'a1'.repeat(32);
const otherFingerprint = 'b2'.repeat(32);

afterEach(() => {
  vi.clearAllMocks();
});

describe('update approval helper', () => {
  it('accepts only complete lowercase fingerprints, including at the application boundary', () => {
    expect(isUpdatePlanFingerprint(fingerprint)).toBe(true);
    expect(isUpdatePlanFingerprint('0'.repeat(64))).toBe(true);
    for (const value of [
      undefined, null, true, 64, {}, '', fingerprint.slice(0, 63), `${fingerprint}0`,
      fingerprint.toUpperCase(), 'g'.repeat(64), `${fingerprint}\n`, ` ${fingerprint}`
    ]) {
      expect(isUpdatePlanFingerprint(value), String(value)).toBe(false);
    }
  });

  it.each(['fingerprint', 'approvePlan'] as const)(
    'rejects an invalid %s before prompting or reading the supplied streams',
    async (field) => {
      const approveUpdatePlan = vi.fn<UpdateApprovalPrompt>();
      const context: UpdateApprovalContext = {
        get stdin(): Readable {
          throw new Error('Input must not be read for an invalid fingerprint.');
        },
        stderr: new CaptureStream(),
        approveUpdatePlan
      };
      await expect(requestUpdateApproval({
        fingerprint,
        approvePlan: fingerprint,
        [field]: `${fingerprint}\n`
      }, context)).rejects.toMatchObject({
        name: 'InvalidUpdateApprovalError',
        field
      });
      expect(approveUpdatePlan).not.toHaveBeenCalled();
    }
  );

  it('does not treat identical invalid plan and approval strings as consent', async () => {
    await expect(requestUpdateApproval({
      fingerprint: 'invalid',
      approvePlan: 'invalid'
    }, { stderr: new CaptureStream() })).rejects.toBeInstanceOf(InvalidUpdateApprovalError);
  });

  it('approves an exact fingerprint without a terminal, prompt, or stream access', async () => {
    const approveUpdatePlan = vi.fn<UpdateApprovalPrompt>();
    const context: UpdateApprovalContext = {
      get stdin(): Readable {
        throw new Error('Explicit approval must not read input.');
      },
      get stderr(): NodeJS.WritableStream {
        throw new Error('Explicit approval must not write prompt output.');
      },
      approveUpdatePlan
    };
    await expect(requestUpdateApproval({
      fingerprint, approvePlan: fingerprint
    }, context)).resolves.toEqual({ status: 'approved', fingerprint, method: 'fingerprint' });
    expect(approveUpdatePlan).not.toHaveBeenCalled();
  });

  it('does not fall back to interactive consent when the effective plan fingerprint differs', async () => {
    const approveUpdatePlan = vi.fn<UpdateApprovalPrompt>().mockResolvedValue(true);
    const stderr = ttyCaptureStream();
    await expect(requestUpdateApproval({
      fingerprint, approvePlan: otherFingerprint
    }, {
      stdin: scriptedTtyInput('yes\n'),
      stderr,
      approveUpdatePlan
    })).resolves.toEqual({
      status: 'mismatch',
      fingerprint,
      requestedFingerprint: otherFingerprint
    });
    expect(approveUpdatePlan).not.toHaveBeenCalled();
    expect(stderr.text()).toBe('');
  });

  it('requires approval when stdin is missing, even with an injected acceptance callback', async () => {
    const approveUpdatePlan = vi.fn<UpdateApprovalPrompt>().mockResolvedValue(true);
    const stderr = ttyCaptureStream();
    await expect(requestUpdateApproval({ fingerprint }, {
      stderr, approveUpdatePlan
    })).resolves.toEqual({ status: 'required', fingerprint });
    expect(approveUpdatePlan).not.toHaveBeenCalled();
    expect(stderr.text()).toBe('');
  });

  it('does not infer consent from redirected yes input, JSON, force, or generic yes', async () => {
    const approveUpdatePlan = vi.fn<UpdateApprovalPrompt>().mockResolvedValue(true);
    const stdin = Readable.from(['yes\n']);
    const read = vi.spyOn(stdin, 'read');
    const stderr = ttyCaptureStream();
    const request = { fingerprint, jsonMode: true, force: true, yes: true };
    await expect(requestUpdateApproval(request, {
      stdin, stderr, approveUpdatePlan
    })).resolves.toEqual({ status: 'required', fingerprint });
    expect(approveUpdatePlan).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(stderr.text()).toBe('');
  });

  it('requires an interactive stderr rather than prompting into redirected output', async () => {
    const approveUpdatePlan = vi.fn<UpdateApprovalPrompt>().mockResolvedValue(true);
    const stderr = new CaptureStream();
    await expect(requestUpdateApproval({ fingerprint }, {
      stdin: scriptedTtyInput('yes\n'), stderr, approveUpdatePlan
    })).resolves.toEqual({ status: 'required', fingerprint });
    expect(approveUpdatePlan).not.toHaveBeenCalled();
    expect(stderr.text()).toBe('');
  });

  it.each(['destroyed', 'ended'] as const)('rejects %s terminal input as unusable', async (state) => {
    const stdin = scriptedTtyInput('');
    if (state === 'destroyed') {
      stdin.destroy();
    } else {
      for await (const _chunk of stdin) {
        // Drain the stream to model terminal EOF before approval.
      }
    }
    const approveUpdatePlan = vi.fn<UpdateApprovalPrompt>().mockResolvedValue(true);
    await expect(requestUpdateApproval({ fingerprint }, {
      stdin, stderr: ttyCaptureStream(), approveUpdatePlan
    })).resolves.toEqual({ status: 'required', fingerprint });
    expect(approveUpdatePlan).not.toHaveBeenCalled();
  });

  it.each(['destroyed', 'ended'] as const)('rejects %s terminal output as unusable', async (state) => {
    const stderr = ttyCaptureStream();
    if (state === 'destroyed') {
      stderr.destroy();
    } else {
      stderr.end();
    }
    const approveUpdatePlan = vi.fn<UpdateApprovalPrompt>().mockResolvedValue(true);
    await expect(requestUpdateApproval({ fingerprint }, {
      stdin: scriptedTtyInput(''), stderr, approveUpdatePlan
    })).resolves.toEqual({ status: 'required', fingerprint });
    expect(approveUpdatePlan).not.toHaveBeenCalled();
  });

  it.each([true, false])('uses one negative-default, exact-plan prompt for answer %s', async (answer) => {
    const stdin = scriptedTtyInput('');
    const stderr = ttyCaptureStream();
    const stdout = new CaptureStream();
    const approveUpdatePlan = vi.fn<UpdateApprovalPrompt>(async (config, context) => {
      context.output.write(`${config.message}\n`);
      return answer;
    });
    const context = { stdin, stdout, stderr, approveUpdatePlan };
    const result = await requestUpdateApproval({ fingerprint }, context);
    expect(result).toEqual(answer
      ? { status: 'approved', fingerprint, method: 'interactive' }
      : { status: 'declined', fingerprint, reason: 'declined' });
    expect(approveUpdatePlan).toHaveBeenCalledExactlyOnceWith({
      message: `Apply this exact update plan (${fingerprint})?`,
      default: false
    }, { input: stdin, output: stderr });
    expect(stderr.text()).toContain(fingerprint);
    expect(stdout.text()).toBe('');
  });

  it('requires a true boolean from the approval callback rather than a truthy generic yes', async () => {
    await expect(requestUpdateApproval({ fingerprint }, {
      stdin: scriptedTtyInput(''),
      stderr: ttyCaptureStream(),
      approveUpdatePlan: async () => 'yes' as unknown as boolean
    })).resolves.toEqual({ status: 'declined', fingerprint, reason: 'declined' });
  });

  it.each(['ExitPromptError', 'AbortPromptError', 'InteractiveCancelledError'])(
    'reports recognized %s cancellation',
    async (name) => {
      const cancellation = new Error('Prompt cancelled.');
      cancellation.name = name;
      await expect(requestUpdateApproval({ fingerprint }, {
        stdin: scriptedTtyInput(''),
        stderr: ttyCaptureStream(),
        approveUpdatePlan: vi.fn<UpdateApprovalPrompt>().mockRejectedValue(cancellation)
      })).resolves.toEqual({ status: 'declined', fingerprint, reason: 'cancelled' });
    }
  );

  it.each([
    Object.assign(new Error('Input/output failure.'), { code: 'EIO' }),
    Object.assign(new Error('Broken pipe.'), { code: 'EPIPE' }),
    new Error('User force closed the prompt: unexpected internal error.'),
    'unexpected rejection'
  ])('does not hide an unexpected prompt failure %s as cancellation', async (failure) => {
    await expect(requestUpdateApproval({ fingerprint }, {
      stdin: scriptedTtyInput(''),
      stderr: ttyCaptureStream(),
      approveUpdatePlan: vi.fn<UpdateApprovalPrompt>().mockRejectedValue(failure)
    })).rejects.toBe(failure);
  });

  it.each([
    { answer: '\r', status: 'declined', reason: 'declined' },
    { answer: 'y\r', status: 'approved', method: 'interactive' },
    { answer: '\u0003', status: 'declined', reason: 'cancelled' }
  ])('uses Inquirer on injected streams for $status ($answer)', async ({ answer, ...outcome }) => {
    const stdin = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: vi.fn()
    });
    const stderr = ttyCaptureStream();
    const stdout = new CaptureStream();
    const context = { stdin, stdout, stderr };
    const result = requestUpdateApproval({ fingerprint }, context);
    try {
      await vi.waitFor(() => expect(stderr.text().replace(/\s/gu, '')).toContain(fingerprint));
      stdin.write(answer);
      await expect(result).resolves.toEqual({ fingerprint, ...outcome });
      expect(stderr.text()).toContain('(y/N)');
      expect(stdout.text()).toBe('');
    } finally {
      stdin.write('\u0003');
      await result.catch(() => undefined);
      stdin.destroy();
      stderr.destroy();
    }
  });
});

describe('update command approval routing', () => {
  function commandContext() {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    return {
      cwd: process.cwd(),
      stdin: Readable.from([]),
      stdout,
      stderr,
      presentation: new PresentationSession({ stdout, stderr, snapshot: true })
    };
  }

  it('passes the exact approval and selected force/JSON flags unchanged to the use case', async () => {
    const context = commandContext();
    vi.mocked(updateProject).mockResolvedValueOnce(2);
    await expect(updateCommand(parseArgs([
      'update', 'project with spaces', '--force', '--json', '--approve-plan', fingerprint
    ]), context)).resolves.toBe(2);
    expect(updateProject).toHaveBeenCalledExactlyOnceWith({
      project: 'project with spaces',
      check: false,
      force: true,
      jsonMode: true,
      approvePlan: fingerprint
    }, context);
  });

  it('does not turn force or JSON into an approval value', async () => {
    const context = commandContext();
    await updateCommand(parseArgs(['update', '--force', '--json']), context);
    expect(updateProject).toHaveBeenCalledExactlyOnceWith({
      project: undefined,
      check: false,
      force: true,
      jsonMode: true,
      approvePlan: undefined
    }, context);
  });

  it.each([
    ['update', '--approve-plan'],
    ['update', '--approve-plan', 'short'],
    ['update', '--approve-plan', `${fingerprint}\n`],
    ['update', '--approve-plan', fingerprint, '--approve-plan', otherFingerprint],
    ['update', '--check', '--approve-plan', fingerprint],
    ['update', '--check', '--force'],
    ['update', '--apply'],
    ['update', '--yes']
  ])('rejects %j before dispatching any project or receipt IO', async (...argv) => {
    const context = commandContext();
    await expect(async () => updateCommand(parseArgs(argv), context)).rejects.toBeInstanceOf(UsageError);
    expect(updateProject).not.toHaveBeenCalled();
    expect(context.stdout.text()).toBe('');
    expect(context.stderr.text()).toBe('');
  });
});
