import { localPostgresUrl } from '../common/values.js';
import type { StandardApiProjectPlan } from '../../domain/project/contracts.js';

export function renderStandardEnv(plan: StandardApiProjectPlan, environment = 'dev'): string {
  const local = environment === 'dev';
  const databaseUrl = localPostgresUrl('localhost', plan.safeProjectName.replace(/-/g, '_'));
  return `APP_ENV=${environment}
APP_NAME=${plan.safeProjectName}
API_STACK=${plan.apiStack.id}
CLOUD_PROVIDER=${plan.provider.id}
AZURE_REGION=${plan.region.slug}
DATABASE_URL=${databaseUrl}
REDIS_URL=redis://localhost:6379/0
MESSAGING_TRANSPORT=${local ? 'redis-streams' : 'azure-service-bus'}
BLOB_ENDPOINT=${local ? 'http://localhost:10000/devstoreaccount1' : ''}
CORS_ALLOWED_ORIGINS=http://localhost:5173
`;
}

export function renderStandardSchema(plan: StandardApiProjectPlan): string {
  return `-- ${plan.safeProjectName} standard application schema
CREATE TABLE IF NOT EXISTS app_records (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;
}
