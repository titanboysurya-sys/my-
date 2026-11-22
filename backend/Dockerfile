# Production Docker image for Render Web Service, Background Worker, and Scheduler
# Includes FFmpeg, FFprobe, and DejaVu fonts for subtitle burn-in and thumbnail compositing.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    fonts-dejavu-core \
    fonts-noto-core \
    ca-certificates \
    curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev=false

COPY tsconfig.json ./
COPY src ./src

RUN npm run build && npm prune --omit=dev

# Run as non-root user for worker isolation
RUN useradd --create-home --shell /bin/bash worker \
  && mkdir -p /tmp/autotube-worker \
  && chown -R worker:worker /app /tmp/autotube-worker

USER worker

ENV NODE_ENV=production
ENV PORT=8080
ENV TEMP_WORK_DIR=/tmp/autotube-worker
ENV NODE_OPTIONS="--max-old-space-size=220"

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:8080/health || exit 1

CMD ["node", "dist/server.js"]
