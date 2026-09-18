import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli/args/parser.js';
import { createStructuredContinuation, validateStructuredContinuation } from '../src/protocol/continuation.js';
import { validatePublicCommandEnvelope, validatePublicTarget } from '../src/protocol/commands.js';
import { assertStrictKeys, assertStrictObject, protocolString } from '../src/protocol/schema.js';
import { canonicalizePathBoundary, formatNativeSafeCommandLine } from '../src/domain/execution/continuation.js';
import { formatShellCommand } from '../src/adapters/process/shell-command.js';
import { NodeCommandRunner } from '../src/process-runner.js';
import { createUpdateContinuation } from '../src/application/update/command-guidance.js';

function bound() {
  return createStructuredContinuation({
    args: ['governance', 'plan', '--project', '/work/project'],
    cwd: '/work/project', project: '/work/project', scope: 'repository',
    configPath: '/work/public inputs.json', configDigest: 'a'.repeat(64),
    compatibilityIdentity: 'activation-v4'
  });
}

describe('literal and context-bound continuation admission', () => {
  it('renders canonical update targets for their recorded host unless presentation explicitly selects another host', () => {
    const windows = createUpdateContinuation('C:\\work\\project', 'check');
    const posix = createUpdateContinuation('/work/project', 'check');
    expect(windows.displayCommand).toBe("& 'liftoff' 'update' '--check' '--project' 'C:\\work\\project'");
    expect(posix.displayCommand).toBe('liftoff update --check --project /work/project');
    expect(validateStructuredContinuation(windows)).toEqual(windows);
    expect(validateStructuredContinuation(posix)).toEqual(posix);
    expect(() => createUpdateContinuation('/work/project', 'check', 'win32')).toThrow(/different hosts/);
    expect(() => createUpdateContinuation('C:\\work\\project', 'check', 'linux')).toThrow(/different hosts/);
  });

  it('binds selected governance scope and configuration into actual parseable arguments', () => {
    const continuation = bound();
    expect(parseArgs([...continuation.args])).toMatchObject({
      command: 'governance', subcommand: 'plan',
      flags: { project: '/work/project', scope: 'repository', inputs: '/work/public inputs.json' }
    });
    expect(validateStructuredContinuation(continuation)).toEqual(continuation);
  });

  it('keeps an unscoped governance operation activation-scoped and assessment separate', () => {
    expect(createStructuredContinuation({ args: ['governance', 'plan'], cwd: '/work' }).scope).toBe('activation');
    const assessment = createStructuredContinuation({ args: ['governance', 'assess'], cwd: '/work' });
    expect(assessment.scope).toBe('governance-assessment');
    expect(assessment.args).not.toContain('--scope');
    expect(() => createStructuredContinuation({
      args: ['governance', 'assess'], cwd: '/work', scope: 'activation'
    })).toThrow();
  });

  it.each([
    { scope: 'local' },
    { project: '/work/other' },
    { configPath: '/work/other.json' },
    { configDigest: 'abbreviated' },
    { configDigest: `a${'a'.repeat(63)}\n` },
    { requiredAuthority: ['approval', 'approval'] },
    { requiredAuthority: [true] },
    { userInstallTarget: '/work/install' },
    { targetScope: 'user' },
    { displayCommand: 'liftoff update --force' },
    { unsupported: true }
  ])('rejects changed or malformed continuation metadata %j', (changed) => {
    expect(() => validateStructuredContinuation({ ...bound(), ...changed })).toThrow();
  });

  it('rejects dropped scope or configuration even when a caller regenerates a plausible display command', () => {
    for (const flag of ['--scope', '--inputs']) {
      const original = bound();
      const args = [...original.args];
      args.splice(args.indexOf(flag), 2);
      expect(() => validateStructuredContinuation({
        ...original, args, displayCommand: formatNativeSafeCommandLine('liftoff', args, 'linux')
      })).toThrow();
    }
  });

  it('refuses a configuration binding on a command without a corresponding input option', () => {
    expect(() => createStructuredContinuation({
      args: ['update', '--check'], cwd: '/work', configPath: '/work/inputs.json', configDigest: 'a'.repeat(64)
    })).toThrow(/cannot consume/);
    expect(() => createStructuredContinuation({
      args: ['governance', 'plan', '--proposal', '/work/inputs.json'],
      cwd: '/work', configPath: '/work/inputs.json', configDigest: 'a'.repeat(64)
    })).toThrow(/Unknown flag/);
  });

  it('requires a digest for any configuration-bearing action and rejects repeated target flags', () => {
    expect(() => createStructuredContinuation({
      args: ['governance', 'plan', '--inputs', '/work/inputs.json'], cwd: '/work'
    })).toThrow(/reference and digest/);
    expect(() => createStructuredContinuation({
      args: ['adopt', '--project', '/work/a', '--project', '/work/b'], cwd: '/work'
    })).toThrow(/only once/);
  });

  it('uses the same positional parsing as the CLI even after flags or an end-of-options marker', () => {
    for (const args of [
      ['update', '--check', '../project'],
      ['update', '--check', '--', '../project'],
      ['assess', '--json', '../project']
    ]) {
      const continuation = createStructuredContinuation({ args, cwd: '/work/invocation' });
      expect(continuation.project).toBe('/work/project');
      expect(parseArgs([...continuation.args]).positional).toEqual(['/work/project']);
      expect(validateStructuredContinuation(continuation)).toEqual(continuation);
      expect(() => createStructuredContinuation({
        args, cwd: '/work/invocation', project: '/work/different'
      })).toThrow(/differs/);
    }
  });

  it('rejects conflicting positional and flag targets instead of trusting a different precedence', () => {
    for (const command of ['update', 'repair', 'assess', 'adopt', 'validate']) {
      const args = [command, '/work/actual', '--project', '/work/claimed'];
      expect(() => parseArgs(args)).toThrow(/not both/);
      expect(() => createStructuredContinuation({
        args,
        cwd: '/work', project: '/work/claimed'
      })).toThrow(/not both/);
    }
  });

  it('inserts bound options before a positional delimiter and resolves configuration bytes from the original cwd', () => {
    const original = ['governance', 'plan', '--', '../project'];
    const continuation = createStructuredContinuation({
      args: original, cwd: '/work/invocation', scope: 'repository',
      configPath: '/work/public inputs.json', configDigest: 'a'.repeat(64)
    });
    expect(parseArgs([...continuation.args])).toMatchObject({
      command: 'governance', subcommand: 'plan', positional: ['/work/project'],
      flags: { scope: 'repository', inputs: '/work/public inputs.json' }
    });
    expect(original).toEqual(['governance', 'plan', '--', '../project']);
    expect(validateStructuredContinuation(continuation)).toEqual(continuation);
  });

  it.each([
    ['assess', ['--inputs', '../policy.json', '--json'], 'inputs'],
    ['adopt', ['--profile', 'vue-component', '--proposal=../policy.json', '--check'], 'proposal'],
    ['repair', ['--application-patch', '../policy.json', '--check'], 'application-patch']
  ] as const)('binds actual %s configuration options into canonical literal paths', (command, options, flag) => {
    const continuation = createStructuredContinuation({
      args: [command, ...options], cwd: '/work/project',
      configPath: '/work/policy.json', configDigest: 'b'.repeat(64)
    });
    expect(parseArgs([...continuation.args]).flags[flag]).toBe('/work/policy.json');
    expect(continuation.configDigest).toBe('b'.repeat(64));
    expect(validateStructuredContinuation(continuation)).toEqual(continuation);
  });

  it.each([
    ['assess', '--invented'],
    ['assess', '--json=perhaps'],
    ['repair', '/work/one', '/work/two'],
    ['doctor', '--project', '/work/project'],
    ['--version', 'ignored']
  ])('rejects syntax that cannot represent a complete literal continuation: %j', (...args) => {
    expect(() => createStructuredContinuation({ args, cwd: '/work' })).toThrow(/arguments are invalid/);
  });

  it('binds cwd-only diagnosis and preserves a literal delimiter after the first one', () => {
    expect(() => createStructuredContinuation({
      args: ['doctor'], cwd: '/work/actual', project: '/work/claimed'
    })).toThrow(/exact cwd/);
    expect(parseArgs(['regions', 'search', '--', '--']).positional).toEqual(['--']);
  });

  it('uses exact native Windows paths and quotes splatting tokens literally', () => {
    const continuation = createStructuredContinuation({
      args: ['assess', '--project', 'C:\\work\\project'], cwd: 'C:\\work',
      project: 'C:\\work\\project', platform: 'win32'
    });
    expect(continuation.project).toBe('C:\\work\\project');
    expect(validateStructuredContinuation(continuation)).toEqual(continuation);
    expect(formatNativeSafeCommandLine('liftoff', ['assess', '@arguments'], 'win32'))
      .toBe("& 'liftoff' 'assess' '@arguments'");
  });

  it.each(['C:relative', '\\relative', '\\\\server', '\\\\?\\C:\\work', '//server/share'])(
    'rejects ambiguous drive, device, or UNC paths %s',
    (value) => expect(() => validatePublicTarget({ kind: 'project', path: value })).toThrow()
  );

  it.each(['C:relative', 'D:relative', '\\relative', '\\\\server', '\\\\?\\C:\\work', '//server/share'])(
    'rejects ambiguous Windows argument %s before cwd resolution can hide it',
    (value) => {
      for (const args of [
        ['assess', value],
        ['assess', '--project', value],
        ['governance', 'plan', '--inputs', value]
      ]) {
        expect(() => createStructuredContinuation({
          args, cwd: 'C:\\work', platform: 'win32',
          ...(args.includes('--inputs') ? { configPath: 'C:\\work\\inputs.json', configDigest: 'a'.repeat(64) } : {})
        })).toThrow(/ambiguous|explicit drive|complete UNC/);
      }
      const original = createStructuredContinuation({
        args: ['assess', '--project', 'C:\\work\\project'], cwd: 'C:\\work', platform: 'win32'
      });
      const args = ['assess', '--project', value];
      expect(() => validateStructuredContinuation({
        ...original, args, displayCommand: formatNativeSafeCommandLine(original.executable, args, 'win32')
      })).toThrow(/ambiguous|explicit drive|complete UNC/);
    }
  );

  it('resolves ordinary Windows relative arguments only against their recorded cwd', () => {
    const continuation = createStructuredContinuation({
      args: ['governance', 'plan', '--project', '..\\project', '--inputs', '..\\inputs.json'],
      cwd: 'C:\\work\\invocation', platform: 'win32',
      configPath: 'C:\\work\\inputs.json', configDigest: 'a'.repeat(64)
    });
    expect(continuation.project).toBe('C:\\work\\project');
    expect(parseArgs([...continuation.args]).flags.inputs).toBe('C:\\work\\inputs.json');
    expect(validateStructuredContinuation(continuation)).toEqual(continuation);
  });

  it('rejects cross-drive and cross-share escapes without confusing dot-prefixed child names', () => {
    expect(() => canonicalizePathBoundary('D:\\project', 'C:\\project')).toThrow(/escapes/);
    expect(() => canonicalizePathBoundary('\\\\other\\share\\project', '\\\\server\\share')).toThrow(/escapes/);
    expect(canonicalizePathBoundary('root/..local', 'root')).toBe('root/..local');
  });

  it('keeps payloads unknown unless the caller supplies a strict command-specific decoder', () => {
    const envelope = { schemaVersion: 1, command: 'assess', payload: { profile: 'node-fastify' } };
    const decode = (value: unknown) => {
      const payload = assertStrictObject(value, 'assessment payload');
      assertStrictKeys(payload, ['profile'], 'assessment payload');
      return { profile: protocolString(payload.profile, 'assessment profile') };
    };
    expect(validatePublicCommandEnvelope(envelope, decode).payload).toEqual({ profile: 'node-fastify' });
    expect(() => validatePublicCommandEnvelope({ ...envelope, payload: { profile: 'node-fastify', execute: true } }, decode)).toThrow();
    expect(() => validatePublicCommandEnvelope({ ...envelope, command: 'assess; execute' })).toThrow();
  });

  it.skipIf(process.platform === 'win32')('round-trips POSIX metacharacters through the shared actual shell renderer', async () => {
    const args = ['@arguments', '$literal', "one'quote", 'two words', '', ';not-a-command'];
    const command = formatShellCommand({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args]
    }, 'posix');
    const result = await new NodeCommandRunner().run({ executable: '/bin/sh', args: ['-c', command] }, {
      timeoutMs: 5000, maxOutputBytes: 8192, ensureProcessTreeSettled: true
    });
    expect(result.processTreeSettled).toBe(true);
    expect(result.status, result.errorMessage ?? result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(args);
  });
});
