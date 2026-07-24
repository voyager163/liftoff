import type { AddArtifact } from './template-types.js';
import type { ApiStackId, ProjectPlan } from './types.js';
import { renderNpmLock, renderNpmPackage } from './npm-template-assets.js';

type StackBuilder = (add: AddArtifact, plan: ProjectPlan) => void;

const stackBuilders: Record<ApiStackId, StackBuilder> = {
  'python-fastapi': addPythonArtifacts,
  'node-fastify': addNodeArtifacts,
  'go-huma': addGoArtifacts
};

const sourceString = (value: string) => JSON.stringify(value);
const escapeHtml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const localPostgresUrl = (host: string, database: string) =>
  `postgresql:${'//'}postgres:postgres@${host}:5432/${database}`;

export function addStandardStackArtifacts(add: AddArtifact, plan: ProjectPlan): void {
  stackBuilders[plan.apiStack.id](add, plan);
}

export function renderStandardDockerfile(plan: ProjectPlan): string {
  switch (plan.apiStack.id) {
    case 'python-fastapi':
      return `FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app

COPY backend/pyproject.toml /app/backend/pyproject.toml
RUN pip install --no-cache-dir /app/backend

COPY backend /app/backend
COPY database /app/database

EXPOSE 8000
CMD ["uvicorn", "backend.apis.main:app", "--host", "0.0.0.0", "--port", "8000"]
`;
    case 'node-fastify':
      return `FROM node:20-alpine AS build

WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm install
COPY backend ./
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app/backend
ENV NODE_ENV=production
COPY backend/package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/backend/dist ./dist
COPY database /app/database

EXPOSE 8000
CMD ["node", "dist/server.js"]
`;
    case 'go-huma':
      return `FROM golang:1.23-alpine AS build

WORKDIR /src/backend
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/api ./cmd/api

FROM alpine:3.20
RUN adduser -D -u 10001 liftoff
USER liftoff
WORKDIR /app
COPY --from=build /out/api /app/api
COPY database /app/database

EXPOSE 8000
CMD ["/app/api"]
`;
  }
}

export function renderStandardEnv(plan: ProjectPlan, environment = 'dev'): string {
  const local = environment === 'dev';
  const databaseUrl = localPostgresUrl('postgres', plan.safeProjectName.replace(/-/g, '_'));
  return `APP_ENV=${environment}
APP_NAME=${plan.safeProjectName}
API_STACK=${plan.apiStack.id}
CLOUD_PROVIDER=${plan.provider.id}
AZURE_REGION=${plan.region.slug}
DATABASE_URL=${databaseUrl}
REDIS_URL=redis://redis:6379/0
MESSAGING_TRANSPORT=${local ? 'redis-streams' : 'azure-service-bus'}
BLOB_ENDPOINT=${local ? 'http://azurite:10000/devstoreaccount1' : ''}
CORS_ALLOWED_ORIGINS=http://localhost:5173
`;
}

function addPythonArtifacts(add: AddArtifact, plan: ProjectPlan): void {
  add('backend-pyproject', 'backend', ['backend', 'pyproject.toml'], renderPythonPyproject(plan));
  add('backend-package', 'backend', ['backend', '__init__.py'], '');
  add('backend-api-package', 'backend', ['backend', 'apis', '__init__.py'], '');
  add('backend-main', 'backend', ['backend', 'apis', 'main.py'], renderPythonMain(plan));
  add('backend-health-routes', 'backend', ['backend', 'apis', 'routes', 'health.py'], renderPythonHealthRoutes());
  add('backend-routes-package', 'backend', ['backend', 'apis', 'routes', '__init__.py'], '');
  add('backend-auth-dependency', 'backend', ['backend', 'apis', 'dependencies', 'auth.py'], renderPythonAuthDependency());
  add('backend-config-package', 'backend', ['backend', 'config', '__init__.py'], '');
  add('backend-settings', 'backend', ['backend', 'config', 'settings.py'], renderPythonSettings(plan));
  add('backend-observability', 'backend', ['backend', 'observability', 'logging.py'], renderPythonLogging());
  add('backend-observability-package', 'backend', ['backend', 'observability', '__init__.py'], '');
  add('backend-test-health', 'backend-test', ['backend', 'tests', 'test_health.py'], renderPythonHealthTest());
  add('database-alembic-ini', 'database', ['database', 'alembic.ini'], renderAlembicIni());
  add('database-alembic-env', 'database', ['database', 'migrations', 'env.py'], renderAlembicEnv());
  add('database-initial-migration', 'database', ['database', 'migrations', 'versions', '0001_initial.py'], renderPythonMigration());
  add('database-schema', 'database', ['database', 'models', 'schema.sql'], renderStandardSchema(plan));
}

