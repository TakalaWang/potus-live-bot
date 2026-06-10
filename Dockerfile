# syntax=docker/dockerfile:1
# Note: onnxruntime-node ships glibc prebuilds only — Alpine (musl) is not supported
FROM node:22-bookworm-slim AS builder
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY worker/package.json worker/
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm exec tsc

FROM node:22-bookworm-slim
ARG TARGETARCH
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates unzip \
  && rm -rf /var/lib/apt/lists/*

# yt-dlp standalone binary (no Python dependency, self-updates via yt-dlp -U)
RUN BIN=yt-dlp_linux; [ "$TARGETARCH" = "arm64" ] && BIN=yt-dlp_linux_aarch64; \
  curl -fL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$BIN" -o /usr/local/bin/yt-dlp \
  && chmod +x /usr/local/bin/yt-dlp

# deno: required by yt-dlp to solve YouTube JS challenges (extraction degrades or fails without it)
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY worker/package.json worker/
RUN pnpm install --frozen-lockfile --prod && pnpm store prune
COPY --from=builder /app/dist ./dist
COPY scripts/download-model.sh scripts/
RUN bash scripts/download-model.sh

ENV NODE_ENV=production
ENV DATA_DIR=/data
VOLUME /data

CMD ["node", "dist/index.js"]
