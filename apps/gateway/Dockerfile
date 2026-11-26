# AiDB Bridge — standalone gateway (headless server / Linux deployment)
FROM node:24-bookworm-slim AS native-build-base
WORKDIR /repo
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

FROM native-build-base AS build
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/client/package.json packages/client/package.json
COPY packages/aidb-mcp/package.json packages/aidb-mcp/package.json
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/mobile/package.json apps/mobile/package.json
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspace apps/gateway --include-workspace-root --no-audit --no-fund
COPY packages/core packages/core
COPY apps/gateway apps/gateway
RUN npm --workspace apps/gateway run build

FROM native-build-base AS production-dependencies
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/client/package.json packages/client/package.json
COPY packages/aidb-mcp/package.json packages/aidb-mcp/package.json
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/mobile/package.json apps/mobile/package.json
# Keep install scripts: Oracle and optional native dependencies prepare their binaries here.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspace apps/gateway --include-workspace-root --omit=dev --no-audit --no-fund
RUN mkdir -p apps/gateway/node_modules

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    AIDB_HOME=/data \
    AIDB_HOST=0.0.0.0 \
    AIDB_PORT=8787 \
    TZ=Asia/Shanghai \
    NPM_CONFIG_UPDATE_NOTIFIER=false
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -m 0700 -o node -g node /data

COPY --from=build --chown=node:node /repo/apps/gateway/dist ./dist
# The bundle externalizes ssh2 and @duckdb/node-bindings; copy the complete installed
# production tree so platform bindings, detect-libc, and transitive native modules ship.
COPY --from=production-dependencies --chown=node:node /repo/node_modules ./node_modules
COPY --from=production-dependencies --chown=node:node /repo/apps/gateway/node_modules ./apps/gateway/node_modules
COPY --from=production-dependencies --chown=node:node /repo/apps/gateway/package.json ./apps/gateway/package.json
# Keep workspace symlinks valid and include the client runtime package explicitly.
COPY --chown=node:node packages/core packages/core
COPY --chown=node:node packages/client packages/client

USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.AIDB_PORT || '8787') + '/api/health', { signal: AbortSignal.timeout(4000) }).then(async (response) => { if (!response.ok) process.exit(1); const body = await response.json(); if (body.ok !== true) process.exit(1); }).catch(() => process.exit(1));"]
# Node/OpenSSL compatibility: use the legacy provider only when this runtime accepts it.
CMD ["sh", "-c", "if node --openssl-legacy-provider --version >/dev/null 2>&1; then exec node --openssl-legacy-provider dist/index.js; else exec node dist/index.js; fi"]
