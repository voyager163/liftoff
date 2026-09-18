import type { GeneratorContext as ResolvedGeneratorContext } from '../context.js';
type GeneratorContext = { python: Pick<ResolvedGeneratorContext['python'], 'standard'> };
import type { AddArtifact } from '../../template-types.js';


import { renderStandardSchema } from './configuration.js';
import { sourceString } from '../common/values.js';
import { renderPythonRuntimeSettings } from '../common/python-settings.js';
import type { StandardApiProjectPlan } from '../../domain/project/contracts.js';

export function addPythonArtifacts(add: AddArtifact, plan: StandardApiProjectPlan, context: GeneratorContext): void {
  add('backend-pyproject', 'backend', ['backend', 'pyproject.toml'], renderPythonPyproject(plan, context));
  add('backend-uv-lock', 'backend', ['backend', 'uv.lock'], context.python["standard"].lock);
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

export function renderPythonPyproject(plan: StandardApiProjectPlan, context: GeneratorContext): string {
  return context.python["standard"].project;
}

export function renderPythonMain(plan: StandardApiProjectPlan): string {
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

export function renderPythonHealthRoutes(): string {
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

export function renderPythonAuthDependency(): string {
  return `from dataclasses import dataclass


@dataclass(frozen=True)
class CurrentUser:
    subject: str = "local-developer"


async def get_current_user() -> CurrentUser:
    return CurrentUser()
`;
}

export function renderPythonSettings(plan: StandardApiProjectPlan): string {
  return renderPythonRuntimeSettings(plan);
}

export function renderPythonLogging(): string {
  return `import logging


def configure_logging() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
`;
}

export function renderPythonHealthTest(): string {
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

export function renderAlembicIni(): string {
  return `[alembic]
script_location = %(here)s/migrations
sqlalchemy.url =
`;
}

export function renderAlembicEnv(): string {
  return `from alembic import context
from sqlalchemy import create_engine

from backend.config.settings import get_settings

config = context.config
target_metadata = None


def run_migrations_online():
    database_url = get_settings().database_url
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

export function renderPythonMigration(): string {
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
