import type { GeneratorContext as ResolvedGeneratorContext } from '../context.js';
type GeneratorContext = Pick<ResolvedGeneratorContext, 'stack'>;
import { formatContainerImage } from '../../domain/project/supported-stack.js';
import type { StandardApiProjectPlan } from '../../domain/project/contracts.js';


export function renderBackendDockerfile(context: GeneratorContext): string {
  return `FROM ${formatContainerImage(context.stack.containers['uv-tool'])} AS uv
FROM ${formatContainerImage(context.stack.containers['python-runtime'])}

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app
ENV PATH=/app/backend/.venv/bin:$PATH
COPY --from=uv /uv /uvx /bin/

ARG UV_DEFAULT_INDEX=https://pypi.org/simple
COPY backend/pyproject.toml /app/backend/pyproject.toml
COPY backend/uv.lock /app/backend/uv.lock
RUN --mount=type=cache,target=/root/.cache/uv \\
    uv export --frozen --no-dev --no-emit-project --project /app/backend --output-file /tmp/requirements.txt \\
    && uv venv /app/backend/.venv \\
    && uv pip install --python /app/backend/.venv/bin/python --require-hashes \\
      --default-index "$UV_DEFAULT_INDEX" --requirements /tmp/requirements.txt \\
    && rm /tmp/requirements.txt

COPY backend /app/backend
COPY database /app/database

EXPOSE 8000
CMD ["uvicorn", "backend.apis.main:app", "--host", "0.0.0.0", "--port", "8000"]
`;
}

export function renderFrontendDockerfile(context: GeneratorContext): string {
  return `FROM ${formatContainerImage(context.stack.containers['node-runtime'])} AS build
WORKDIR /app
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts --no-audit --no-fund --registry="$NPM_CONFIG_REGISTRY"
COPY . .
ARG VITE_API_BASE_URL=http://localhost:8000
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build

FROM ${formatContainerImage(context.stack.containers['nginx-runtime'])}
COPY --from=build /app/dist /usr/share/nginx/html
`;
}

export function renderStandardDockerfile(plan: StandardApiProjectPlan, context: GeneratorContext): string {
  switch (plan.apiStack.id) {
    case 'python-fastapi':
      return `FROM ${formatContainerImage(context.stack.containers['uv-tool'])} AS uv
FROM ${formatContainerImage(context.stack.containers['python-runtime'])}

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app
ENV PATH=/app/backend/.venv/bin:$PATH
COPY --from=uv /uv /uvx /bin/

ARG UV_DEFAULT_INDEX=https://pypi.org/simple
COPY backend/pyproject.toml /app/backend/pyproject.toml
COPY backend/uv.lock /app/backend/uv.lock
RUN --mount=type=cache,target=/root/.cache/uv \\
    uv export --frozen --no-dev --no-emit-project --project /app/backend --output-file /tmp/requirements.txt \\
    && uv venv /app/backend/.venv \\
    && uv pip install --python /app/backend/.venv/bin/python --require-hashes \\
      --default-index "$UV_DEFAULT_INDEX" --requirements /tmp/requirements.txt \\
    && rm /tmp/requirements.txt

COPY backend /app/backend
COPY database /app/database

EXPOSE 8000
CMD ["uvicorn", "backend.apis.main:app", "--host", "0.0.0.0", "--port", "8000"]
`;
    case 'node-fastify':
      return `FROM ${formatContainerImage(context.stack.containers['node-runtime'])} AS build

WORKDIR /app/backend
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org
COPY backend/package*.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund --registry="$NPM_CONFIG_REGISTRY"
COPY backend ./
RUN npm run build

FROM ${formatContainerImage(context.stack.containers['node-runtime'])} AS runtime
WORKDIR /app/backend
ENV NODE_ENV=production
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org
COPY backend/package*.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --registry="$NPM_CONFIG_REGISTRY"
COPY --from=build /app/backend/dist ./dist
COPY database /app/database

EXPOSE 8000
CMD ["node", "dist/server.js"]
`;
    case 'go-huma':
      return `FROM ${formatContainerImage(context.stack.containers['go-build'])} AS build

WORKDIR /src/backend
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/api ./cmd/api

FROM ${formatContainerImage(context.stack.containers['alpine-runtime'])}
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
