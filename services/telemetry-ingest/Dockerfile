FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS build

WORKDIR /workspace

ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org
COPY package.json package.json
COPY services/telemetry-ingest/package.json services/telemetry-ingest/package-lock.json services/telemetry-ingest/
RUN npm ci --prefix services/telemetry-ingest --ignore-scripts --no-audit --no-fund --registry="$NPM_CONFIG_REGISTRY"

COPY services/telemetry-ingest/tsconfig.json services/telemetry-ingest/tsconfig.json
COPY services/telemetry-ingest/scripts services/telemetry-ingest/scripts
COPY services/telemetry-ingest/src services/telemetry-ingest/src
COPY src/telemetry/contract.ts src/telemetry/contract.ts
RUN npm run package --prefix services/telemetry-ingest

FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /workspace/services/telemetry-ingest/build/package/ ./

USER node
EXPOSE 8080
STOPSIGNAL SIGTERM

CMD ["node", "dist/services/telemetry-ingest/src/index.js"]
