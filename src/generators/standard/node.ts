import type { GeneratorContext as ResolvedGeneratorContext } from '../context.js';
type GeneratorContext = { npm: Pick<ResolvedGeneratorContext['npm'], 'node-backend'> };
import type { AddArtifact } from '../../template-types.js';
import { escapeHtml } from '../common/values.js';
import { localPostgresUrl } from '../common/values.js';


import { renderStandardSchema } from './configuration.js';
import { sourceString } from '../common/values.js';
import { renderNodeDotenvValidation } from '../common/dotenv-validation.js';
import type { StandardApiProjectPlan } from '../../domain/project/contracts.js';

export function addNodeArtifacts(add: AddArtifact, plan: StandardApiProjectPlan, context: GeneratorContext): void {
  add('node-backend-package', 'backend', ['backend', 'package.json'], renderNodePackage(plan, context));
  add('node-backend-lock', 'backend', ['backend', 'package-lock.json'], context.npm["node-backend"].lock);
  add('node-backend-tsconfig', 'backend', ['backend', 'tsconfig.json'], renderNodeTsconfig());
  add('node-backend-drizzle-config', 'backend', ['backend', 'drizzle.config.ts'], renderNodeDrizzleConfig());
  add('node-backend-config', 'backend', ['backend', 'src', 'config.ts'], renderNodeConfig(plan));
  add('node-backend-app', 'backend', ['backend', 'src', 'app.ts'], renderNodeApp(plan));
  add('node-backend-server', 'backend', ['backend', 'src', 'server.ts'], renderNodeServer());
  add('node-backend-database', 'backend', ['backend', 'src', 'database.ts'], renderNodeDatabase());
  add('node-backend-schema', 'backend', ['backend', 'src', 'db', 'schema.ts'], renderNodeSchema());
  add('node-backend-test-health', 'backend-test', ['backend', 'test', 'health.test.ts'], renderNodeHealthTest());
  add('node-backend-vitest-config', 'backend-test', ['backend', 'vitest.config.ts'], `import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts']
  }
});
`);
  add('database-node-migration', 'database', ['database', 'migrations', '0000_initial.sql'], renderNodeMigration());
  add('database-node-migration-journal', 'database', ['database', 'migrations', 'meta', '_journal.json'], renderNodeMigrationJournal());
  add('database-node-migration-snapshot', 'database', ['database', 'migrations', 'meta', '0000_snapshot.json'], renderNodeMigrationSnapshot());
  add('database-schema', 'database', ['database', 'models', 'schema.sql'], renderStandardSchema(plan));
}

export function renderNodePackage(plan: StandardApiProjectPlan, context: GeneratorContext): string {
  return context.npm["node-backend"].package;
}

export function renderNodeTsconfig(): string {
  return JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      rootDir: 'src',
      outDir: 'dist',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true
    },
    include: ['src/**/*.ts']
  }, null, 2);
}

export function renderNodeDrizzleConfig(): string {
  return `import { defineConfig } from 'drizzle-kit';
import { loadConfig } from './src/config.js';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: '../database/migrations',
  dbCredentials: {
    url: loadConfig().databaseUrl
  }
});
`;
}

export function renderNodeConfig(plan: StandardApiProjectPlan): string {
  return `import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export interface AppConfig {
  appName: string;
  appEnv: string;
  port: number;
  cloudProvider: string;
  azureRegion: string;
  databaseUrl: string;
  redisUrl: string;
  messagingTransport: string;
  blobEndpoint?: string;
  corsAllowedOrigins: string[];
}

let cachedConfig: AppConfig | undefined;

${renderNodeDotenvValidation()}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (env === process.env && cachedConfig) return cachedConfig;
  const selectedFile = env.LIFTOFF_ENV_FILE;
  const file = selectedFile ?? fileURLToPath(new URL('../../.env', import.meta.url));
  let local: Record<string, string | undefined> = {};
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(file));
    validateDotenv(content);
    local = parseEnv(content);
  } catch (error) {
    if (selectedFile !== undefined || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('Unable to read runtime configuration file: ' + file, { cause: error });
    }
  }
  const resolved = { ...local, ...Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) };
  const databaseUrl = resolved.DATABASE_URL;
  const redisUrl = resolved.REDIS_URL;
  if (!databaseUrl || !redisUrl) {
    throw new Error('DATABASE_URL and REDIS_URL are required.');
  }
  const port = Number(resolved.PORT ?? '8000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535.');
  }
  const config: AppConfig = {
    appName: resolved.APP_NAME ?? ${sourceString(plan.projectName)},
    appEnv: resolved.APP_ENV ?? 'dev',
    port,
    cloudProvider: resolved.CLOUD_PROVIDER ?? '${plan.provider.id}',
    azureRegion: resolved.AZURE_REGION ?? '${plan.region.slug}',
    databaseUrl,
    redisUrl,
    messagingTransport: resolved.MESSAGING_TRANSPORT ?? 'redis-streams',
    blobEndpoint: resolved.BLOB_ENDPOINT || undefined,
    corsAllowedOrigins: (resolved.CORS_ALLOWED_ORIGINS ?? 'http://localhost:5173')
      .split(',').map((origin) => origin.trim()).filter(Boolean)
  };
  if (env === process.env) cachedConfig = config;
  return config;
}
`;
}

