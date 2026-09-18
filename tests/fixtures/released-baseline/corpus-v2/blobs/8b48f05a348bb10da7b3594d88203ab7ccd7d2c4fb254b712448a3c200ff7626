import type { GeneratorContext as ResolvedGeneratorContext } from '../context.js';
import type { AddArtifact } from '../../template-types.js';
import type { ApiProjectPlan } from '../../domain/project/contracts.js';
import { formatContainerImage } from '../../domain/project/supported-stack.js';
type GeneratorContext = Pick<ResolvedGeneratorContext, 'stack'>;


export function addDockerArtifacts(add: AddArtifact, plan: ApiProjectPlan, context: GeneratorContext): void {
  add('docker-compose', 'local-development', ['docker-compose.yml'], renderDockerCompose(plan, context));
}

export function renderDockerCompose(plan: ApiProjectPlan, context: GeneratorContext): string {
  const frontendService = plan.includeFrontend ? `
  frontend:
    build:
      context: ./frontend
    ports:
      - "5173:80"
    depends_on:
      - backend
` : '';
  const postgresImage = plan.workload === 'genai' && plan.pattern.requiresVectorStore
    ? formatContainerImage(context.stack.containers.pgvector)
    : formatContainerImage(context.stack.containers.postgres);
  return `services:
  backend:
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      APP_ENV: \${APP_ENV-dev}
      APP_NAME: \${APP_NAME-${plan.safeProjectName}}
      CLOUD_PROVIDER: ${plan.provider.id}
      AZURE_REGION: \${AZURE_REGION-${plan.region.slug}}
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/${plan.safeProjectName.replace(/-/g, '_')}
      REDIS_URL: redis://redis:6379/0
      MESSAGING_TRANSPORT: \${MESSAGING_TRANSPORT-redis-streams}
      BLOB_ENDPOINT: http://azurite:10000/devstoreaccount1
      CORS_ALLOWED_ORIGINS: \${CORS_ALLOWED_ORIGINS-http://localhost:5173}
${plan.workload === 'genai' ? `      GENAI_PATTERN: ${plan.pattern.id}
      REDIS_STREAM_NAME: \${REDIS_STREAM_NAME-liftoff-events}
      SERVICE_BUS_QUEUE_NAME: \${SERVICE_BUS_QUEUE_NAME-events}
      SERVICE_BUS_AUTH_MODE: \${SERVICE_BUS_AUTH_MODE-managed-identity}
      SERVICE_BUS_CONNECTION_STRING: \${SERVICE_BUS_CONNECTION_STRING:-}
      SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE: \${SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE:-}
      AZURE_CLIENT_ID: \${AZURE_CLIENT_ID:-}
      PYDANTIC_AI_MODEL: \${PYDANTIC_AI_MODEL:-}
      OPENAI_API_KEY: \${OPENAI_API_KEY:-}
      OPENAI_BASE_URL: \${OPENAI_BASE_URL-https://api.openai.com/v1}
      LANGFUSE_HOST: \${LANGFUSE_HOST-http://langfuse:3000}
      LANGFUSE_PUBLIC_KEY: \${LANGFUSE_PUBLIC_KEY:-}
      LANGFUSE_SECRET_KEY: \${LANGFUSE_SECRET_KEY:-}
` : `      API_STACK: ${plan.apiStack.id}
`}
    ports:
      - "8000:8000"
    depends_on:
      - postgres
      - redis
      - azurite
      - mailpit
${frontendService}
  postgres:
    image: ${postgresImage}
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: ${plan.safeProjectName.replace(/-/g, '_')}
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 3s
      timeout: 3s
      retries: 10

  redis:
    image: ${formatContainerImage(context.stack.containers.redis)}
    ports:
      - "6379:6379"

  azurite:
    image: ${formatContainerImage(context.stack.containers.azurite)}
    command: azurite --blobHost 0.0.0.0
    ports:
      - "10000:10000"

  mailpit:
    image: ${formatContainerImage(context.stack.containers.mailpit)}
    ports:
      - "8025:8025"

${plan.workload === 'genai' ? `  langfuse-worker:
    image: ${formatContainerImage(context.stack.containers['langfuse-worker'])}
    profiles:
      - observability
    depends_on: &langfuse-dependencies
      postgres:
        condition: service_healthy
      langfuse-redis:
        condition: service_healthy
      clickhouse:
        condition: service_healthy
      minio:
        condition: service_healthy
    environment: &langfuse-environment
      DATABASE_URL: postgresql://postgres:postgres@postgres:5432/${plan.safeProjectName.replace(/-/g, '_')}
      NEXTAUTH_URL: http://localhost:3000
      SALT: local-development-salt
      ENCRYPTION_KEY: 0000000000000000000000000000000000000000000000000000000000000000
      TELEMETRY_ENABLED: "false"
      CLICKHOUSE_MIGRATION_URL: clickhouse://clickhouse:9000
      CLICKHOUSE_URL: http://clickhouse:8123
      CLICKHOUSE_USER: clickhouse
      CLICKHOUSE_PASSWORD: clickhouse
      REDIS_HOST: langfuse-redis
      REDIS_PORT: 6379
      REDIS_AUTH: langfuse-redis
      LANGFUSE_S3_EVENT_UPLOAD_BUCKET: langfuse
      LANGFUSE_S3_EVENT_UPLOAD_REGION: auto
      LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID: minio
      LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY: miniosecret
      LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT: http://minio:9000
      LANGFUSE_S3_EVENT_UPLOAD_FORCE_PATH_STYLE: "true"
      LANGFUSE_S3_MEDIA_UPLOAD_BUCKET: langfuse
      LANGFUSE_S3_MEDIA_UPLOAD_REGION: auto
      LANGFUSE_S3_MEDIA_UPLOAD_ACCESS_KEY_ID: minio
      LANGFUSE_S3_MEDIA_UPLOAD_SECRET_ACCESS_KEY: miniosecret
      LANGFUSE_S3_MEDIA_UPLOAD_ENDPOINT: http://minio:9000
      LANGFUSE_S3_MEDIA_UPLOAD_FORCE_PATH_STYLE: "true"

  langfuse:
    image: ${formatContainerImage(context.stack.containers['langfuse-web'])}
    profiles:
      - observability
    depends_on: *langfuse-dependencies
    environment:
      <<: *langfuse-environment
      NEXTAUTH_SECRET: local-development-secret
      LANGFUSE_S3_MEDIA_UPLOAD_ENDPOINT: http://localhost:9090
    ports:
      - "3000:3000"

  clickhouse:
    image: ${formatContainerImage(context.stack.containers.clickhouse)}
    profiles:
      - observability
    user: "101:101"
    environment:
      CLICKHOUSE_DB: default
      CLICKHOUSE_USER: clickhouse
      CLICKHOUSE_PASSWORD: clickhouse
    volumes:
      - langfuse-clickhouse-data:/var/lib/clickhouse
      - langfuse-clickhouse-logs:/var/log/clickhouse-server
    healthcheck:
      test: ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:8123/ping || exit 1"]
      interval: 5s
      timeout: 5s
      retries: 10

  minio:
    image: ${formatContainerImage(context.stack.containers.minio)}
    profiles:
      - observability
    entrypoint: sh
    command: -c 'mkdir -p /data/langfuse && minio server --address ":9000" --console-address ":9001" /data'
    environment:
      MINIO_ROOT_USER: minio
      MINIO_ROOT_PASSWORD: miniosecret
    ports:
      - "9090:9000"
      - "127.0.0.1:9091:9001"
    volumes:
      - langfuse-minio-data:/data
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]
      interval: 1s
      timeout: 5s
      retries: 5

  langfuse-redis:
    image: ${formatContainerImage(context.stack.containers.redis)}
    profiles:
      - observability
    command: ["redis-server", "--requirepass", "langfuse-redis", "--maxmemory-policy", "noeviction"]
    volumes:
      - langfuse-redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "-a", "langfuse-redis", "ping"]
      interval: 3s
      timeout: 10s
      retries: 10
` : ''}
${plan.workload === 'genai' ? `volumes:
  langfuse-clickhouse-data:
  langfuse-clickhouse-logs:
  langfuse-minio-data:
  langfuse-redis-data:
` : ''}
`;
}
