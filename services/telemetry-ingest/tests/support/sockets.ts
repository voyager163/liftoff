import { once } from 'node:events';
import type { Server } from 'node:http';
import { createConnection, type Socket } from 'node:net';

export function serverPort(server: Server): number {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP server address.');
  }
  return address.port;
}

export async function connectLoopback(
  port: number,
  options: { allowHalfOpen?: boolean } = {}
): Promise<Socket> {
  const socket = createConnection({
    host: '127.0.0.1',
    port,
    allowHalfOpen: options.allowHalfOpen ?? false
  });
  await once(socket, 'connect');
  return socket;
}

// Register before connecting so the server-side socket of the next connection is captured.
export function nextAcceptedSocket(server: Server): Promise<Socket> {
  return once(server, 'connection').then(([socket]) => socket as Socket);
}

// Unlike events.once, this also settles when the socket closes because of an error.
export function socketClosed(socket: Socket): Promise<void> {
  return new Promise((resolve) => {
    socket.once('close', () => resolve());
  });
}

export function captureText(socket: Socket): () => string {
  let text = '';
  socket.on('data', (chunk: Buffer) => {
    text += chunk.toString('latin1');
  });
  return () => text;
}

export function readResponseHead(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = '';
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onError);
    };
    const onData = (chunk: Buffer) => {
      received += chunk.toString('latin1');
      const end = received.indexOf('\r\n\r\n');
      if (end !== -1) {
        cleanup();
        resolve(received.slice(0, end + 4));
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new Error(`Connection ended before a complete response head: ${JSON.stringify(received)}`));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onError);
  });
}

export function postHead(contentLength: number, target = '/api/events'): string {
  return [
    `POST ${target} HTTP/1.1`,
    'Host: localhost',
    'Content-Type: application/json',
    `Content-Length: ${contentLength}`,
    '',
    ''
  ].join('\r\n');
}

// Resolves after pending I/O callbacks and microtasks; setImmediate is never faked by these tests.
export function afterPendingCallbacks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
