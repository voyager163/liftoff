# syntax=docker/dockerfile:1
# Build the static files with Node.js, then serve them with nginx running as
# an unprivileged user. nginx also forwards /api/ to the API, so the browser
# talks to a single origin.
# Base images are pinned by digest; update them deliberately.

FROM node:26.12.1-trixie-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec AS build
WORKDIR /srv/app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.30.6-alpine3.24@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03 AS runtime
# The base image's Alpine packages can lag their security fixes, so the build
# takes them; curl goes, since the health check uses BusyBox wget. Then back
# to the image's unprivileged user.
USER root
RUN apk upgrade --no-cache && apk del --no-cache curl
USER 101
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /srv/app/dist /usr/share/nginx/html
# Where nginx forwards /api/: the api service in Docker Compose. nginx looks
# its address up through the container's DNS servers, which the image's
# entrypoint provides when NGINX_ENTRYPOINT_LOCAL_RESOLVERS is set.
ENV API_UPSTREAM=http://api:8000 \
    NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD ["wget", "--quiet", "--spider", "http://127.0.0.1:8080/healthz"]