export function renderNodeApp(plan: StandardApiProjectPlan): string {
  const scalarPage = `<!doctype html><html><head><title>${escapeHtml(plan.projectName)} API</title></head><body><script id="api-reference" data-url="/openapi.json"></script><script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script></body></html>`;
  return `import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import Fastify from 'fastify';
import { loadConfig, type AppConfig } from './config.js';

const scalarPage = ${sourceString(scalarPage)};

export async function buildApp(config: AppConfig = loadConfig()) {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: config.corsAllowedOrigins });
  await app.register(swagger, {
    openapi: {
      info: { title: ${sourceString(`${plan.projectName} API`)}, version: '0.1.0' }
    }
  });

  const statusSchema = {
    response: {
      200: {
        type: 'object',
        required: ['status'],
        properties: { status: { type: 'string' } }
      }
    }
  } as const;

  app.get('/health', { schema: statusSchema }, async () => ({ status: 'ok' }));
  app.get('/ready', { schema: statusSchema }, async () => ({ status: 'ready' }));
  app.get('/api', async () => ({ name: ${sourceString(plan.projectName)}, stack: 'node-fastify' }));
  app.get('/openapi.json', async () => app.swagger());
  app.get('/scalar', async (_request, reply) => reply.type('text/html').send(scalarPage));
  return app;
}
`;
}

export function renderNodeServer(): string {
  return `import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await buildApp(config);

try {
  await app.listen({ host: '0.0.0.0', port: config.port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
`;
}

export function renderNodeDatabase(): string {
  return `import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { loadConfig } from './config.js';

const pool = new Pool({ connectionString: loadConfig().databaseUrl });
export const database = drizzle(pool);
`;
}

export function renderNodeSchema(): string {
  return `import { integer, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core';

export const appRecords = pgTable('app_records', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: varchar('name', { length: 255 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
});
`;
}

export function renderNodeHealthTest(): string {
  return `import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('health endpoints', () => {
  it('reports healthy and ready', async () => {
    const app = await buildApp(loadConfig({
      DATABASE_URL: 'postgresql://localhost/test',
      REDIS_URL: 'redis://localhost:6379/0',
      CORS_ALLOWED_ORIGINS: 'http://localhost:5173'
    }));
    const health = await app.inject({ method: 'GET', url: '/health' });
    const ready = await app.inject({ method: 'GET', url: '/ready' });
    expect(health.json()).toEqual({ status: 'ok' });
    expect(ready.json()).toEqual({ status: 'ready' });
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/api',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET'
      }
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    await app.close();
  });
});
`;
}

export function renderNodeMigration(): string {
  return `CREATE TABLE app_records (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;
}

export function renderNodeMigrationJournal(): string {
  return JSON.stringify({
    version: '7',
    dialect: 'postgresql',
    entries: [
      {
        idx: 0,
        version: '7',
        when: 0,
        tag: '0000_initial',
        breakpoints: true
      }
    ]
  }, null, 2);
}

export function renderNodeMigrationSnapshot(): string {
  return JSON.stringify({
    id: '00000000-0000-4000-8000-000000000001',
    prevId: '00000000-0000-0000-0000-000000000000',
    version: '7',
    dialect: 'postgresql',
    tables: {
      'public.app_records': {
        name: 'app_records',
        schema: '',
        columns: {
          id: {
            name: 'id',
            type: 'integer',
            primaryKey: true,
            notNull: true,
            identity: {
              type: 'always',
              name: 'app_records_id_seq',
              schema: 'public',
              increment: '1',
              startWith: '1',
              minValue: '1',
              maxValue: '2147483647',
              cache: '1',
              cycle: false
            }
          },
          name: {
            name: 'name',
            type: 'varchar(255)',
            primaryKey: false,
            notNull: true
          },
          created_at: {
            name: 'created_at',
            type: 'timestamp with time zone',
            primaryKey: false,
            notNull: true,
            default: 'now()'
          }
        },
        indexes: {},
        foreignKeys: {},
        compositePrimaryKeys: {},
        uniqueConstraints: {},
        policies: {},
        checkConstraints: {},
        isRLSEnabled: false
      }
    },
    enums: {},
    schemas: {},
    sequences: {},
    roles: {},
    policies: {},
    views: {},
    _meta: {
      columns: {},
      schemas: {},
      tables: {}
    }
  }, null, 2);
}