function renderPythonPyproject(plan: ProjectPlan): string {
  return `[project]
name = "${plan.safeProjectName}-backend"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
  "fastapi>=0.111",
  "uvicorn[standard]>=0.30",
  "pydantic>=2.7",
  "pydantic-settings>=2.3",
  "scalar-fastapi>=1.0",
  "sqlalchemy[asyncio]>=2.0",
  "asyncpg>=0.29",
  "psycopg[binary]>=3.2",
  "alembic>=1.13",
  "redis>=5.0",
  "azure-servicebus>=7.12",
  "azure-storage-blob>=12.20",
  "azure-communication-email>=1.0"
]

[project.optional-dependencies]
test = ["pytest>=8.2", "httpx>=0.27"]

[build-system]
requires = ["setuptools>=70"]
build-backend = "setuptools.build_meta"

[tool.setuptools]
packages = []

[tool.pytest.ini_options]
pythonpath = [".."]
testpaths = ["tests"]
`;
}

function renderPythonMain(plan: ProjectPlan): string {
  return `from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

try:
    from scalar_fastapi import get_scalar_api_reference
except ImportError:  # pragma: no cover - dependency is present in generated runtime
    get_scalar_api_reference = None

from backend.apis.routes import health
from backend.config.settings import get_settings


settings = get_settings()
app = FastAPI(title=settings.app_name, version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        origin.strip()
        for origin in settings.cors_allowed_origins.split(",")
        if origin.strip()
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(health.router)


@app.get("/scalar", include_in_schema=False)
def scalar_reference():
    if get_scalar_api_reference is None:
        return {"message": "Install scalar-fastapi to enable the Scalar developer portal."}
    return get_scalar_api_reference(openapi_url=app.openapi_url, title=f"{app.title} API")


@app.get("/api")
def api_root():
    return {"name": ${sourceString(plan.projectName)}, "stack": "python-fastapi"}
`;
}

function renderPythonHealthRoutes(): string {
  return `from fastapi import APIRouter

router = APIRouter(tags=["operations"])


@router.get("/health")
def health():
    return {"status": "ok"}


@router.get("/ready")
def ready():
    return {"status": "ready"}
`;
}

function renderPythonAuthDependency(): string {
  return `from dataclasses import dataclass


@dataclass(frozen=True)
class CurrentUser:
    subject: str = "local-developer"


async def get_current_user() -> CurrentUser:
    return CurrentUser()
`;
}

function renderPythonSettings(plan: ProjectPlan): string {
  return `from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_name: str = ${sourceString(plan.projectName)}
    app_env: str = "dev"
    api_stack: str = "python-fastapi"
    cloud_provider: str = "${plan.provider.id}"
    azure_region: str = "${plan.region.slug}"
    database_url: str
    redis_url: str
    messaging_transport: str = "redis-streams"
    blob_endpoint: str | None = None
    cors_allowed_origins: str = "http://localhost:5173"


@lru_cache
def get_settings() -> Settings:
    return Settings()
`;
}

