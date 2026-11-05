# syntax=docker/dockerfile:1
# Build a static binary with the locked modules, then copy only the binary
# into a distroless image that runs it as an unprivileged user. The binary
# also applies the migrations (api migrate) and checks liveness for the
# HEALTHCHECK (api healthcheck), because the image has no shell.
# Base images are pinned by digest; update them deliberately.

FROM golang:1.27.3-trixie@sha256:fbb7ae40b62ff8afe31662df570d39b4f5052ac32b90dae8e60d7657a20a74f4 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api

FROM gcr.io/distroless/static-debian13@sha256:15f8637509792e05b97d83451b0b6ccfa4abd548f997e406ac1e72c87fe1fa78 AS runtime
COPY --from=build /out/api /api
ENV APP_HOST=0.0.0.0 \
    APP_PORT=8000
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD ["/api", "healthcheck"]
ENTRYPOINT ["/api"]
