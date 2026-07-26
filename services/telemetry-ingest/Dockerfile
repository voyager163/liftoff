FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3 AS build

WORKDIR /workspace

COPY package.json package.json
COPY services/telemetry-ingest/package.json services/telemetry-ingest/package-lock.json services/telemetry-ingest/
RUN npm ci --prefix services/telemetry-ingest --ignore-scripts --no-audit --no-fund

COPY services/telemetry-ingest/tsconfig.json services/telemetry-ingest/tsconfig.json
COPY services/telemetry-ingest/scripts services/telemetry-ingest/scripts
COPY services/telemetry-ingest/src services/telemetry-ingest/src
COPY src/telemetry/contract.ts src/telemetry/contract.ts
RUN npm run package --prefix services/telemetry-ingest

FROM node:22-bookworm-slim@sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /workspace/services/telemetry-ingest/build/package/ ./

USER node
EXPOSE 8080
STOPSIGNAL SIGTERM

CMD ["node", "dist/services/telemetry-ingest/src/index.js"]