function renderPythonLogging(): string {
  return `import logging


def configure_logging() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
`;
}

function renderPythonHealthTest(): string {
  return `from fastapi.testclient import TestClient

from backend.apis.main import app


def test_health():
    response = TestClient(app).get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_ready():
    response = TestClient(app).get("/ready")
    assert response.status_code == 200
    assert response.json()["status"] == "ready"


def test_cors_preflight_for_local_frontend():
    response = TestClient(app).options(
        "/api",
        headers={
            "Origin": "http://localhost:5173",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"
`;
}

function renderAlembicIni(): string {
  return `[alembic]
script_location = %(here)s/migrations
sqlalchemy.url =
`;
}

function renderAlembicEnv(): string {
  return `import os

from alembic import context
from sqlalchemy import create_engine

config = context.config
target_metadata = None


def run_migrations_online():
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is required to run migrations")
    database_url = database_url.replace("postgresql+asyncpg://", "postgresql+psycopg://", 1)
    database_url = database_url.replace("postgresql://", "postgresql+psycopg://", 1)
    connectable = create_engine(database_url)
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


run_migrations_online()
`;
}

function renderPythonMigration(): string {
  return `from alembic import op
import sqlalchemy as sa

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "app_records",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade():
    op.drop_table("app_records")
`;
}

function addNodeArtifacts(add: AddArtifact, plan: ProjectPlan): void {
  add('node-backend-package', 'backend', ['backend', 'package.json'], renderNodePackage(plan));
  add('node-backend-lock', 'backend', ['backend', 'package-lock.json'], renderNpmLock('node-backend', `${plan.safeProjectName}-backend`));
  add('node-backend-tsconfig', 'backend', ['backend', 'tsconfig.json'], renderNodeTsconfig());
  add('node-backend-drizzle-config', 'backend', ['backend', 'drizzle.config.ts'], renderNodeDrizzleConfig());
  add('node-backend-config', 'backend', ['backend', 'src', 'config.ts'], renderNodeConfig(plan));
  add('node-backend-app', 'backend', ['backend', 'src', 'app.ts'], renderNodeApp(plan));
  add('node-backend-server', 'backend', ['backend', 'src', 'server.ts'], renderNodeServer());
  add('node-backend-database', 'backend', ['backend', 'src', 'database.ts'], renderNodeDatabase());
  add('node-backend-schema', 'backend', ['backend', 'src', 'db', 'schema.ts'], renderNodeSchema());
  add('node-backend-test-health', 'backend-test', ['backend', 'test', 'health.test.ts'], renderNodeHealthTest());
  add('database-node-migration', 'database', ['database', 'migrations', '0000_initial.sql'], renderNodeMigration());
  add('database-node-migration-journal', 'database', ['database', 'migrations', 'meta', '_journal.json'], renderNodeMigrationJournal());
  add('database-node-migration-snapshot', 'database', ['database', 'migrations', 'meta', '0000_snapshot.json'], renderNodeMigrationSnapshot());
  add('database-schema', 'database', ['database', 'models', 'schema.sql'], renderStandardSchema(plan));
}

function renderNodePackage(plan: ProjectPlan): string {
  return renderNpmPackage('node-backend', `${plan.safeProjectName}-backend`);
}

