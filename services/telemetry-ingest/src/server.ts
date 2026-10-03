import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http';
import type { Duplex } from 'node:stream';
import {
  handleProjectTelemetryRequest,
  handleTelemetryRequest,
  type TelemetryHttpRequest,
  type TelemetryIngestionDependencies
} from './handler.js';

export const telemetryRoute = '/api/events';
export const projectTelemetryRoute = '/api/projects';
export const telemetryPort = 8080;

const badRequestResponse =
  'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n';

type DependencyResolver = () => TelemetryIngestionDependencies;

function headerValue(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  return value ?? null;
}

function requestBody(request: IncomingMessage): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      const iterator = request[Symbol.asyncIterator]();
      return {
        next: () => iterator.next(),
        return: async () => ({ done: true, value: undefined })
      };
    }
  };
}

function telemetryRequest(request: IncomingMessage): TelemetryHttpRequest {
  return {
    method: request.method ?? '',
    headers: {
      get: (name: string) => headerValue(request.headers, name)
    },
    body: requestBody(request)
  };
}

function requestPath(request: IncomingMessage): string | undefined {
  try {
    return new URL(request.url ?? '', 'http://localhost').pathname;
  } catch {
    return undefined;
  }
}

function sendStatus(response: ServerResponse, status: number): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': '0'
  });
  response.end();
}

function lazyDependencies(resolve: DependencyResolver): TelemetryIngestionDependencies {
  return {
    now: () => resolve().now(),
    upload: (record) => resolve().upload(record),
    uploadProject: async (record) => {
      const dependencies = resolve();
      if (!dependencies.uploadProject) throw new Error('Project telemetry ingestion is disabled.');
      await dependencies.uploadProject(record);
    }
  };
}

async function respond(
  request: IncomingMessage,
  response: ServerResponse,
  resolveDependencies: DependencyResolver
): Promise<void> {
  const route = requestPath(request);
  if (route !== telemetryRoute && route !== projectTelemetryRoute) {
    request.resume();
    sendStatus(response, 404);
    return;
  }

  try {
    const handler = route === projectTelemetryRoute ? handleProjectTelemetryRequest : handleTelemetryRequest;
    const result = await handler(
      telemetryRequest(request),
      lazyDependencies(resolveDependencies)
    );
    sendStatus(response, result.status);
  } catch {
    sendStatus(response, 503);
  } finally {
    request.resume();
  }
}

function settleClientError(error: NodeJS.ErrnoException, socket: Duplex): void {
  if (socket.writable) {
    // Destroy only after the 400 has flushed so the client receives the whole response.
    socket.end(badRequestResponse, () => socket.destroy());
    return;
  }
  // A repeated parse error must not discard a 400 that is still flushing, while the
  // request timeout still settles a flush that never completes.
  const responseFlushing = socket.writableEnded && !socket.writableFinished;
  if (!responseFlushing || error.code === 'ERR_HTTP_REQUEST_TIMEOUT') {
    socket.destroy();
  }
}

export function createTelemetryServer(resolveDependencies: DependencyResolver): Server {
  const server = createServer((request, response) => {
    void respond(request, response, resolveDependencies);
  });
  server.on('clientError', settleClientError);
  return server;
}

export async function listenTelemetryServer(
  server: Server,
  port = telemetryPort,
  host = '0.0.0.0'
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

export async function closeTelemetryServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
