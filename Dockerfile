# Playwright image = Ubuntu 24.04 + Node + Chromium with all system deps (amd64 & arm64).
# Keep the tag in sync with the "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      wireguard-tools openvpn iptables iproute2 iputils-ping \
      xvfb dumb-init curl ca-certificates \
      fonts-noto-cjk fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY test ./test
RUN chmod +x scripts/*.sh

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    HEADLESS=false \
    DISPLAY=:99

VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["dumb-init", "--", "/app/scripts/entrypoint.sh"]
