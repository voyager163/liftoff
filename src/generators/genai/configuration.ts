import { DEFAULT_FUNCTION_WORKER_QUEUE_NAME } from '../common/values.js';
import { genAiPattern } from '../common/values.js';
import type { GenAiProjectPlan } from '../../domain/project/contracts.js';

export function renderBackendEnv(plan: GenAiProjectPlan, environment: string): string {
  const pattern = genAiPattern(plan);
  const transport = environment === 'dev' ? 'redis-streams' : 'azure-service-bus';
  return `APP_ENV=${environment}
APP_NAME=${plan.safeProjectName}
GENAI_PATTERN=${pattern.id}
CLOUD_PROVIDER=${plan.provider.id}
AZURE_REGION=${plan.region.slug}
DATABASE_URL=postgresql+asyncpg://postgres:postgres@postgres:5432/${plan.safeProjectName.replace(/-/g, '_')}
REDIS_URL=redis://redis:6379/0
REDIS_STREAM_NAME=liftoff-events
MESSAGING_TRANSPORT=${transport}
SERVICE_BUS_QUEUE_NAME=${DEFAULT_FUNCTION_WORKER_QUEUE_NAME}
SERVICE_BUS_AUTH_MODE=managed-identity
SERVICE_BUS_CONNECTION_STRING=
SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE=
AZURE_CLIENT_ID=
BLOB_ENDPOINT=
CORS_ALLOWED_ORIGINS=http://localhost:5173
PYDANTIC_AI_MODEL=
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
LANGFUSE_HOST=${environment === 'dev' ? 'http://langfuse:3000' : ''}
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
`;
}

export function renderFunctionsEnv(plan: GenAiProjectPlan, environment: string): string {
  const pattern = genAiPattern(plan);
  return `APP_ENV=${environment}
APP_NAME=${plan.safeProjectName}
GENAI_PATTERN=${pattern.id}
FUNCTIONS_WORKER_RUNTIME=python
SERVICEBUS_QUEUE_NAME=${DEFAULT_FUNCTION_WORKER_QUEUE_NAME}
ServiceBusConnection__fullyQualifiedNamespace=<service-bus-namespace>.servicebus.windows.net
ServiceBusConnection__clientId=<managed-identity-client-id>
AzureWebJobsStorage=<storage-connection-string>
SHARED_ORCHESTRATION_ROOT=../../backend
`;
}
