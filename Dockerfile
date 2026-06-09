# syntax=docker/dockerfile:1
# 注意：onnxruntime-node 只有 glibc 預編譯檔，不能用 Alpine（musl）
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

FROM node:22-bookworm-slim
ARG TARGETARCH
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates unzip \
  && rm -rf /var/lib/apt/lists/*

# yt-dlp standalone binary（不依賴 Python，可用 yt-dlp -U 自我更新）
RUN BIN=yt-dlp_linux; [ "$TARGETARCH" = "arm64" ] && BIN=yt-dlp_linux_aarch64; \
  curl -fL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$BIN" -o /usr/local/bin/yt-dlp \
  && chmod +x /usr/local/bin/yt-dlp

# deno：yt-dlp 解 YouTube JS challenge 必需（沒有它擷取會劣化或失敗）
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY scripts/download-model.sh scripts/
RUN bash scripts/download-model.sh

ENV NODE_ENV=production
ENV DATA_DIR=/data
VOLUME /data

CMD ["node", "dist/index.js"]