function renderNodeTsconfig(): string {
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

function renderNodeDrizzleConfig(): string {
  const fallbackUrl = localPostgresUrl('localhost', 'postgres');
  return `import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: '../database/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? ${sourceString(fallbackUrl)}
  }
});
`;
}

function renderNodeConfig(plan: ProjectPlan): string {
  return `export interface AppConfig {
  appName: string;
  appEnv: string;
  port: number;
    cloudProvider: string;
    azureRegion: string;
    databaseUrl: string;
    redisUrl: string;
    messagingTransport: string;
    blobEndpoint?: string;
  }

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  const redisUrl = env.REDIS_URL;
  if (!databaseUrl || !redisUrl) {
    throw new Error('DATABASE_URL and REDIS_URL are required.');
  }
  return {
    appName: env.APP_NAME ?? ${sourceString(plan.projectName)},
    appEnv: env.APP_ENV ?? 'dev',
    port: Number.parseInt(env.PORT ?? '8000', 10),
    cloudProvider: env.CLOUD_PROVIDER ?? '${plan.provider.id}',
    azureRegion: env.AZURE_REGION ?? '${plan.region.slug}',
    databaseUrl,
    redisUrl,
    messagingTransport: env.MESSAGING_TRANSPORT ?? 'redis-streams',
    blobEndpoint: env.BLOB_ENDPOINT || undefined
  };
}
`;
}

function renderNodeApp(plan: ProjectPlan): string {
  const scalarPage = `<!doctype html><html><head><title>${escapeHtml(plan.projectName)} API</title></head><body><script id="api-reference" data-url="/openapi.json"></script><script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script></body></html>`;
  return `import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import Fastify from 'fastify';

const scalarPage = ${sourceString(scalarPage)};

export async function buildApp() {
  const app = Fastify({ logger: true });
  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  await app.register(cors, { origin: allowedOrigins });
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

function renderNodeServer(): string {
  return `import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await buildApp();

try {
  await app.listen({ host: '0.0.0.0', port: config.port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
`;
}

function renderNodeDatabase(): string {
  return `import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { loadConfig } from './config.js';

const pool = new Pool({ connectionString: loadConfig().databaseUrl });
export const database = drizzle(pool);
`;
}

function renderNodeSchema(): string {
  return `import { integer, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core';

export const appRecords = pgTable('app_records', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: varchar('name', { length: 255 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
});
`;
}

function renderNodeHealthTest(): string {
  return `import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';

describe('health endpoints', () => {
  it('reports healthy and ready', async () => {
    const app = await buildApp();
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

function renderNodeMigration(): string {
  return `CREATE TABLE app_records (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;
}

function renderNodeMigrationJournal(): string {
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

function renderNodeMigrationSnapshot(): string {
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

function addGoArtifacts(add: AddArtifact, plan: ProjectPlan): void {
  add('go-backend-module', 'backend', ['backend', 'go.mod'], renderGoModule(plan));
  add('go-backend-checksums', 'backend', ['backend', 'go.sum'], renderGoChecksums());
  add('go-backend-makefile', 'backend', ['backend', 'Makefile'], renderGoMakefile());
  add('go-backend-main', 'backend', ['backend', 'cmd', 'api', 'main.go'], renderGoMain(plan));
  add('go-backend-api', 'backend', ['backend', 'internal', 'api', 'api.go'], renderGoApi(plan));
  add('go-backend-config', 'backend', ['backend', 'internal', 'config', 'config.go'], renderGoConfig(plan));
  add('go-backend-database', 'backend', ['backend', 'internal', 'database', 'database.go'], renderGoDatabase());
  add('go-backend-test-health', 'backend-test', ['backend', 'internal', 'api', 'api_test.go'], renderGoHealthTest(plan));
  add('database-go-migration', 'database', ['database', 'migrations', '0001_initial.sql'], renderGoMigration());
  add('database-schema', 'database', ['database', 'models', 'schema.sql'], renderStandardSchema(plan));
}

function goModule(plan: ProjectPlan): string {
  return `example.com/${plan.packageName}/backend`;
}

function renderGoModule(plan: ProjectPlan): string {
  return `module ${goModule(plan)}

go 1.23

require (
	github.com/danielgtaylor/huma/v2 v2.27.0
	github.com/go-chi/chi/v5 v5.2.1
	github.com/jackc/pgx/v5 v5.7.2
)

require (
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	golang.org/x/crypto v0.31.0 // indirect
	golang.org/x/sync v0.10.0 // indirect
	golang.org/x/text v0.21.0 // indirect
)
`;
}

function renderGoChecksums(): string {
  return `github.com/danielgtaylor/huma/v2 v2.27.0 h1:yxgJ8GqYqKeXw/EnQ4ZNc2NBpmn49AlhxL2+ksSXjUI=
github.com/danielgtaylor/huma/v2 v2.27.0/go.mod h1:NbSFXRoOMh3BVmiLJQ9EbUpnPas7D9BeOxF/pZBAGa0=
github.com/davecgh/go-spew v1.1.0/go.mod h1:J7Y8YcW2NihsgmVo/mv3lAwl/skON4iLHjSsI+c5H38=
github.com/davecgh/go-spew v1.1.1 h1:vj9j/u1bqnvCEfJOwUhtlOARqs3+rkHYY13jYWTU97c=
github.com/davecgh/go-spew v1.1.1/go.mod h1:J7Y8YcW2NihsgmVo/mv3lAwl/skON4iLHjSsI+c5H38=
github.com/go-chi/chi/v5 v5.2.1 h1:KOIHODQj58PmL80G2Eak4WdvUzjSJSm0vG72crDCqb8=
github.com/go-chi/chi/v5 v5.2.1/go.mod h1:L2yAIGWB3H+phAw1NxKwWM+7eUH/lU8pOMm5hHcoops=
github.com/google/uuid v1.6.0 h1:NIvaJDMOsjHA8n1jAhLSgzrAzy1Hgr+hNrb57e+94F0=
github.com/google/uuid v1.6.0/go.mod h1:TIyPZe4MgqvfeYDBFedMoGGpEw/LqOeaOT+nhxU+yHo=
github.com/jackc/pgpassfile v1.0.0 h1:/6Hmqy13Ss2zCq62VdNG8tM1wchn8zjSGOBJ6icpsIM=
github.com/jackc/pgpassfile v1.0.0/go.mod h1:CEx0iS5ambNFdcRtxPj5JhEz+xB6uRky5eyVu/W2HEg=
github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 h1:iCEnooe7UlwOQYpKFhBabPMi4aNAfoODPEFNiAnClxo=
github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761/go.mod h1:5TJZWKEWniPve33vlWYSoGYefn3gLQRzjfDlhSJ9ZKM=
github.com/jackc/pgx/v5 v5.7.2 h1:mLoDLV6sonKlvjIEsV56SkWNCnuNv531l94GaIzO+XI=
github.com/jackc/pgx/v5 v5.7.2/go.mod h1:ncY89UGWxg82EykZUwSpUKEfccBGGYq1xjrOpsbsfGQ=
github.com/jackc/puddle/v2 v2.2.2 h1:PR8nw+E/1w0GLuRFSmiioY6UooMp6KJv0/61nB7icHo=
github.com/jackc/puddle/v2 v2.2.2/go.mod h1:vriiEXHvEE654aYKXXjOvZM39qJ0q+azkZFrfEOc3H4=
github.com/pmezard/go-difflib v1.0.0 h1:4DBwDE0NGyQoBHbLQYPwSUPoCMWR5BEzIk/f1lZbAQM=
github.com/pmezard/go-difflib v1.0.0/go.mod h1:iKH77koFhYxTK1pcRnkKkqfTogsbg7gZNVY4sRDYZ/4=
github.com/stretchr/objx v0.1.0/go.mod h1:HFkY916IF+rwdDfMAkV7OtwuqBVzrE8GR6GFx+wExME=
github.com/stretchr/testify v1.3.0/go.mod h1:M5WIy9Dh21IEIfnGCwXGc5bZfKNJtfHm1UVUgZn+9EI=
github.com/stretchr/testify v1.7.0/go.mod h1:6Fq8oRcR53rry900zMqJjRRixrwX3KX962/h/Wwjteg=
github.com/stretchr/testify v1.9.0 h1:HtqpIVDClZ4nwg75+f6Lvsy/wHu+3BoSGCbBAcpTsTg=
github.com/stretchr/testify v1.9.0/go.mod h1:r2ic/lqez/lEtzL7wO/rwa5dbSLXVDPFyf8C91i36aY=
golang.org/x/crypto v0.31.0 h1:ihbySMvVjLAeSH1IbfcRTkD/iNscyz8rGzjF/E5hV6U=
golang.org/x/crypto v0.31.0/go.mod h1:kDsLvtWBEx7MV9tJOj9bnXsPbxwJQ6csT/x4KIN4Ssk=
golang.org/x/sync v0.10.0 h1:3NQrjDixjgGwUOCaF8w2+VYHv0Ve/vGYSbdkTa98gmQ=
golang.org/x/sync v0.10.0/go.mod h1:Czt+wKu1gCyEFDUtn0jG5QVvpJ6rzVqr5aXyt9drQfk=
golang.org/x/text v0.21.0 h1:zyQAAkrwaneQ066sspRyJaG9VNi/YJ1NfzcGB3hZ/qo=
golang.org/x/text v0.21.0/go.mod h1:4IBbMaMmOPCJ8SecivzSH54+73PCFmPWxNTLm+vZkEQ=
gopkg.in/check.v1 v0.0.0-20161208181325-20d25e280405/go.mod h1:Co6ibVJAznAaIkqp8huTwlJQCZ016jof/cbN4VW5Yz0=
gopkg.in/yaml.v3 v3.0.0-20200313102051-9f266ea9e77c/go.mod h1:K4uyk7z7BCEPqu6E+C64Yfv1cQ7kz7rIZviUmN+EgEM=
gopkg.in/yaml.v3 v3.0.1 h1:fxVm/GzAzEWqLHuvctI91KS9hhNmmWOoWu0XTYJS7CA=
gopkg.in/yaml.v3 v3.0.1/go.mod h1:K4uyk7z7BCEPqu6E+C64Yfv1cQ7kz7rIZviUmN+EgEM=
`;
}

function renderGoMakefile(): string {
  return `GOOSE_VERSION := v3.24.1

.PHONY: test migrate

test:
	go test ./...

migrate:
	go run github.com/pressly/goose/v3/cmd/goose@$(GOOSE_VERSION) -dir ../database/migrations postgres "$(DATABASE_URL)" up
`;
}

function renderGoMain(plan: ProjectPlan): string {
  return `package main

import (
	"log"
	"net/http"

	"${goModule(plan)}/internal/api"
	"${goModule(plan)}/internal/config"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("%s listening on :%s", cfg.AppName, cfg.Port)
	log.Fatal(http.ListenAndServe(":"+cfg.Port, api.New(cfg.AppName)))
}
`;
}

function renderGoApi(plan: ProjectPlan): string {
  return `package api

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humachi"
	"github.com/go-chi/chi/v5"
)

type statusOutput struct {
	Body struct {
		Status string \`json:"status"\`
	}
}

func New(name string) http.Handler {
	router := chi.NewRouter()
	router.Use(corsMiddleware(configuredOrigins()))
	config := huma.DefaultConfig(name+" API", "0.1.0")
	config.OpenAPIPath = "/openapi"
	config.DocsPath = ""
	api := humachi.New(router, config)

	huma.Get(api, "/health", func(context.Context, *struct{}) (*statusOutput, error) {
		output := &statusOutput{}
		output.Body.Status = "ok"
		return output, nil
	})
	huma.Get(api, "/ready", func(context.Context, *struct{}) (*statusOutput, error) {
		output := &statusOutput{}
		output.Body.Status = "ready"
		return output, nil
	})

	router.Get("/api", func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		fmt.Fprint(response, ${sourceString(JSON.stringify({ name: plan.projectName, stack: 'go-huma' }))})
	})
	router.Get("/scalar", scalarReference)
	return router
}

func configuredOrigins() map[string]struct{} {
	value := os.Getenv("CORS_ALLOWED_ORIGINS")
	if value == "" {
		value = "http://localhost:5173"
	}
	origins := make(map[string]struct{})
	for _, origin := range strings.Split(value, ",") {
		if origin = strings.TrimSpace(origin); origin != "" {
			origins[origin] = struct{}{}
		}
	}
	return origins
}

func corsMiddleware(allowedOrigins map[string]struct{}) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			origin := request.Header.Get("Origin")
			_, allowed := allowedOrigins[origin]
			if allowed {
				response.Header().Set("Access-Control-Allow-Origin", origin)
				response.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
				response.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
				response.Header().Add("Vary", "Origin")
			}
			if request.Method == http.MethodOptions {
				if origin != "" && !allowed {
					http.Error(response, "origin is not allowed", http.StatusForbidden)
					return
				}
				response.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(response, request)
		})
	}
}

func scalarReference(response http.ResponseWriter, _ *http.Request) {
	response.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprint(response, \`<!doctype html><html><head><title>API Reference</title></head><body><script id="api-reference" data-url="/openapi.json"></script><script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script></body></html>\`)
}
`;
}

function renderGoConfig(plan: ProjectPlan): string {
  return `package config

import (
	"fmt"
	"os"
)

type Config struct {
	AppName            string
	AppEnv             string
	Port               string
	CloudProvider      string
	AzureRegion        string
	DatabaseURL        string
	RedisURL           string
	MessagingTransport string
	BlobEndpoint       string
}

func Load() (Config, error) {
	databaseURL := os.Getenv("DATABASE_URL")
	redisURL := os.Getenv("REDIS_URL")
	if databaseURL == "" || redisURL == "" {
		return Config{}, fmt.Errorf("DATABASE_URL and REDIS_URL are required")
	}
	return Config{
		AppName:            value("APP_NAME", ${sourceString(plan.projectName)}),
		AppEnv:             value("APP_ENV", "dev"),
		Port:               value("PORT", "8000"),
		CloudProvider:      value("CLOUD_PROVIDER", "${plan.provider.id}"),
		AzureRegion:        value("AZURE_REGION", "${plan.region.slug}"),
		DatabaseURL:        databaseURL,
		RedisURL:           redisURL,
		MessagingTransport: value("MESSAGING_TRANSPORT", "redis-streams"),
		BlobEndpoint:       os.Getenv("BLOB_ENDPOINT"),
	}, nil
}

func value(name, fallback string) string {
	if current := os.Getenv(name); current != "" {
		return current
	}
	return fallback
}
`;
}

function renderGoDatabase(): string {
  return `package database

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

func Open(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	return pgxpool.New(ctx, databaseURL)
}
`;
}

function renderGoHealthTest(plan: ProjectPlan): string {
  return `package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealthAndReady(t *testing.T) {
	handler := New(${sourceString(plan.projectName)})
	for _, path := range []string{"/health", "/ready"} {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("%s returned %d", path, response.Code)
		}
	}
}

func TestCorsPreflightForLocalFrontend(t *testing.T) {
	handler := New(${sourceString(plan.projectName)})
	request := httptest.NewRequest(http.MethodOptions, "/api", nil)
	request.Header.Set("Origin", "http://localhost:5173")
	request.Header.Set("Access-Control-Request-Method", http.MethodGet)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("preflight returned %d", response.Code)
	}
	if origin := response.Header().Get("Access-Control-Allow-Origin"); origin != "http://localhost:5173" {
		t.Fatalf("unexpected allow origin %q", origin)
	}
}
`;
}

function renderGoMigration(): string {
  return `-- +goose Up
CREATE TABLE app_records (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE app_records;
`;
}

function renderStandardSchema(plan: ProjectPlan): string {
  return `-- ${plan.safeProjectName} standard application schema
CREATE TABLE IF NOT EXISTS app_records (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;
}
