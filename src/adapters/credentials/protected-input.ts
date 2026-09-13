import { password } from '@inquirer/prompts';
import type { Readable } from 'node:stream';
import { GitHubActivationError } from '../github/activation-rest.js';

export interface ProtectedCredentialChannel {
  readonly kind: 'private-tty' | 'protected-stdin';
  read(label: 'GitHub App private key' | 'fine-grained PAT'): Promise<Buffer>;
}

export function privateTtyCredentialChannel(): ProtectedCredentialChannel {
  return {
    kind: 'private-tty',
    async read(label) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new GitHubActivationError('private-input-required', 'Credential enrollment requires a private TTY, or explicitly selected protected stdin. Never paste credentials into chat or argv.');
      }
      const value = await password({ message: `Private ${label} (never copied into output):`, mask: '' });
      const bytes = Buffer.from(value, 'utf8');
      if (!bytes.length || bytes.length > 32_768) {
        bytes.fill(0);
        throw new GitHubActivationError('invalid-credential', 'Protected credential input is empty or exceeds 32 KiB.');
      }
      return bytes;
    }
  };
}

export function protectedStdinCredentialChannel(
  explicitSelection: boolean,
  input: Readable = process.stdin,
  timeoutMs = 60_000
): ProtectedCredentialChannel {
  return {
    kind: 'protected-stdin',
    async read() {
      if (!explicitSelection || (input as NodeJS.ReadStream).isTTY) {
        throw new GitHubActivationError('private-input-required', 'Protected stdin must be explicitly selected and supplied by an owner-controlled non-TTY secret channel.');
      }
      return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const clean = () => {
          clearTimeout(timer);
          input.off('data', data);
          input.off('end', end);
          input.off('error', failure);
          for (const bytes of chunks) bytes.fill(0);
          input.pause();
        };
        const failure = () => {
          clean();
          reject(new GitHubActivationError('protected-input-failed', 'Protected credential input was interrupted, empty, oversized, or timed out.'));
        };
        const data = (chunk: Buffer | string) => {
          const bytes = Buffer.from(chunk);
          size += bytes.length;
          chunks.push(bytes);
          if (size > 32_768) failure();
        };
        const end = () => {
          if (!size) { failure(); return; }
          const bytes = Buffer.concat(chunks);
          clean();
          resolve(bytes);
        };
        const timer = setTimeout(failure, timeoutMs);
        input.on('data', data);
        input.once('end', end);
        input.once('error', failure);
        input.resume();
      });
    }
  };
}
