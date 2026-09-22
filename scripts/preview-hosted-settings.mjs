#!/usr/bin/env node
import { execFile } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  HOSTED_READ_ENDPOINTS, HOSTED_STATE_LIMITS, loadHostedState
} from './repository-security/hosted-state.ts';

function failure(reason) { return { kind: 'error', reason }; }

function response(error, stdout) {
  if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return failure('output-limit');
  if (error?.killed || error?.signal) return failure('timeout');
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > HOSTED_STATE_LIMITS.processOutputBytes) {
    return failure('output-limit');
  }
  const match = /^HTTP\/(?:1\.[01]|2(?:\.0)?|3(?:\.0)?) ([1-5][0-9]{2})[^\r\n]*\r?\n/.exec(stdout);
  const boundary = /\r?\n\r?\n/.exec(stdout);
  if (!match || !boundary || boundary.index > 16 * 1024) return failure(error ? 'transport-error' : 'invalid-response');
  const status = Number(match[1]);
  if (error && status === 200) return failure('transport-error');
  const body = stdout.slice(boundary.index + boundary[0].length);
  if (Buffer.byteLength(body) > HOSTED_STATE_LIMITS.responseBytes) return failure('output-limit');
  return { kind: 'response', status, body };
}

/**
 * Fixed github.com GETs only; execFile injection is for deterministic transport tests.
 * @param {(file: string, args: readonly string[], options: import('node:child_process').ExecFileOptionsWithStringEncoding, callback: (error: import('node:child_process').ExecFileException | null, stdout: string, stderr: string) => void) => unknown} execute
 */
export function createGhReadonlyTransport(execute = execFile) {
  return Object.freeze({
    async get(endpoint) {
      if (!Object.values(HOSTED_READ_ENDPOINTS).includes(endpoint)) return failure('invalid-response');
      return new Promise(resolve => {
        try {
          execute('gh', [
            'api', '--hostname', 'github.com', '--method', 'GET', '--include',
            '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28',
            endpoint
          ], {
            shell: false, encoding: 'utf8', windowsHide: true,
            timeout: HOSTED_STATE_LIMITS.timeoutMs, maxBuffer: HOSTED_STATE_LIMITS.processOutputBytes,
            killSignal: 'SIGKILL',
            env: {
              ...process.env, GH_DEBUG: '', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', PAGER: 'cat',
              GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1'
            }
          }, (error, stdout) => resolve(response(error, stdout)));
        } catch { resolve(failure('transport-error')); }
      });
    }
  });
}

/**
 * Usage: node scripts/preview-hosted-settings.mjs
 * No arguments, output-file option or apply mode. Exit 0 means complete readback
 * only; missing/invalid/drifting readback exits 1. Every activation stays blocked.
 */
export async function previewHostedSettings(args, transport = createGhReadonlyTransport()) {
  if (!Array.isArray(args) || args.length) throw new Error('preview-takes-no-arguments');
  const preview = await loadHostedState(transport);
  const output = `${JSON.stringify(preview, null, 2)}\n`;
  if (Buffer.byteLength(output) > HOSTED_STATE_LIMITS.previewBytes) throw new Error('preview-output-limit');
  return { output, exitCode: preview.readbackComplete ? 0 : 1 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await previewHostedSettings(process.argv.slice(2));
    process.stdout.write(result.output);
    process.exitCode = result.exitCode;
  } catch {
    process.stderr.write('Hosted settings preview unavailable: arguments, local inputs or execution rejected. No writes attempted.\n');
    process.exitCode = 1;
  }
}
