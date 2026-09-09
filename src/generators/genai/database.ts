import type { AddArtifact } from '../../template-types.js';
import { genAiPattern } from '../common/values.js';
import type { GenAiProjectPlan } from '../../domain/project/contracts.js';

export function addDatabaseArtifacts(add: AddArtifact, plan: GenAiProjectPlan): void {
  add('database-alembic-ini', 'database', ['database', 'alembic.ini'], renderAlembicIni());
  add('database-alembic-env', 'database', ['database', 'migrations', 'env.py'], renderAlembicEnv());
  add('database-initial-migration', 'database', ['database', 'migrations', 'versions', '0001_initial.py'], renderInitialMigration(plan));
  add('database-schema', 'database', ['database', 'models', 'schema.sql'], renderDatabaseSchema(plan));
}

export function renderAlembicIni(): string {
  return `[alembic]
script_location = %(here)s/migrations
sqlalchemy.url = driver://user:pass@localhost/dbname
`;
}

export function renderAlembicEnv(): string {
  return `from alembic import context
from sqlalchemy import create_engine

from backend.config.settings import get_settings


def run_migrations_online():
    database_url = get_settings().database_url
    if not database_url:
        raise RuntimeError("DATABASE_URL is required to run migrations")
    database_url = database_url.replace("postgresql+asyncpg://", "postgresql+psycopg://", 1)
    database_url = database_url.replace("postgresql://", "postgresql+psycopg://", 1)
    connectable = create_engine(database_url)
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=None)
        with context.begin_transaction():
            context.run_migrations()


run_migrations_online()
`;
}

export function renderInitialMigration(plan: GenAiProjectPlan): string {
  const vectorExtension = genAiPattern(plan).id === 'rag' ? '    op.execute("CREATE EXTENSION IF NOT EXISTS vector")\n' : '';
  return `from alembic import op
import sqlalchemy as sa

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
${vectorExtension}    op.create_table(
        "events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("event_type", sa.String(length=120), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    )


def downgrade():
    op.drop_table("events")
`;
}

export function renderDatabaseSchema(plan: GenAiProjectPlan): string {
  return `CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(120) NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
${genAiPattern(plan).id === 'rag' ? '\nCREATE EXTENSION IF NOT EXISTS vector;\n' : ''}`;
}
