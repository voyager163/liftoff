# syntax=docker/dockerfile:1
# Install the locked production dependencies, then copy them and the code into
# a slim runtime image that runs as an unprivileged user. Node.js runs the
# TypeScript directly, so there is no build step.
# Base images are pinned by digest; update them deliberately.

FROM node:26.12.1-trixie-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec AS dependencies
WORKDIR /srv/app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:26.12.1-trixie-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec AS runtime
# npm installs packages, which the running image never does; without it the
# image carries none of the packages npm bundles, so their advisories do not
# fail the build's scan.
RUN useradd --system --uid 10001 --no-create-home app \
  && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /srv/app
COPY --from=dependencies /srv/app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY drizzle ./drizzle
ENV NODE_ENV=production \
    APP_HOST=0.0.0.0 \
    APP_PORT=8000
USER 10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8000/health/live', { signal: AbortSignal.timeout(2000) }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/server.ts"]
